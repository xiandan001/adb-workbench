const test = require('node:test');
const assert = require('node:assert/strict');
const { createApplicationLogController } = require('../electron/lib/application-log.cjs');

function fixture() {
  const mainFrame = {}, webContents = { mainFrame, isDestroyed: () => false };
  const owner = { webContents, isDestroyed: () => false };
  const event = { sender: webContents, senderFrame: mainFrame };
  const calls = [], state = { recording: false, available: false, reason: 'idle', error: '' };
  const session = { status: async () => ({ ...state }),
    start: async () => { calls.push('start'); Object.assign(state, { recording: true, available: true }); return { ...state }; },
    stop: async () => { calls.push('stop'); state.recording = false; return { ...state }; },
    text: async () => { calls.push('text'); return '{"source":"session"}\n'; } };
  let current = owner, save = { canceled: false, filePath: 'C:\\capture.log' };
  const controller = createApplicationLogController({ session, getOwner: () => current,
    showSaveDialog: async () => { calls.push('dialog'); return save; },
    writeExport: async () => { calls.push('write'); } });
  const handlers = new Map(); controller.register({ handle: (name, fn) => handlers.set(name, fn) });
  return { calls, state, session, event, handlers, setOwner: value => { current = value; }, setSave: value => { save = value; },
    invoke: (kind, input, who = event) => handlers.get('app-log:' + kind)(who, input) };
}
test('foreign renderers, subframes and payload injection cannot capture/export', async () => {
  const f = fixture();
  for (const who of [{}, { sender: f.event.sender, senderFrame: {} }]) {
    assert.equal((await f.invoke('start', undefined, who)).success, false);
    assert.equal((await f.invoke('export', undefined, who)).success, false);
  }
  assert.equal((await f.invoke('start', { directory: 'arbitrary' })).success, false);
  assert.deepEqual(f.calls, []);
});
test('explicit stop then export; cancelling keeps capture available for retry', async () => {
  const f = fixture(); assert.equal((await f.invoke('start')).state.recording, true);
  assert.equal((await f.invoke('export')).success, false);
  await f.invoke('stop'); f.setSave({ canceled: true });
  assert.equal((await f.invoke('export')).cancelled, true);
  assert.equal(f.state.available, true); assert.equal(f.calls.includes('write'), false);
  f.setSave({ canceled: false, filePath: 'C:\\capture.log' });
  assert.equal((await f.invoke('export')).success, true);
  assert.equal(f.calls.at(-1), 'write');
});
test('export success is independent of an earlier capture write error', async () => {
  const f = fixture(); await f.invoke('start'); await f.invoke('stop');
  f.state.error = 'IO_ERROR'; f.state.reason = 'io-error';
  assert.equal((await f.invoke('status')).success, true);
  const result = await f.invoke('export');
  assert.equal(result.success, true); assert.equal(result.state.reason, 'io-error');
  assert.equal(f.calls.at(-1), 'write');
});
test('window closed during save dialog cannot write a file', async () => {
  const f = fixture(); await f.invoke('start'); await f.invoke('stop');
  let resolve; f.handlers.clear();
  const controller = createApplicationLogController({ session: f.session, getOwner: () => null,
    showSaveDialog: () => new Promise(done => { resolve = done; }), writeExport: async () => f.calls.push('write') });
  controller.register({ handle: (name, fn) => f.handlers.set(name, fn) });
  assert.equal((await f.invoke('export')).success, false); assert.equal(resolve, undefined);
  assert.equal(f.calls.includes('write'), false);
});
test('revalidates owner after awaited dialog, rejects repeated export while dialog open', async () => {
  const f = fixture(); await f.invoke('start'); await f.invoke('stop');
  let resolve; let owner = { webContents: f.event.sender, isDestroyed: () => false };
  const controller = createApplicationLogController({ session: f.session, getOwner: () => owner,
    showSaveDialog: () => new Promise(done => { resolve = done; }), writeExport: async () => f.calls.push('write') });
  controller.register({ handle: (name, fn) => f.handlers.set(name, fn) });
  const pending = f.invoke('export');
  while (!resolve) await new Promise(done => setImmediate(done));
  assert.equal((await f.invoke('export')).success, false);
  owner = null; resolve({ canceled: false, filePath: 'C:\\capture.log' });
  assert.equal((await pending).success, false); assert.equal(f.calls.includes('write'), false);
});
