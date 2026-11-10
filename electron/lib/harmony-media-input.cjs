const { controlMessages } = require('./harmony-control-messages.cjs');
const REASONS = new Set(['BUSY', 'NO_FRAME', 'DEVICE_CHANGED', 'INVALID_INPUT', 'HELP_UNAVAILABLE', 'API_UNAVAILABLE', 'UNSUPPORTED',
  'REMOTE_EXIT', 'REMOTE_UNCONFIRMED', 'TRANSPORT_ERROR', 'TIMEOUT', 'CANCELLED', 'PERMISSION_DENIED', 'UITEST_ERROR', 'UNKNOWN']);
const PHASES = new Set(['validation', 'help', 'api', 'execute', 'complete']);
const OUTCOMES = new Set(['started', 'success', 'failure', 'cancelled', 'rejected']);
const CONTROL_CODES = new Set(Object.keys(controlMessages()));
const coded = (controlCode, controlReason) => Object.assign(Error(controlCode), { controlCode, controlReason });
const operation = args => args?.type === 'tap' ? 'tap' : args?.type === 'swipe' ? 'swipe' : args?.type === 'input' ? 'text'
  : args?.type === 'keyevent' && ['home', 'back'].includes(args.key) ? args.key : 'unknown';
function resultReason(result) {
  if (result?.cancelled) return 'CANCELLED';
  if (result?.timedOut) return 'TIMEOUT';
  if (REASONS.has(result?.controlReason)) return result.controlReason;
  if (result?.transportFailure) return 'TRANSPORT_ERROR';
  if (result?.completion === 'missing') return 'REMOTE_UNCONFIRMED';
  if (Number.isSafeInteger(result?.remoteCode) && result.remoteCode !== 0) return 'REMOTE_EXIT';
  return 'UITEST_ERROR';
}
function responseCode(reason, phase) {
  const direct = { BUSY: 'INPUT_BUSY', NO_FRAME: 'INPUT_SESSION', DEVICE_CHANGED: 'INPUT_DEVICE_CHANGED', INVALID_INPUT: 'INPUT_ARGUMENT',
    UNSUPPORTED: 'INPUT_UNSUPPORTED', CANCELLED: 'INPUT_CANCELLED', TIMEOUT: 'INPUT_TIMEOUT', PERMISSION_DENIED: 'INPUT_PERMISSION',
    TRANSPORT_ERROR: 'INPUT_TRANSPORT', REMOTE_UNCONFIRMED: 'INPUT_REMOTE_UNCONFIRMED' };
  if (direct[reason]) return direct[reason];
  if (phase === 'help' || reason === 'HELP_UNAVAILABLE') return 'INPUT_HELP';
  if (phase === 'api' || reason === 'API_UNAVAILABLE') return 'INPUT_API';
  return reason === 'REMOTE_EXIT' ? 'INPUT_REMOTE_EXIT' : reason === 'UITEST_ERROR' ? 'INPUT_COMMAND' : 'INPUT_UNKNOWN';
}
function traceFields(value) {
  const next = {};
  if (PHASES.has(value?.phase)) next.phase = value.phase;
  if (OUTCOMES.has(value?.outcome)) next.outcome = value.outcome;
  if (REASONS.has(value?.reason)) next.reason = value.reason;
  if (CONTROL_CODES.has(value?.controlCode)) next.controlCode = value.controlCode;
  if (Number.isSafeInteger(value?.durationMs) && value.durationMs >= 0 && value.durationMs <= 1e12) next.durationMs = value.durationMs;
  if (Number.isInteger(value?.remoteCode) && value.remoteCode >= 0 && value.remoteCode <= 255) next.remoteCode = value.remoteCode;
  if (Number.isInteger(value?.hostCode) && value.hostCode >= -2147483648 && value.hostCode <= 4294967295) next.hostCode = value.hostCode;
  if (['confirmed', 'missing', 'not-requested'].includes(value?.completion)) next.completion = value.completion;
  if (typeof value?.transportFailure === 'boolean') next.transportFailure = value.transportFailure;
  for (const key of ['decoded', 'streaming']) if (typeof value?.[key] === 'boolean') next[key] = value[key];
  for (const key of ['width', 'height']) if (Number.isSafeInteger(value?.[key]) && value[key] > 0 && value[key] <= 16384) next[key] = value[key];
  return next;
}
function inputStep(args, state, view) {
  const point = (x, y) => {
    if (![x, y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)
      || ![state.sourceWidth, state.sourceHeight].every(value => Number.isSafeInteger(value) && value > 1 && value <= 16384)) throw coded('INPUT_ARGUMENT', 'INVALID_INPUT');
    return { x: Math.max(1, Math.min(state.sourceWidth - 1, Math.round(x * state.sourceWidth))),
      y: Math.max(1, Math.min(state.sourceHeight - 1, Math.round(y * state.sourceHeight))) };
  };
  const keys = { tap: ['type', 'x', 'y'], swipe: ['type', 'x', 'y', 'endX', 'endY', 'durationMs'], keyevent: ['type', 'key'], input: ['type', 'text'] };
  if (!args || typeof args.type !== 'string' || !Object.hasOwn(keys, args.type)) throw coded('INPUT_UNSUPPORTED', 'UNSUPPORTED');
  if (Object.keys(args).some(key => !keys[args.type].includes(key))) throw coded('INPUT_ARGUMENT', 'INVALID_INPUT');
  if (args.type === 'tap') {
    const location = point(args.x, args.y); return { step: { type: 'tap', ...location }, location };
  }
  if (args.type === 'swipe') {
    const start = point(args.x, args.y), end = point(args.endX, args.endY);
    if (args.durationMs !== undefined && !Number.isFinite(args.durationMs)) throw coded('INPUT_ARGUMENT', 'INVALID_INPUT');
    return { step: { type: 'swipe', x: start.x, y: start.y, endX: end.x, endY: end.y,
      durationMs: Math.max(100, Math.min(1000, args.durationMs || 300)) }, location: start };
  }
  if (args.type === 'keyevent' && ['home', 'back'].includes(args.key)) return { step: { type: 'keyevent', keyCode: args.key === 'home' ? 'Home' : 'Back' } };
  if (args.type === 'input' && typeof args.text === 'string' && args.text.length > 0 && args.text.length <= 2000 && !args.text.includes('\0')) return { step: { type: 'input', text: args.text }, location: view.lastPoint };
  throw coded(args.type === 'keyevent' ? 'INPUT_UNSUPPORTED' : 'INPUT_ARGUMENT', args.type === 'keyevent' ? 'UNSUPPORTED' : 'INVALID_INPUT');
}
function createHarmonyMediaInput({ getStream, resolveDevice, performInput, record, now = Date.now }) {
  return async function input(view, args = {}) {
    const started = now(), state = getStream(view.sessionId);
    view.controlSequence = Math.min(1e9, (view.controlSequence || 0) + 1);
    const base = { source: 'media', viewNumber: view.ordinal || 0, requestNumber: view.controlSequence, operation: operation(args) };
    const emit = (event, detail) => { try { record({ ...base, event, ...traceFields(detail) }); } catch { /* Recording is optional. */ } };
    let latestFailure, acquired = false;
    const assertCurrent = () => {
      let current;
      try { current = resolveDevice(view.deviceId); } catch { throw coded('INPUT_DEVICE_CHANGED', 'DEVICE_CHANGED'); }
      if (view.window.isDestroyed() || current.generation !== view.ref.generation || current.targetKey !== view.ref.targetKey) throw coded('INPUT_DEVICE_CHANGED', 'DEVICE_CHANGED');
    };
    emit('control-request', { phase: 'validation', outcome: 'started', decoded: Boolean(view.decoded), streaming: state?.status === 'streaming', width: state?.sourceWidth, height: state?.sourceHeight });
    try {
      assertCurrent();
      if (state?.status !== 'streaming' || !view.decoded) throw coded('INPUT_SESSION', 'NO_FRAME');
      if (view.inputBusy) throw coded('INPUT_BUSY', 'BUSY');
      const { step, location } = inputStep(args, state, view);
      view.inputBusy = true; acquired = true;
      const result = await performInput(view.deviceId, step, location, { deviceRef: view.ref, assertCurrent,
        uitestCapabilities: view.uiCapabilities,
        onUiCapabilities(capabilities) { assertCurrent(); view.uiCapabilities = capabilities; },
        onControlTrace(detail) {
          const trace = traceFields(detail); if (['failure', 'cancelled'].includes(trace.outcome)) latestFailure = trace;
          emit('control-stage', trace);
        } });
      assertCurrent();
      if (getStream(view.sessionId)?.status !== 'streaming') throw coded('INPUT_SESSION', 'NO_FRAME');
      if (!result.ok) {
        const reason = latestFailure?.reason || resultReason(result), phase = latestFailure?.phase || 'execute', code = responseCode(reason, phase);
        emit('control-result', { ...result, phase, reason, controlCode: code, outcome: result.cancelled ? 'cancelled' : 'failure', durationMs: Math.max(0, now() - started) });
        return { success: false, code, error: controlMessages()[code] };
      }
      if (args.type === 'tap') view.lastPoint = location;
      emit('control-result', { ...result, phase: 'complete', outcome: 'success', durationMs: Math.max(0, now() - started) });
      return { success: true, error: '' };
    } catch (error) {
      const reason = error.controlReason && REASONS.has(error.controlReason) ? error.controlReason : latestFailure?.reason || (error.code === 'CANCELLED' ? 'CANCELLED' : 'UNKNOWN');
      const phase = latestFailure?.phase || (PHASES.has(error.controlPhase) ? error.controlPhase : 'validation');
      const code = Object.hasOwn(controlMessages(), error.controlCode) ? error.controlCode : responseCode(reason, phase);
      emit('control-result', { phase, reason, controlCode: code, outcome: ['BUSY', 'NO_FRAME', 'DEVICE_CHANGED', 'INVALID_INPUT', 'UNSUPPORTED'].includes(reason) ? 'rejected' : 'failure', durationMs: Math.max(0, now() - started) });
      return { success: false, code, error: controlMessages()[code] };
    } finally { if (acquired) view.inputBusy = false; }
  };
}
module.exports = { createHarmonyMediaInput };
