const { types } = require('node:util');

const EVENTS = new Set(['opening', 'tool-version', 'probe', 'spawn', 'startup-check', 'ready', 'startup-unconfirmed', 'exit', 'failure', 'stop']);
const PHASES = ['validation', 'audio-probe', 'launch', 'awaiting-consent', 'awaiting-first-frame', 'streaming', 'stopping', 'ended'];
const REASONS = ['NONE', 'SPAWN_FAILED', 'CLEAN_EXIT', 'EARLY_EXIT', 'DEVICE_DISCONNECTED', 'AUDIO_CAPTURE', 'VIDEO_ENCODER', 'VIDEO_DECODER', 'TRANSPORT', 'AUTHORIZATION', 'BACKPRESSURE', 'PROTOCOL_INVALID', 'FIRST_FRAME_TIMEOUT', 'WINDOW_CLOSED', 'USER_STOP', 'STARTUP_UNCONFIRMED', 'UNKNOWN'];
const SIGNALS = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGPIPE', 'SIGHUP', 'SIGBREAK', 'SIGILL', 'SIGFPE', 'SIGBUS', 'SIGQUIT', 'UNKNOWN'];
const ENUMS = { phase: PHASES, reason: REASONS, signal: SIGNALS, videoCodec: ['default', 'unknown', 'h264', 'h265', 'av1'], audioMode: ['default', 'required-probe', 'disabled'], readiness: ['texture', 'decoded-frame', 'process-grace', 'unconfirmed'] };
const FIELDS = [...Object.keys(ENUMS), 'exitCode', 'durationMs', 'mirrorNumber', 'attemptNumber', 'width', 'height', 'toolVersion', 'diagnosticPartial', 'diagnosticTail'];
function fields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return key => descriptors[key] && Object.hasOwn(descriptors[key], 'value') ? descriptors[key].value : undefined;
}
function reasonTail(value) {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 3 || Reflect.ownKeys(value).length !== value.length + 1) return null;
  const output = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !REASONS.includes(descriptor.value) || output.includes(descriptor.value)) return null;
    output.push(descriptor.value);
  }
  return output;
}
function normalizeMirrorLogEvent(value) {
  const get = fields(value);
  if (!get || get('source') !== 'mirror' || !EVENTS.has(get('event')) || !['adb', 'hdc'].includes(get('transport'))) return null;
  const row = { source: 'mirror', event: get('event'), transport: get('transport') };
  for (const [key, allowed] of Object.entries(ENUMS)) if (allowed.includes(get(key))) row[key] = get(key);
  if (Number.isInteger(get('exitCode')) && get('exitCode') >= -2147483648 && get('exitCode') <= 4294967295) row.exitCode = get('exitCode');
  for (const key of ['durationMs', 'mirrorNumber', 'attemptNumber']) if (Number.isSafeInteger(get(key)) && get(key) >= 0 && get(key) <= 1e12) row[key] = get(key);
  for (const key of ['width', 'height']) if (Number.isSafeInteger(get(key)) && get(key) >= 0 && get(key) <= 16384) row[key] = get(key);
  if (typeof get('toolVersion') === 'string' && /^\d{1,5}(?:\.\d{1,5}){1,3}$/.test(get('toolVersion'))) row.toolVersion = get('toolVersion');
  if (typeof get('diagnosticPartial') === 'boolean') row.diagnosticPartial = get('diagnosticPartial');
  const tail = reasonTail(get('diagnosticTail')); if (tail) row.diagnosticTail = tail;
  return row;
}

