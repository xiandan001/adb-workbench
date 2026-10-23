const test = require('node:test');
const assert = require('node:assert/strict');
const { createDiagnosticIpc } = require('../electron/lib/app-diagnostic-observer.cjs');

function fixture(loggerThrows = false) {
  const handlers = new Map(); const records = []; const ipc = { value: 42,
    handle(channel, callback) { if (typeof callback !== 'function') throw new TypeError('handler is required'); handlers.set(channel, callback); }, other() { return this.value; },
    removeHandler(channel) { handlers.delete(channel); } };
  const wrapped = createDiagnosticIpc(ipc, { record(event) { records.push(event); if (loggerThrows) throw Error('logger unavailable'); } });
  return { wrapped, handlers, records };
}

test('observer preserves sync and promise results and never logs successful normal input streams', async () => {
  const h = fixture(); const value = { success: true, content: 'private' };
  h.wrapped.handle('serial:terminal-write', (_event, input) => input); assert.equal(h.handlers.get('serial:terminal-write')({}, value), value);
  const promise = Promise.resolve(value); h.wrapped.handle('ssh:terminal-write', () => promise);
  assert.equal(await h.handlers.get('ssh:terminal-write')({}), value); assert.equal(h.wrapped.other(), 42); assert.deepEqual(h.records, []);
  h.wrapped.removeHandler('ssh:terminal-write'); assert.equal(h.handlers.has('ssh:terminal-write'), false);
});

test('throw, rejection and structured failures preserve original error identity and only record safe classifications', async () => {
  const h = fixture(); const secret = Error('PASSWORD C:\\Users\\private');
  h.wrapped.handle('serial:connect', () => { throw secret; });
  assert.throws(() => h.handlers.get('serial:connect')({}, { token: 'secret' }), error => error === secret);
  h.wrapped.handle('ssh:connect', async () => { throw secret; });
  await assert.rejects(h.handlers.get('ssh:connect')({}, 'private-command'), error => error === secret);
  const failure = { ok: false, error: 'token-private' }; h.wrapped.handle('unknown-private-channel', () => failure);
  assert.equal(h.handlers.get('unknown-private-channel')({}), failure);
  assert.equal(h.records.length, 3); assert.deepEqual(h.records.map(row => row.errorCode), ['IPC_THROW', 'IPC_REJECT', 'IPC_FAILURE']);
  assert.equal(h.records[2].channel, 'other'); assert.doesNotMatch(JSON.stringify(h.records), /PASSWORD|Users|private|secret|command/);
});

test('observation never invokes result getters and logger failure cannot change IPC behavior', () => {
  const h = fixture(true); const value = Object.defineProperty({}, 'success', { get() { throw Error('must not inspect'); } });
  h.wrapped.handle('serial:snapshot', () => value); assert.equal(h.handlers.get('serial:snapshot')({}), value);
  const error = Error('original'); h.wrapped.handle('serial:send', () => { throw error; });
  assert.throws(() => h.handlers.get('serial:send')({}), value => value === error);
  assert.throws(() => h.wrapped.handle('invalid', null), /handler is required/); assert.equal(h.handlers.has('invalid'), false);
});
