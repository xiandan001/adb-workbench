import { createH264StreamState, withConfiguration } from './harmony-media-codec.js';

const LIMIT = 1000000000;
export function createH264Decoder({ acknowledge, onFrame, onError, Decoder = globalThis.VideoDecoder, Chunk = globalThis.EncodedVideoChunk }) {
  const parser = createH264StreamState(), sequences = new Map();
  let decoder, generation = 0, disposed = false, failed = false, painted = false, software = false;
  let chain = Promise.resolve(), recovery = null, queued = 0, received = 0, submitted = 0, keyframes = 0;
  let status = { sps: false, pps: false, configuration: null }, stage = 'waiting-configuration';
  let configurationRevision = -1, keyReceived = false, firstTimestamp = null, lastTimestamp = -1, retainedKey = null, lastPacket = null;
  const diagnostic = () => ({ stage, received, submitted, keyframes, sps: status.sps, pps: status.pps, codec: status.configuration?.codec || '' });
  function ack(packet, decoded = false) {
    if (!disposed) acknowledge({ sessionId: packet.sessionId, sequence: packet.sequence, diagnostic: diagnostic(), ...(decoded ? { decoded: true } : {}) });
  }
  function closeDecoder() {
    generation++;
    if (decoder && decoder.state !== 'closed') decoder.close();
    decoder = null; keyReceived = false; sequences.clear();
  }
  function terminal(packet) {
    if (disposed || failed) return;
    failed = true; stage = 'decoder-error'; closeDecoder(); retainedKey = null;
    if (packet) ack(packet);
    onError();
  }
  async function configure(frame) {
    closeDecoder();
    const current = generation;
    const options = { codec: frame.configuration.codec, optimizeForLatency: true,
      hardwareAcceleration: software ? 'prefer-software' : 'prefer-hardware', codedWidth: frame.packet.width, codedHeight: frame.packet.height };
    if (!Decoder || !Chunk || !(await Decoder.isConfigSupported(options)).supported) throw Error('H264_DECODER');
    if (disposed || failed || current !== generation) return false;
    decoder = new Decoder({
      output(videoFrame) {
        try {
          if (disposed || failed || current !== generation) return;
          const packet = sequences.get(videoFrame.timestamp); sequences.delete(videoFrame.timestamp);
          if (!packet) return;
          onFrame(videoFrame, packet);
          if (!painted) { painted = true; retainedKey = null; ack(packet, true); }
        } catch { terminal(lastPacket); }
        finally { videoFrame.close(); }
      },
      error() {
        if (disposed || failed || current !== generation) return;
        if (painted || software) { terminal(lastPacket); return; }
        void recover().catch(() => terminal(lastPacket));
      }
    });
    decoder.configure(options); configurationRevision = frame.configuration.revision;
    return true;
  }
  function submit(frame) {
    if (disposed || failed) return;
    if (decoder.decodeQueueSize >= 8 || sequences.size >= 16) throw Error('H264_QUEUE');
    sequences.set(frame.timestamp, frame.packet);
    submitted = Math.min(LIMIT, submitted + 1); stage = 'submitted';
    decoder.decode(new Chunk({ type: frame.key ? 'key' : 'delta', timestamp: frame.timestamp, data: frame.data }));
    keyReceived = true;
  }
  function recover() {
    if (recovery) return recovery;
    if (disposed || failed) return Promise.resolve();
    if (painted || software || !retainedKey) return Promise.reject(Error('H264_DECODER'));
    software = true;
    const frame = retainedKey;
    recovery = (async () => { if (await configure(frame)) { submit(frame); ack(frame.packet); } })().finally(() => { recovery = null; });
    return recovery;
  }
  async function process(packet) {
    if (recovery) await recovery;
    if (disposed || failed) return;
    lastPacket = packet; status = parser.push(packet.data);
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
      submit(frame);
    } catch (error) { if (error.message === 'H264_QUEUE') throw error; await recover(); }
    if (!disposed && !failed) ack(packet);
  }
  return {
    push(packet) {
      if (disposed || failed) return Promise.resolve();
      if (queued >= 8) { terminal(lastPacket); return Promise.resolve(); }
      queued++; received = Math.min(LIMIT, received + 1);
      chain = chain.then(() => process(packet)).catch(() => terminal(packet)).finally(() => { queued--; });
      return chain;
    },
    async idle() { await chain; if (recovery) await recovery.catch(() => {}); },
    dispose() { disposed = true; retainedKey = null; closeDecoder(); }
  };
}