function createMirrorDiagnostics({ transport, mirrorNumber, attemptNumber, phase = 'launch', audioMode = 'default', videoCodec = 'default', record = () => {}, now = Date.now } = {}) {
  const startedAt = now(), reasons = [], channels = new Map();
  let metadata = { transport, mirrorNumber, attemptNumber, phase, audioMode, videoCodec }, ended = false, disposed = false, partial = false, videoReady = false, audioStartupFailure = false, audioMention = false, demuxFailure = false;
  function emit(event, extra = {}) {
    if (disposed || ended) return null;
    const get = fields(extra), input = { ...metadata, source: 'mirror', event, diagnosticPartial: partial, diagnosticTail: [...reasons] };
    if (get) for (const key of FIELDS) if (get(key) !== undefined) input[key] = get(key);
    const row = normalizeMirrorLogEvent(input); if (!row) return null;
    for (const key of ['phase', 'width', 'height', 'toolVersion', 'audioMode', 'videoCodec']) if (row[key] !== undefined) metadata[key] = row[key];
    try { record(row); } catch { /* Optional diagnostics cannot change playback. */ }
    return row;
  }
  function classify(text) {
    const version = /^scrcpy\s+(\d{1,5}(?:\.\d{1,5}){1,3})(?:\s|$)/m.exec(text)?.[1];
    if (version && version !== metadata.toolVersion) emit('tool-version', { toolVersion: version });
    if (/INFO:\s+(?:Texture|New texture|Initial texture):/i.test(text)) {
      videoReady = true;
      const size = /(?:Texture|New texture|Initial texture):\s*(\d{1,5})x(\d{1,5})/i.exec(text);
      if (size && Number(size[1]) <= 16384 && Number(size[2]) <= 16384) { metadata.width = Number(size[1]); metadata.height = Number(size[2]); }
    }
    audioMention ||= /audio/i.test(text); demuxFailure ||= text.includes('Demuxer error');
    const audio = text.includes('Cannot create AudioRecord') || text.includes("Demuxer 'audio': stream configuration error") || demuxFailure && audioMention;
    audioStartupFailure ||= audio;
    const problem = /ERROR|Exception|failed|cannot|could not|disconnected|unauthorized|permission denied/i.test(text);
    const reason = audio ? 'AUDIO_CAPTURE' : /unauthorized|permission denied|SecurityException|not authorized/i.test(text) ? 'AUTHORIZATION'
      : /device.*(?:disconnected|offline|not found)|device disconnected|could not find any ADB device/i.test(text) ? 'DEVICE_DISCONNECTED'
        : problem && /video encoder|MediaCodec|encoder/i.test(text) ? 'VIDEO_ENCODER'
          : problem && /decoder|decoding/i.test(text) ? 'VIDEO_DECODER'
            : problem && /connection|broken pipe|socket|demuxer/i.test(text) ? 'TRANSPORT' : problem ? 'UNKNOWN' : null;
    if (reason && !reasons.includes(reason)) { reasons.push(reason); if (reasons.length > 3) reasons.shift(); }
  }
  function output(data, name = 'stdout') {
    if (disposed || ended) return { videoReady, audioStartupFailure };
    let channel = channels.get(name);
    if (!channel) { if (!['stdout', 'stderr'].includes(name)) return { videoReady, audioStartupFailure }; channel = { buffer: Buffer.alloc(0), skipping: false }; channels.set(name, channel); }
    if (typeof data === 'string' && data.length > 4096) partial = true;
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data.slice(0, 4096) : '');
    for (let offset = 0; offset < bytes.length;) {
      const newline = bytes.indexOf(10, offset), end = newline < 0 ? bytes.length : newline;
      if (!channel.skipping) {
        const room = 2048 - channel.buffer.length, take = Math.min(room, end - offset);
        if (take) channel.buffer = Buffer.concat([channel.buffer, bytes.subarray(offset, offset + take)]);
        classify(channel.buffer.toString('utf8'));
        if (take < end - offset) { partial = true; channel.buffer = Buffer.alloc(0); channel.skipping = true; }
      }
      if (newline < 0) break;
      channel.buffer = Buffer.alloc(0); channel.skipping = false; offset = newline + 1;
    }
    return { videoReady, audioStartupFailure };
  }
  function clear() { for (const channel of channels.values()) channel.buffer = Buffer.alloc(0); channels.clear(); }
  return { output, event: emit,
    finish(event, extra = {}) {
      if (disposed || ended) return;
      const get = fields(extra), safe = {};
      if (get) for (const key of FIELDS) if (get(key) !== undefined) safe[key] = get(key);
      emit(event, { ...safe, phase: 'ended', durationMs: Math.max(0, Math.min(1e12, Math.round(now() - startedAt))), reason: safe.reason || reasons.at(-1) || 'UNKNOWN' });
      ended = true; clear();
    },
    bufferedBytes: () => [...channels.values()].reduce((total, channel) => total + channel.buffer.length, 0),
    dispose() { disposed = true; clear(); },
  };
}
function mirrorFailureReason(code) {
  const reasons = { MEDIA_BACKPRESSURE: 'BACKPRESSURE', MEDIA_PROTOCOL: 'PROTOCOL_INVALID', MEDIA_SOCKET: 'TRANSPORT', MEDIA_CLOSED: 'TRANSPORT', HDC_MEDIA: 'TRANSPORT', NON_LOOPBACK_FORWARD: 'TRANSPORT',
    CAPTURE_TIMEOUT: 'FIRST_FRAME_TIMEOUT', CAPTURE_DENIED: 'AUTHORIZATION', CAPTURE_ENDED: 'CLEAN_EXIT', CANCELLED: 'USER_STOP', DEVICE_CHANGED: 'DEVICE_DISCONNECTED', WINDOW_CLOSED: 'WINDOW_CLOSED',
    AGENT_UNAVAILABLE: 'SPAWN_FAILED', AGENT_INTEGRITY: 'SPAWN_FAILED', AGENT_HANDSHAKE: 'SPAWN_FAILED', UITEST_CHANGED: 'SPAWN_FAILED', UITEST_UNSUPPORTED: 'SPAWN_FAILED', ABI_UNSUPPORTED: 'SPAWN_FAILED' };
  return typeof code === 'string' && Object.hasOwn(reasons, code) ? reasons[code] : 'UNKNOWN';
}
module.exports = { createMirrorDiagnostics, normalizeMirrorLogEvent, mirrorFailureReason };
