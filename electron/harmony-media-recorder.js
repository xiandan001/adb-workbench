const MAX_CHUNK = 8 * 1024 * 1024;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_QUEUED_BYTES = 32 * 1024 * 1024;
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

export function createMediaRecorderController({ api, canvas, getSession, getLabels, onError = () => {}, Recorder = globalThis.MediaRecorder }) {
  let current = null, commands = Promise.resolve(), disposed = false;
  const seen = new Set();
  const failed = () => new Error(getLabels().recordFailed);
  const check = result => { if (!result?.success) throw failed(); };
  function stopTracks(runtime) { for (const track of runtime.stream?.getTracks() || []) track.stop(); }
  function fail(runtime, error) {
    runtime.error ||= error;
    onError(getLabels().recordFailed);
    if (!disposed && !runtime.stopRequested) {
      runtime.stopRequested = true;
      void api.recordStop().catch(() => {});
    }
  }
  function enqueue(runtime, blob) {
    if (!blob.size || runtime.error || disposed) return;
    if (runtime.bytes + blob.size > MAX_BYTES || runtime.queuedBytes + blob.size > MAX_QUEUED_BYTES) { fail(runtime, failed()); return; }
    runtime.bytes += blob.size;
    runtime.queuedBytes += blob.size;
    runtime.writes = runtime.writes.then(async () => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      for (let offset = 0; offset < bytes.length; offset += MAX_CHUNK) {
        if (disposed || runtime.error) throw failed();
        const chunk = bytes.slice(offset, offset + MAX_CHUNK);
        check(await api.recordChunk({ id: runtime.id, sequence: runtime.sequence++, bytes: chunk.buffer }));
      }
    }).catch(error => fail(runtime, error)).finally(() => { runtime.queuedBytes -= blob.size; });
  }
  async function begin(command) {
    const session = getSession();
    if (disposed || current || !Recorder || !UUID.test(command.id || '') || command.streamId !== session?.id || !session.decoded) throw failed();
    const mimeType = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'].find(type => Recorder.isTypeSupported(type));
    if (!mimeType) throw failed();
    const stream = canvas.captureStream(Math.max(5, Math.min(30, session.fps || 20)));
    const runtime = { id: command.id, stream, sequence: 0, bytes: 0, queuedBytes: 0, writes: Promise.resolve(), mimeType };
    current = runtime;
    try {
      const recorder = new Recorder(stream, { mimeType, videoBitsPerSecond: 3000000 });
      runtime.recorder = recorder;
      runtime.stopped = new Promise(resolve => { runtime.resolveStopped = resolve; });
      recorder.ondataavailable = event => enqueue(runtime, event.data);
      recorder.onerror = () => { fail(runtime, failed()); runtime.resolveStopped(); };
      recorder.onstop = () => { stopTracks(runtime); runtime.resolveStopped(); };
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(failed()), 5000);
        recorder.onstart = () => { clearTimeout(timer); resolve(); };
        try { recorder.start(1000); } catch (error) { clearTimeout(timer); reject(error); }
      });
    } catch (error) { stopTracks(runtime); current = null; throw error; }
  }
  async function end(command) {
    const runtime = current;
    if (!runtime || runtime.id !== command.id || command.streamId !== getSession()?.id) throw failed();
    try {
      if (runtime.recorder.state !== 'inactive') runtime.recorder.stop();
      await runtime.stopped;
      await runtime.writes;
      if (runtime.error || disposed || !runtime.bytes) throw failed();
      check(await api.recordEnd({ id: runtime.id, mimeType: runtime.mimeType }));
    } finally { stopTracks(runtime); if (current === runtime) current = null; }
  }
  function command(value) {
    if (!value || typeof value.commandId !== 'string' || !value.commandId || value.commandId.length > 128 || seen.has(value.commandId)) return;
    seen.add(value.commandId);
    if (seen.size > 100) seen.delete(seen.values().next().value);
    commands = commands.then(async () => {
      let success = false;
      try {
        if (value.action === 'start') await begin(value);
        else if (value.action === 'stop') await end(value);
        else throw failed();
        success = true;
      } catch { onError(getLabels().recordFailed); }
      await api.recordResponse({ commandId: value.commandId, success, ...(success ? {} : { error: getLabels().recordFailed }) }).catch(() => {});
    });
  }
  return { command, idle: () => commands,
    dispose() {
      disposed = true;
      if (current) {
        try { if (current.recorder?.state !== 'inactive') current.recorder?.stop(); } catch { /* Host retains unfinished recovery state. */ }
        stopTracks(current);
      }
    } };
}
