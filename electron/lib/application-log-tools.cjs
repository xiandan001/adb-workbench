const { EventEmitter, errorMonitor } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const { types } = require('node:util');
const { bounded, normalizeCodeArguments, own } = require('./application-log-text.cjs');

const TOOLS = ['adb', 'hdc', 'scrcpy', 'powershell', 'pwsh', 'cmd', 'git', 'node', 'python', 'ffmpeg', 'ssh', 'worker', 'other'];
const OPERATIONS = ['process', 'mirror', 'audio-probe', 'version', 'probe', 'list', 'connect', 'disconnect', 'capture', 'install', 'diagnostic', 'input', 'other'];
const MODES = ['text', 'binary', 'sensitive'];
function toolIdentity(executable) {
  if (typeof executable !== 'string') return 'other';
  const name = executable.slice(-160).split(/[\\/]/).at(-1).replace(/\.exe$/i, '').toLowerCase();
  return TOOLS.includes(name) ? name : 'other';
}
function safeToolText(text, metadata, stream) {
  if (stream !== 'stdout' || metadata.operation !== 'list' || !['adb', 'hdc'].includes(metadata.tool)) return text;
  return text.replace(/^(?!(?:List|Target|\[Empty|\[Fail|No\s|error|$))\S+/gim, '[device identifier omitted]')
    .replace(/\bserial:\S+/gi, 'serial:[identifier omitted]');
}
function createToolObserver({ record, isEnabled, noteLoss = () => {}, recordFatal = () => false, now = Date.now }) {
  const owned = new WeakMap(), active = new Set(); let sequence = 0;
  function observe(proc, options = {}) {
    if (!proc || types.isProxy(proc) || !(proc instanceof EventEmitter)) return () => {};
    const previous = owned.get(proc);
    if (previous) { previous.configure(options); return previous.dispose; }
    const started = now(), number = ++sequence, removers = [], streams = new Map(); let closed = false;
    const metadata = { tool: 'other', operation: 'process', processNumber: number }, modes = new Map();
    const emit = value => { if (isEnabled()) { try { record({ source: 'tool', ...metadata, ...value }); } catch { /* Observation cannot affect tool behavior. */ } } };
    const listen = (target, name, callback) => { EventEmitter.prototype.on.call(target, name, callback); removers.push(() => EventEmitter.prototype.removeListener.call(target, name, callback)); };
    function clearBuffers() { for (const stream of streams.values()) { stream.pending = ''; stream.decoder = new StringDecoder('utf8'); } }
    function attach(name, mode) {
      const previousMode = modes.get(name); modes.set(name, mode);
      if (streams.has(name)) streams.get(name).mode = mode;
      if (streams.has(name) || mode !== 'text') {
        if (mode !== 'text' && previousMode !== mode && isEnabled()) { noteLoss('sensitive-output', 1); emit({ event: 'excluded', stream: name, outputMode: mode }); }
        return;
      }
      const target = own(proc, name) || own(own(options, 'streams'), name);
      if (!target || types.isProxy(target) || !(target instanceof EventEmitter)) return;
      const state = { pending: '', decoder: new StringDecoder('utf8'), mode }; streams.set(name, state);
      const output = text => {
        text = safeToolText(text, metadata, name);
        const normalized = bounded(text); emit({ event: 'output', stream: name, outputMode: 'text', message: normalized.text,
        truncatedBytes: normalized.truncatedBytes, omittedCharacters: normalized.omittedCharacters, excludedValues: normalized.excludedValues }); };
      state.flush = () => { if (isEnabled() && state.pending) output(state.pending); state.pending = ''; };
      const data = chunk => {
        if (!isEnabled() || state.mode !== 'text') { state.pending = ''; state.decoder = new StringDecoder('utf8'); return; }
        if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') { noteLoss('sensitive-output', 1); return; }
        if (types.isProxy(chunk)) { noteLoss('sensitive-output', 1); return; }
        if (typeof chunk === 'string' && chunk.length > 32768) noteLoss('text-size', 1, chunk.length - 32768);
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.slice(0, 32768), 'utf8');
        const limited = bytes.subarray(0, 32768), clipped = bytes.length - limited.length;
        if (clipped) noteLoss('text-size', 1, clipped);
        const text = state.decoder.write(limited);
        if (clipped) state.decoder = new StringDecoder('utf8');
        const lines = (state.pending + text).split('\n'); state.pending = lines.pop();
        for (const line of lines.slice(0, 64)) output(line);
        if (lines.length > 64) noteLoss('line-limit', lines.length - 64);
        if (state.pending.length > 16384 || clipped) { state.flush(); state.decoder = new StringDecoder('utf8'); }
      };
      const descriptor = Object.getOwnPropertyDescriptor(target, 'emit');
      if (descriptor && !Object.hasOwn(descriptor, 'value')) return;
      const original = target.emit;
      if (typeof original !== 'function') return;
      const replacement = function (event, ...args) {
        if (event === 'data') { try { data(args[0]); } catch { noteLoss('sensitive-output', 1); } }
        return Reflect.apply(original, this, [event, ...args]);
      };
      Object.defineProperty(target, 'emit', { value: replacement, configurable: true, writable: true });
      removers.push(() => { if (target.emit === replacement) { if (descriptor) Object.defineProperty(target, 'emit', descriptor); else delete target.emit; } });
    }
    function configure(value) {
      if (closed) return;
      if (TOOLS.includes(own(value, 'tool'))) metadata.tool = own(value, 'tool');
      if (OPERATIONS.includes(own(value, 'operation'))) metadata.operation = own(value, 'operation');
      for (const key of ['mirrorNumber', 'attemptNumber']) if (Number.isSafeInteger(own(value, key)) && own(value, key) >= 0) metadata[key] = own(value, key);
      for (const name of ['stdout', 'stderr']) attach(name, MODES.includes(own(value, name)) ? own(value, name) : 'sensitive');
    }
    function dispose() {
      if (closed) return; closed = true;
      clearBuffers(); for (const remove of removers) remove(); active.delete(entry);
    }
    const entry = { configure, dispose, clearBuffers, flush() { for (const stream of streams.values()) stream.flush?.(); } }; owned.set(proc, entry); active.add(entry);
    listen(proc, options.tool === 'worker' ? 'online' : 'spawn', () => emit({ event: 'spawn' }));
    listen(proc, errorMonitor, error => {
      const details = streams.size ? normalizeCodeArguments([error], { errorData: metadata.tool === 'worker' }) : {};
      if (metadata.tool === 'worker' && streams.size && isEnabled() && proc.listenerCount('error') === 0) {
        try { if (recordFatal({ source: 'code', event: 'exception', origin: 'worker', level: 'error', ...metadata, ...details }, error)) return; } catch { /* Keep default Worker error behavior. */ }
      }
      emit({ event: 'failure', ...details, durationMs: Math.max(0, now() - started) });
    });
    listen(proc, options.tool === 'worker' ? 'exit' : 'close', (exitCode, signal) => {
      for (const stream of streams.values()) stream.flush?.();
      emit({ event: 'exit', exitCode, signal, durationMs: Math.max(0, now() - started) }); dispose();
    });
    configure(options); return dispose;
  }
  return { observe, flush() { for (const entry of active) entry.flush(); }, reset() { for (const entry of active) entry.clearBuffers(); }, cleanup() { for (const entry of [...active]) entry.dispose(); } };
}

module.exports = { createToolObserver, toolIdentity, safeToolText, TOOLS, OPERATIONS };
