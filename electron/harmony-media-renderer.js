import { setCodecMessages } from './harmony-media-codec.js';
import { createH264Decoder } from './harmony-media-decoder.js';
import { createMediaRecorderController } from './harmony-media-recorder.js';

const api = window.harmonyMedia;
const element = id => document.getElementById(id);
const canvas = element('screen'), context = canvas.getContext('2d', { alpha: false });
let labels = {}, session = {}, recording = null, decoded = false;
let localError = '', pending = false, pointer = null;
let controlError = null, controlGeneration = 0, controlSequence = 0, controlAlive = true;
const controlRequests = new Set();
const controlBusyFor = new Set();
const unsubscribe = [];
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
let video = createDecoder();

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
  for (const id of ['home', 'back', 'text', 'send']) element(id).disabled = !controlled || controlRequests.size > 0;
  canvas.dataset.control = String(controlled);
  const controlBusy = controlRequests.size > 0;
  const controlNotice = controlBusy ? controlBusyFor.size ? labels.controlErrors?.INPUT_BUSY || labels.controlSending : labels.controlSending
    : controlError ? labels.controlErrors?.[controlError.key] || labels.controlFailed : '';
  element('control-status').hidden = !controlNotice;
  element('control-status').textContent = controlNotice || '';
  element('control-status').dataset.error = String(Boolean(controlError && !controlBusy));
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
function createDecoder() {
  return createH264Decoder({
    acknowledge: value => { void api.ack(value).catch(() => {}); },
    onDiagnostic: value => { void api.diagnostic?.(value)?.catch(() => {}); },
    onError: () => fail('decoderError'),
    onFrame: (frame, packet) => {
      if (packet.sessionId !== session.id) throw new Error();
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth; canvas.height = frame.displayHeight; fitCanvas();
      }
      context.drawImage(frame, 0, 0, canvas.width, canvas.height);
      if (!decoded) { decoded = true; render(); }
    }
  });
}
function receive(packet) {
  if (session.id && session.id !== packet.sessionId) return;
  if (!session.id) session = { ...session, id: packet.sessionId };
  void video.push(packet);
}
function updateSession(value) {
  if (session.id && value.id && session.id !== value.id) {
    video.dispose(); video = createDecoder(); decoded = false;
    controlGeneration++; controlRequests.clear(); controlBusyFor.clear(); controlError = null; pointer = null;
  }
  session = value; render();
}
function controlFailure(result) {
  const known = labels.controlErrors || {};
  const key = typeof result?.code === 'string' && Object.hasOwn(known, result.code) ? result.code
    : typeof result?.error === 'string' ? Object.keys(known).find(name => known[name] === result.error) : null;
  return { key: key || 'INPUT_UNKNOWN' };
}
async function input(value) {
  if (!controlAlive || !element('control').checked || !decoded || session.status !== 'streaming') return false;
  const generation = controlGeneration, sessionId = session.id, request = ++controlSequence;
  const current = () => controlAlive && generation === controlGeneration && session.id === sessionId && session.status === 'streaming';
  // Canvas repeats still reach the trusted single-flight gate, where the rejection is logged.
  for (const earlier of controlRequests) controlBusyFor.add(earlier);
  controlRequests.add(request); render();
  try {
    const result = await api.input(value);
    if (!current()) return false;
    if (!result?.success) {
      const failure = controlFailure(result);
      if (failure.key === 'INPUT_BUSY') {
        // A late refusal describes an earlier operation, not this completed reply.
        for (const earlier of controlRequests) if (earlier < request) controlBusyFor.add(earlier);
      } else controlError = failure;
      return false;
    }
    controlError = null;
    return true;
  } catch { if (current()) controlError = { key: 'INPUT_UNKNOWN' }; return false; }
  finally { controlRequests.delete(request); controlBusyFor.delete(request); if (controlAlive) render(); }
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
element('control').addEventListener('change', () => { controlGeneration++; controlBusyFor.clear(); controlError = null; pointer = null; render(); });
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
window.addEventListener('beforeunload', () => {
  controlAlive = false; controlGeneration++; controlRequests.clear(); controlBusyFor.clear();
  viewport.disconnect(); controller.dispose(); video.dispose(); for (const remove of unsubscribe) remove?.();
});
void initialize().catch(() => fail('transportError'));
