const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAppMessageDialogService } = require('../electron/lib/app-message-dialog-service.cjs');

const options = { type: 'question', title: 'Fixture question', message: 'Confirm fixture?', buttons: ['Paid action', 'Read only', 'Cancel'], defaultId: 2, cancelId: 2 };
function fixture(t) {
  const wc = new EventEmitter(); const messages = []; const frame = {}; let destroyed = false;
  Object.assign(wc, { mainFrame: frame, isDestroyed: () => destroyed, send: (channel, payload) => messages.push({ channel, payload }) });
  const owner = { webContents: wc, isDestroyed: () => destroyed }; const handlers = new Map();
  const service = createAppMessageDialogService({ getOwner: () => owner }); service.register({ handle: (channel, handler) => handlers.set(channel, handler) }); t.after(() => service.dispose());
  const event = { sender: wc, senderFrame: frame }; const call = (name, args, context = event) => handlers.get(`app-message-dialog:${name}`)(context, args);
  const show = () => messages.filter(row => row.payload.type === 'show').at(-1)?.payload;
  return { wc, owner, event, messages, service, call, show, destroy() { destroyed = true; wc.emit('destroyed'); } };
}
test('main dialogs fail closed before host readiness and serialize original button and checkbox semantics', async t => {
  const f = fixture(t); assert.deepEqual(await f.service.ask(options), { response: 2, checkboxChecked: false });
  assert.deepEqual(f.call('ready'), { ready: true });
  const first = f.service.ask({ ...options, checkboxLabel: 'Fixture checkbox' }); const second = f.service.ask({ ...options, title: 'Second' });
  const one = f.show(); assert.equal(one.options.defaultId, 2); assert.equal(one.options.cancelId, 2); assert.equal(f.messages.filter(row => row.payload.type === 'show').length, 1);
  assert.deepEqual(f.call('reply', { requestId: one.requestId, response: 1, checkboxChecked: true }), { accepted: true });
  assert.deepEqual(await first, { response: 1, checkboxChecked: true });
  const two = f.show(); assert.notEqual(two.requestId, one.requestId); assert.equal(two.options.title, 'Second');
  assert.deepEqual(f.call('reply', { requestId: two.requestId, response: 2, checkboxChecked: false }), { accepted: true }); await second;
});
test('foreign senders, subframes, queued IDs, invalid responses and replay cannot authorize main requests', async t => {
  const f = fixture(t); assert.equal(f.call('ready', undefined, { sender: f.wc, senderFrame: {} }).ready, false); f.call('ready');
  const pending = f.service.ask(options); const shown = f.show();
  const reply = { requestId: shown.requestId, response: 0, checkboxChecked: false };
  for (const event of [{ sender: {}, senderFrame: f.event.senderFrame }, { sender: f.wc, senderFrame: {} }, { sender: f.wc }]) assert.equal(f.call('reply', reply, event).accepted, false);
  for (const change of [{ requestId: 'not-issued' }, { response: -1 }, { response: 3 }, { response: '0' }, { checkboxChecked: true }, { unknown: true }]) assert.equal(f.call('reply', { ...reply, ...change }).accepted, false);
  assert.equal(f.call('reply', reply).accepted, true); assert.deepEqual(await pending, { response: 0, checkboxChecked: false });
  assert.equal(f.call('reply', reply).accepted, false);
});
test('reload, renderer exit, destroy and host unready cancel every pending prompt and invalidate late replies', async t => {
  for (const action of ['reload', 'crash', 'destroy', 'unready']) {
    const f = fixture(t); f.call('ready'); const first = f.service.ask(options); const second = f.service.ask(options); const id = f.show().requestId;
    if (action === 'reload') f.wc.emit('did-start-navigation', {}, 'file://fixture', false, true);
    if (action === 'crash') f.wc.emit('render-process-gone', {}, {});
    if (action === 'destroy') f.destroy();
    if (action === 'unready') f.call('unready');
    assert.equal((await first).response, 2, action); assert.equal((await second).response, 2, action);
    assert.equal(f.call('reply', { requestId: id, response: 0, checkboxChecked: false }).accepted, false, action);
  }
});
test('timeout cancels a prompt and a replacement frame needs a fresh ready handshake', async t => {
  const f = fixture(t); f.call('ready'); const pending = f.service.ask(options, { timeoutMs: 10 }); const id = f.show().requestId;
  assert.equal((await pending).response, 2); assert.equal(f.call('reply', { requestId: id, response: 0, checkboxChecked: false }).accepted, false);
  f.wc.mainFrame = {}; assert.equal((await f.service.ask(options)).response, 2);
  assert.equal(f.call('ready', undefined, { sender: f.wc, senderFrame: f.wc.mainFrame }).ready, true);
});
