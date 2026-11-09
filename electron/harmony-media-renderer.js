import { setCodecMessages, h264Configuration, normalizeH264, hasVideoSlice, withConfiguration } from './harmony-media-codec.js';
import { createMediaRecorderController } from './harmony-media-recorder.js';

const api = window.harmonyMedia;
const element = id => document.getElementById(id);
const canvas = element('screen'), context = canvas.getContext('2d', { alpha: false });
let labels = {}, session = {}, recording = null, decoder = null, configuration = null;
let firstTimestamp = null, lastTimestamp = -1, keyReceived = false, decoded = false;
let queued = 0, decodeChain = Promise.resolve(), localError = '', pending = false, pointer = null;
const sequences = new Map(), unsubscribe = [];
function fitCanvas() {
  const area = canvas.parentElement;
  const scale = Math.min(area.clientWidth / canvas.width, area.clientHeight / canvas.height);
  if (!(scale > 0)) return;
  canvas.style.width = Math.floor(canvas.width * scale) + 'px';
  canvas.style.height = Math.floor(canvas.height * scale) + 'px';
}
const viewport = new ResizeObserver(fitCanvas);
viewport.observe(canvas.parentElement);
const liveRecording = () => ['starting', 'recording', 'stopping', 'saving'].includes(recording?.status);
const controller = createMediaRecorderController({ api, canvas, getSession: () => ({ ...session, decoded }), getLabels: () => labels,
  onError: () => { localError = 'recordFailed'; render(); } });

function render() {
  document.documentElement.lang = labels.locale || 'en'; document.title = labels.title || 'Veylo';
  for (const target of document.querySelectorAll('[data-label]')) target.textContent = labels[target.dataset.label] || '';
  element('title').textContent = labels.title || '';
  element('device').textContent = String(session.deviceId || '').replace(/^hdc:/, '');
  element('privacy').textContent = labels.consentNotice || '';
  element('text').placeholder = labels.textPlaceholder || ''; element('text').setAttribute('aria-label', labels.textPlaceholder || '');
  canvas.setAttribute('aria-label', labels.title || '');
  const ready = session.status === 'streaming' && decoded;
  const statusKey = liveRecording() ? ['stopping', 'saving'].includes(recording.status) ? 'saving' : 'recording'
    : recording?.status === 'saved' ? 'saved' : ({ starting: 'preparing', 'awaiting-consent': 'awaiting', streaming: decoded ? 'streaming' : 'preparing', stopping: 'stopped', stopped: 'stopped', failed: 'transportError' }[session.status] || 'preparing');
  element('status').textContent = labels[statusKey] || '';
  element('record').textContent = labels[liveRecording() ? 'stopRecord' : 'record'] || '';
  element('record').dataset.recording = String(liveRecording());
  element('record').title = labels.recordHint || '';
  element('record').disabled = pending || !ready || ['stopping', 'saving'].includes(recording?.status);
  element('withLogs').disabled = pending || liveRecording();
  const controlled = ready && element('control').checked;
  for (const id of ['home', 'back', 'text', 'send']) element(id).disabled = !controlled;
  canvas.dataset.control = String(controlled);
  const error = localError ? labels[localError] : session.error;
  const notice = error || (!ready ? labels[statusKey] : '');
  element('notice').hidden = !notice;
  element('notice').dataset.error = String(Boolean(error));
  element('notice').textContent = notice || '';
}
function fail(key) {
  localError = key; render();
  const request = api?.stop?.(); request?.catch(() => {});
}
function acknowledge(packet, output = false) {
  void api.ack({ sessionId: packet.sessionId, sequence: packet.sequence, ...(output ? { decoded: true } : {}) }).catch(() => {});
}
function resetDecoder() {
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = null; configuration = null; keyReceived = false; decoded = false;
  firstTimestamp = null; lastTimestamp = -1; sequences.clear();
}
function output(frame) {
  try {
    const packet = sequences.get(frame.timestamp); sequences.delete(frame.timestamp);
    if (!packet || packet.sessionId !== session.id) return;
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth; canvas.height = frame.displayHeight;
      fitCanvas();
    }
    context.drawImage(frame, 0, 0, canvas.width, canvas.height);
    if (!decoded) { decoded = true; acknowledge(packet, true); render(); }
  } catch { fail('decoderError'); }
  finally { frame.close(); }
}
async function configure(value, packet) {
  if (!globalThis.VideoDecoder || !globalThis.EncodedVideoChunk || !context) throw new Error();
  const options = { codec: value.codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware', codedWidth: packet.width, codedHeight: packet.height };
  if (!(await VideoDecoder.isConfigSupported(options)).supported) throw new Error();
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = new VideoDecoder({ output, error: () => fail('decoderError') });
  decoder.configure(options); keyReceived = false;
}
async function decode(packet) {
  if (session.id && session.id !== packet.sessionId) return;
  if (!session.id) session = { ...session, id: packet.sessionId };
  const value = h264Configuration(packet.data);
  if (value) {
    const changed = !configuration || configuration.codec !== value.codec;
    configuration = value;
    if (changed || !decoder || decoder.state === 'closed') await configure(value, packet);
  }
  if (value && packet.data[0] === 1) { acknowledge(packet); return; }
  if (!configuration || !decoder || decoder.state !== 'configured') { acknowledge(packet); return; }
  const bytes = normalizeH264(packet.data, configuration.lengthSize);
  if (!hasVideoSlice(bytes)) { acknowledge(packet); return; }
  const key = Boolean(packet.flags & 1);
  if (!keyReceived && !key) { acknowledge(packet); return; }
  if (decoder.decodeQueueSize >= 8) throw new Error();
  firstTimestamp ??= packet.timestamp;
  const timestamp = Math.max(lastTimestamp + 1, packet.timestamp - firstTimestamp); lastTimestamp = timestamp;
  sequences.set(timestamp, { sessionId: packet.sessionId, sequence: packet.sequence });
  if (sequences.size > 16) throw new Error();
  decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp,
    data: key ? withConfiguration(configuration.data, bytes) : bytes }));
  keyReceived = true; acknowledge(packet);
}
function receive(packet) {
  if (queued >= 8) { fail('decoderError'); return; }
  queued++;
  decodeChain = decodeChain.then(() => decode(packet)).catch(() => fail('decoderError')).finally(() => { queued--; });
}
function updateSession(value) {
  if (session.id && value.id && session.id !== value.id) resetDecoder();
  session = value; render();
}
async function input(value) {
  if (!element('control').checked || !decoded || session.status !== 'streaming') return false;
  try {
    const result = await api.input(value);
    if (!result?.success) { element('notice').textContent = result?.error || labels.unsupported; element('notice').hidden = false; return false; }
    return true;
  } catch { return false; }
}
const point = event => {
  const bounds = canvas.getBoundingClientRect();
  return { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) };
};
canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !element('control').checked || !decoded) return;
  pointer = { ...point(event), time: performance.now(), id: event.pointerId }; canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointercancel', () => { pointer = null; });
