import { createH264StreamState, withConfiguration } from './harmony-media-codec.js';

const LIMIT = 1000000000;
const INTERNAL_FAILURE = Symbol('decoder failure');
const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'AbortError', 'DataError', 'EncodingError', 'InvalidStateError',
  'NotSupportedError', 'OperationError', 'QuotaExceededError', 'SecurityError', 'TimeoutError']);
const failure = (code, error) => Object.assign(new Error(code), { [INTERNAL_FAILURE]: true, code, errorName: ERROR_NAMES.has(error?.name) ? error.name : 'Error' });

export function createH264Decoder({ acknowledge, onFrame, onError, onDiagnostic = () => {},
  Decoder = globalThis.VideoDecoder, Chunk = globalThis.EncodedVideoChunk, timeoutMs = 1500 }) {
  const parser = createH264StreamState(), sequences = new Map(), waits = new Set(), pressureWaits = new Set();
  let decoder, generation = 0, disposed = false, failed = false, painted = false, software = false, startupDrained = false;
  let chain = Promise.resolve(), recovery = null, queued = 0, received = 0, submitted = 0, keyframes = 0, outputs = 0, summaryAt = 0;
  let status = { sps: false, pps: false, configuration: null }, stage = 'waiting-configuration';
  let configurationRevision = -1, keyReceived = false, firstTimestamp = null, lastTimestamp = -1, retainedKey = null, lastPacket = null;
  const diagnostic = () => ({ stage, received, submitted, keyframes, sps: status.sps, pps: status.pps, codec: status.configuration?.codec || '' });
  function emit(event, extra = {}) {
    if (disposed) return;
    const dimension = value => Number.isSafeInteger(value) && value >= 0 && value <= 16384 ? value : 0;
    try { onDiagnostic({ event, mode: software ? 'software' : 'hardware', codec: status.configuration?.codec || '',
      received, submitted, output: outputs, keyframes, width: dimension(lastPacket?.width), height: dimension(lastPacket?.height), ...extra }); }
    catch { /* Optional telemetry cannot change video playback. */ }
  }
  function ack(packet, decoded = false) {
    if (!disposed) acknowledge({ sessionId: packet.sessionId, sequence: packet.sequence, diagnostic: diagnostic(), ...(decoded ? { decoded: true } : {}) });
  }
  function bounded(promise, code) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (action, value) => { if (done) return; done = true; clearTimeout(timer); waits.delete(cancel); pressureWaits.delete(pressure); action(value); };
      const cancel = () => finish(resolve, undefined);
      const pressure = () => finish(reject, failure('QUEUE_LIMIT'));
      const timer = setTimeout(() => finish(reject, failure(code, { name: 'TimeoutError' })), timeoutMs);
      waits.add(cancel);
      // Observe the native promise before an already-full ingress queue can
      // cancel this wait, so a late native rejection is still consumed.
      Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
      if (!painted && !software) { pressureWaits.add(pressure); if (queued >= 6) pressure(); }
    });
  }
  function closeDecoder() {
    generation++;
    for (const cancel of waits) cancel();
    if (decoder && decoder.state !== 'closed') decoder.close();
    decoder = null; keyReceived = false; sequences.clear();
  }
  function terminal(packet, error = failure('DECODE_FAILED')) {
    if (disposed || failed) return;
    failed = true; stage = 'decoder-error';
    emit(error.code === 'QUEUE_LIMIT' ? 'queue-limit' : 'decode-error', { errorCode: error.code, errorName: error.errorName });
    emit('decode-summary'); closeDecoder(); retainedKey = null;
    if (packet) ack(packet);
    onError();
  }
  async function configure(frame) {
    closeDecoder();
    const current = generation;
    const options = { codec: frame.configuration.codec, optimizeForLatency: true,
      hardwareAcceleration: software ? 'prefer-software' : 'prefer-hardware', codedWidth: frame.packet.width, codedHeight: frame.packet.height };
    emit('configure');
    try {
      if (!Decoder || !Chunk) throw failure('CONFIG_UNSUPPORTED');
      const support = await bounded(Decoder.isConfigSupported(options), 'CONFIG_TIMEOUT');
      if (disposed || failed || current !== generation) return false;
      if (!support?.supported) throw failure('CONFIG_UNSUPPORTED');
      decoder = new Decoder({
        output(videoFrame) {
          try {
            if (disposed || failed || current !== generation) return;
            const item = sequences.get(videoFrame.timestamp); sequences.delete(videoFrame.timestamp);
            if (!item || item.replay) return;
            onFrame(videoFrame, item.packet);
            outputs = Math.min(LIMIT, outputs + 1);
            if (!painted) { painted = true; retainedKey = null; emit('first-frame'); ack(item.packet, true); }
          } catch (error) { terminal(lastPacket, failure('PAINT_FAILED', error)); }
          finally { videoFrame.close(); }
        },
        error(error) {
          if (disposed || failed || current !== generation) return;
          const reason = failure('DECODE_FAILED', error);
          if (painted || software) { terminal(lastPacket, reason); return; }
          void recover(reason).catch(problem => terminal(lastPacket, problem));
        }
      });
      decoder.configure(options); configurationRevision = frame.configuration.revision;
      emit('configured', { supported: true });
      return true;
    } catch (error) { throw error?.[INTERNAL_FAILURE] ? error : failure('CONFIG_FAILED', error); }
  }
  function submit(frame, replay = false) {
    if (disposed || failed) return;
    if (decoder.decodeQueueSize >= 8 || sequences.size >= 16) throw failure('QUEUE_LIMIT');
    sequences.set(frame.timestamp, { packet: frame.packet, replay });
    try { decoder.decode(new Chunk({ type: frame.key ? 'key' : 'delta', timestamp: frame.timestamp, data: frame.data })); }
    catch (error) { sequences.delete(frame.timestamp); throw failure('DECODE_FAILED', error); }
    submitted = Math.min(LIMIT, submitted + 1); stage = 'submitted'; keyReceived = true;
  }
  async function drainStartup(frame) {
    if (startupDrained || disposed || failed) return;
    startupDrained = true;
    const current = generation, target = decoder;
    try { await bounded(target.flush(), 'DRAIN_TIMEOUT'); }
    catch (error) {
      if (disposed || failed) return;
      if (current !== generation) { if (recovery) await recovery; return; }
      throw error?.[INTERNAL_FAILURE] ? error : failure('DRAIN_FAILED', error);
    }
    if (disposed || failed) return;
    if (current !== generation) { if (recovery) await recovery; return; }
    if (!painted) throw failure('NO_OUTPUT');
    // flush() releases reorder-buffered output, but requires another key chunk.
    // No later packet is submitted while this startup operation owns the chain.
    // Re-prime using this IDR and ignore only its duplicate output, never its close.
    submit(frame, true);
    emit('decode-summary');
  }
  function recover(error = failure('DECODE_FAILED')) {
    if (recovery) return recovery;
    if (disposed || failed) return Promise.resolve();
    if (painted || software || !retainedKey) return Promise.reject(error);
    emit(error.code === 'QUEUE_LIMIT' ? 'queue-limit' : 'decode-error', { errorCode: error.code, errorName: error.errorName,
      ...(error.code === 'CONFIG_UNSUPPORTED' ? { supported: false } : {}) });
    software = true; startupDrained = false;
    emit('fallback', { errorCode: error.code, errorName: error.errorName });
    const frame = retainedKey;
    recovery = (async () => { if (await configure(frame)) { submit(frame); await drainStartup(frame); if (!failed) ack(frame.packet); } })()
      .finally(() => { recovery = null; });
    return recovery;
  }
  async function process(packet) {
    if (recovery) await recovery;
    if (disposed || failed) return;
    lastPacket = packet;
    try { status = parser.push(packet.data); } catch (error) { throw failure('INVALID_PACKET', error); }
    if (status.key) keyframes = Math.min(LIMIT, keyframes + 1);
    if (!status.configuration) { stage = 'waiting-configuration'; ack(packet); return; }
    const changed = configurationRevision !== status.configuration.revision;
    if (!status.hasVideo || (!keyReceived || changed) && !status.key) { stage = 'waiting-keyframe'; ack(packet); return; }
    firstTimestamp ??= packet.timestamp;
    const timestamp = Math.max(lastTimestamp + 1, packet.timestamp - firstTimestamp); lastTimestamp = timestamp;
    const frame = { packet: { sessionId: packet.sessionId, sequence: packet.sequence, width: packet.width, height: packet.height },
      configuration: status.configuration, key: status.key, timestamp,
      data: status.key ? withConfiguration(status.configuration.data, status.data) : status.data };
    if (frame.key && !painted) retainedKey = frame;
    try {
      if (!decoder || decoder.state !== 'configured' || changed) { if (!await configure(frame)) return; }
      submit(frame); await drainStartup(frame);
    } catch (error) { await recover(error); }
    if (!disposed && !failed) ack(packet);
  }
  return {
    push(packet) {
      if (disposed || failed) return Promise.resolve();
      if (queued >= 8) { terminal(lastPacket, failure('QUEUE_LIMIT')); return Promise.resolve(); }
      queued++; received = Math.min(LIMIT, received + 1);
      // Leave two bounded ingress slots for software recovery instead of letting
      // a silent hardware wait exhaust the queue before its timeout can fire.
      if (queued >= 6) for (const release of pressureWaits) release();
      chain = chain.then(() => process(packet)).catch(error => terminal(packet, error?.[INTERNAL_FAILURE] ? error : failure('DECODE_FAILED', error)))
        .finally(() => { queued--; if (!disposed && received - summaryAt >= 120) { summaryAt = received; emit('decode-summary'); } });
      return chain;
    },
    async idle() { await chain; if (recovery) await recovery.catch(() => {}); },
    dispose() { if (!disposed && received) emit('decode-summary'); disposed = true; retainedKey = null; closeDecoder(); }
  };
}
