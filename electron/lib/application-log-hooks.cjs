const { types } = require('node:util');
const { normalizeCodeArguments, own } = require('./application-log-text.cjs');
const { safeDiagnosticChannel } = require('./app-diagnostic-log.cjs');
const { toolIdentity, safeToolText } = require('./application-log-tools.cjs');
const { classifyToolCall } = require('./application-log-tool-policy.cjs');

function installCodeHooks({ consoleObject, childProcess, record, isEnabled, observeToolProcess, now = Date.now }) {
  const removers = []; let logging = false;
  const capture = value => { if (!isEnabled() || logging) return; logging = true; try { record(value); } catch { /* Preserve original outcomes. */ } finally { logging = false; } };
  for (const level of ['log', 'info', 'debug', 'warn', 'error', 'trace']) {
    const original = consoleObject?.[level]; if (typeof original !== 'function') continue;
    const replacement = function (...args) {
      try { return Reflect.apply(original, this, args); }
      finally { if (isEnabled() && !logging) { try { capture({ source: 'code', event: 'console', origin: 'main', level: level === 'log' || level === 'trace' ? 'info' : level,
        ...normalizeCodeArguments(args) }); } catch { /* Never replace an original console outcome. */ } } }
    };
    consoleObject[level] = replacement; removers.push(() => { if (consoleObject[level] === replacement) consoleObject[level] = original; });
  }
  for (const name of ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execFileSync', 'execSync']) {
    const original = childProcess?.[name]; if (typeof original !== 'function') continue;
    const replacement = function (...args) {
      const tool = name === 'fork' ? 'node' : name.startsWith('exec') && !name.includes('File') ? 'other' : toolIdentity(args[0]), started = now();
      const policy = ['spawn', 'execFile', 'spawnSync', 'execFileSync'].includes(name) ? classifyToolCall(args[0], args[1] || []) : { tool, operation: 'process', stdout: 'sensitive', stderr: 'sensitive' };
      const output = (value, stream) => { if (isEnabled() && policy[stream] === 'text' && (typeof value === 'string' || Buffer.isBuffer(value))) {
        const string = typeof value === 'string' ? value.slice(0, 32768) : value.subarray(0, 32768).toString('utf8');
        const normalized = normalizeCodeArguments([safeToolText(string, policy, stream)]);
        if (Buffer.isBuffer(value)) normalized.truncatedBytes += Math.max(0, value.length - 32768);
        else normalized.omittedCharacters += Math.max(0, value.length - 32768);
        capture({ source: 'tool', event: 'output', tool, operation: policy.operation, stream, outputMode: 'text', ...normalized });
      } };
      try {
        const value = Reflect.apply(original, this, args);
        if (name.endsWith('Sync')) {
          output(name === 'spawnSync' ? own(value, 'stdout') : value, 'stdout'); output(own(value, 'stderr'), 'stderr');
          capture({ source: 'tool', event: 'exit', tool, operation: policy.operation, exitCode: own(value, 'status') ?? 0, durationMs: Math.max(0, now() - started) });
        } else { try { observeToolProcess(value, policy); } catch { /* Observation does not change a successful spawn. */ } }
        return value;
      } catch (error) { output(own(error, 'stdout'), 'stdout'); output(own(error, 'stderr'), 'stderr');
        capture({ source: 'tool', event: 'failure', tool, operation: policy.operation, durationMs: Math.max(0, now() - started) }); throw error; }
    };
    childProcess[name] = replacement; removers.push(() => { if (childProcess[name] === replacement) childProcess[name] = original; });
  }
  return () => { for (const remove of removers.reverse()) remove(); };
}
function createApplicationIpc(ipcMain, { record, isEnabled, isTrustedEvent = () => true, now = Date.now }) {
  return new Proxy(ipcMain, { get(target, key) {
    if (key !== 'handle') { const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; }
    return (channel, handler) => target.handle(channel, function (...args) {
      const started = now(), safe = safeDiagnosticChannel(channel);
      const capture = value => { if (isEnabled() && !String(channel).startsWith('app-log:')) { try {
        if (isTrustedEvent(args[0])) record({ source: 'ipc', channel: safe, durationMs: Math.max(0, now() - started), ...value });
      } catch { /* Never modify IPC. */ } } };
      capture({ event: 'start', outcome: 'started' });
      const success = value => { const failed = value && typeof value === 'object' && !types.isProxy(value) && (own(value, 'ok') === false || own(value, 'success') === false);
        const error = failed ? own(value, 'error') : undefined;
        capture({ event: 'result', outcome: failed ? 'failure' : 'success',
          ...(typeof error === 'string' || types.isNativeError(error) ? normalizeCodeArguments([error]) : {}) }); return value; };
      const failure = error => { capture({ event: 'failure', outcome: 'failure', ...normalizeCodeArguments([error]) }); throw error; };
      let value; try { value = Reflect.apply(handler, this, args); } catch (error) { return failure(error); }
      return types.isPromise(value) ? value.then(success, failure) : success(value);
    });
  } });
}
module.exports = { installCodeHooks, createApplicationIpc };