canvas.addEventListener('pointerup', event => {
  const start = pointer; pointer = null;
  if (!start || start.id !== event.pointerId) return;
  const end = point(event), distance = Math.hypot(end.x - start.x, end.y - start.y);
  void input(distance < .01 ? { type: 'tap', x: end.x, y: end.y } : { type: 'swipe', x: start.x, y: start.y, endX: end.x, endY: end.y, durationMs: Math.max(100, Math.min(5000, Math.round(performance.now() - start.time))) });
});
element('control').addEventListener('change', render);
for (const key of ['home', 'back']) element(key).addEventListener('click', () => { void input({ type: 'keyevent', key }); });
const sendText = async () => { const text = element('text').value; if (text && await input({ type: 'input', text })) element('text').value = ''; };
element('send').addEventListener('click', () => { void sendText(); });
element('text').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void sendText(); } });
element('stop').addEventListener('click', () => { void api.stop().catch(() => fail('transportError')); });
element('record').addEventListener('click', async () => {
  if (pending) return;
  pending = true; localError = ''; render();
  try {
    const result = await (liveRecording() ? api.recordStop() : api.recordStart({ withLogs: element('withLogs').checked }));
    if (!result?.success) localError = 'recordFailed';
  } catch { localError = 'recordFailed'; }
  finally { pending = false; render(); }
});
async function initialize() {
  unsubscribe.push(api.onFrame(receive), api.onState(updateSession), api.onRecordCommand(controller.command),
    api.onLocale(value => { labels = value; setCodecMessages(labels.errors); render(); }),
    api.onRecordingState(value => {
      recording = (value.sessions || []).filter(item => item.deviceId === session.deviceId).sort((a, b) => b.startedAt - a.startedAt)[0] || null;
      if (recording?.status === 'saved' && localError === 'recordFailed') localError = '';
      render();
    }));
  const initial = await api.init();
  if (!initial?.success) throw new Error();
  labels = initial.labels; setCodecMessages(labels.errors);
  session = initial.session || { deviceId: initial.deviceId, status: 'starting' }; render();
  if (!(await api.ready())?.success) throw new Error();
}
window.addEventListener('beforeunload', () => { viewport.disconnect(); controller.dispose(); resetDecoder(); for (const remove of unsubscribe) remove?.(); });
void initialize().catch(() => fail('transportError'));
