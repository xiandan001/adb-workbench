const test = require('node:test'); const assert = require('node:assert/strict'); const { EventEmitter } = require('node:events');
const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');
const { createFeedbackController } = require('../electron/lib/feedback.cjs');
function harness() {
  const calls = []; const handlers = new Map(); const ipc = Object.assign(new EventEmitter(), { handle: (name, handler) => handlers.set(name, handler) });
  const webContents = { mainFrame: {}, isDestroyed: () => false }; let owner = { isDestroyed: () => false, webContents };
  const service = Object.fromEntries(['context', 'preview', 'submit', 'openIssue'].map(name => [name, async () => { calls.push(name); return {}; }])); service.dispose = () => calls.push('dispose');
  const auth = Object.fromEntries(['start', 'status', 'cancel', 'logout'].map(name => [name, async () => { calls.push(name); return {}; }])); auth.dispose = () => {};
  const controller = createFeedbackController({ service, auth, logger: { record: () => calls.push('log'), dispose: async () => {} }, getOwner: () => owner }); controller.register(ipc);
  return { controller, handlers, calls, ipc, service, event: { sender: webContents, senderFrame: webContents.mainFrame }, replace: () => { owner = null; } };
}
test('all feedback channels require current main-window identity and main frame', async () => {
  const h = harness();
  for (const handler of h.handlers.values()) {
    for (const event of [{}, { ...h.event, senderFrame: {} }, { ...h.event, sender: {} }]) assert.equal((await handler(event)).error.code, 'FEEDBACK_OWNER');
  }
  assert.deepEqual(h.calls, []); assert.equal((await h.handlers.get('feedback:context')(h.event)).ok, true);
});
test('read operations reject unexpected inputs and no remote/raw errors reach the renderer', async () => {
  const h = harness(); assert.equal((await h.handlers.get('feedback:auth-start')(h.event, { token: 'private' })).ok, false); assert.deepEqual(h.calls, []);
  h.service.context = async () => { throw Error('SECRET_TOKEN_PRIVATE_PATH'); };
  const result = await h.handlers.get('feedback:context')(h.event); assert.equal(result.ok, false); assert.ok(!JSON.stringify(result).includes('SECRET'));
});
test('owner replacement during await rejects late data and renderer error telemetry ignores payloads', async () => {
  const h = harness(); h.service.context = async () => { h.replace(); return { private: 'data' }; };
  assert.equal((await h.handlers.get('feedback:context')(h.event)).error.code, 'FEEDBACK_OWNER');
  const valid = harness(); valid.ipc.emit('feedback:renderer-error', valid.event, 'RAW_PRIVATE_ERROR'); assert.deepEqual(valid.calls, ['log']);
  valid.ipc.emit('feedback:renderer-error', {}, 'RAW_PRIVATE_ERROR'); assert.deepEqual(valid.calls, ['log']);
  await valid.controller.dispose(); assert.equal((await valid.handlers.get('feedback:context')(valid.event)).ok, false);
});
test('preload exposes fixed reporting operations without an access-token accessor', () => {
  const exposed = {}; const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), { require: () => ({ contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } }, ipcRenderer: { invoke: (...args) => calls.push(args) }, webUtils: {} }) });
  exposed.electronAPI.feedbackContext(); exposed.electronAPI.feedbackPreview({ includeLogs: false });
  assert.deepEqual(calls.map(row => row[0]), ['feedback:context', 'feedback:preview']);
  assert.ok(!Object.keys(exposed.electronAPI).some(key => /^feedback.*token/i.test(key)));
});
