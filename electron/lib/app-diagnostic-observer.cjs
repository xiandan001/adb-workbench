const { types } = require('node:util');
const { safeDiagnosticChannel } = require('./app-diagnostic-log.cjs');

function structuredFailure(value) {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return false;
  return ['ok', 'success'].some(key => Object.getOwnPropertyDescriptor(value, key)?.value === false);
}
function createDiagnosticIpc(ipcMain, logger) {
  const bound = new Map();
  return new Proxy(ipcMain, {
    get(target, key) {
      if (key === 'handle') return (channel, handler) => {
        if (typeof handler !== 'function') return target.handle(channel, handler);
        return target.handle(channel, function (...args) {
          const started = Date.now();
          const record = (errorCode, errorType) => {
            try { logger.record({ level: 'error', module: 'ipc', operation: 'ipc', outcome: 'failure',
              channel: safeDiagnosticChannel(channel), errorCode, errorType, durationMs: Math.max(0, Date.now() - started) }); }
            catch { /* Optional diagnostics must never affect the original IPC operation. */ }
          };
          const success = value => { if (structuredFailure(value)) record('IPC_FAILURE', 'structured'); return value; };
          let value;
          try { value = Reflect.apply(handler, this, args); }
          catch (error) { record('IPC_THROW', 'thrown'); throw error; }
          if (types.isPromise(value)) return value.then(success, error => { record('IPC_REJECT', 'rejected'); throw error; });
          return success(value);
        });
      };
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (!bound.has(key)) bound.set(key, value.bind(target));
      return bound.get(key);
    }
  });
}

module.exports = { createDiagnosticIpc };
