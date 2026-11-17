const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLogCloseGuard } = require('../electron/lib/log-window-close.cjs');
function fixture(overrides = {}) {
  const contents = new EventEmitter(); contents.mainFrame = {}; contents.isDestroyed = () => false;
  const messages = []; contents.send = (name, value) => messages.push({ name, value });
  const owner = new EventEmitter(); owner.webContents = contents; owner.isDestroyed = () => false; let closes = 0;
  owner.close = () => { const event = { prevented: false, preventDefault() { this.prevented = true; } }; owner.emit('close', event); if (!event.prevented) closes++; };
  const ownerRef = { current: owner };
  const guard = createLogCloseGuard({ getOwner: () => ownerRef.current, getActivity: () => false, timeoutMs: 1000, ...overrides });
  guard.attach(owner); const event = { sender: contents, senderFrame: contents.mainFrame };
  guard.update(event, { documentId: 'source-A', revision: 1, dirty: true, sourceIdentity: overrides.getSourceIdentity?.() || '' });
  return { guard, owner, ownerRef, event, contents, messages, get closes() { return closes; } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('log close asks the exact window and cancellation preserves its content and capture', async () => {
  const f = fixture(); f.owner.close(); assert.equal(f.closes, 0);
  const { value } = f.messages.at(-1); assert.equal(f.messages.at(-1).name, 'log:closeRequested');
  assert.equal(f.guard.reply(f.event, { requestId: value.requestId, documentId: 'source-A', revision: 1, action: 'cancel' }).accepted, true);
  await tick(); assert.equal(f.closes, 0); f.guard.dispose();
});
test('only a current owned top-frame decision may discard or approve quit; stale review never bypasses close', async () => {
  const f = fixture(), pending = f.guard.confirmQuit(), request = f.messages.at(-1).value;
  const args = { requestId: request.requestId, documentId: 'source-A', revision: 1, action: 'discard' };
  assert.equal(f.guard.reply({ ...f.event, senderFrame: {} }, args).accepted, false);
  assert.equal(f.guard.reply(f.event, args).accepted, true); const permit = await pending;
  f.guard.update(f.event, { documentId: 'source-B', revision: 2, dirty: true });
  assert.equal(f.guard.allowQuit(permit), false); f.owner.close(); assert.equal(f.closes, 0);
  f.guard.dispose();
});
test('saving must be acknowledged clean before a saved decision closes, while normal ingress may retain the reviewed identity', async () => {
  const f = fixture(), pending = f.guard.confirmQuit(), request = f.messages.at(-1).value;
  const args = { requestId: request.requestId, documentId: 'source-A', revision: 1, action: 'saved' };
  assert.equal(f.guard.reply(f.event, args).accepted, false);
  f.guard.update(f.event, { documentId: 'source-A', revision: 1, dirty: false });
  assert.equal(f.guard.reply(f.event, args).accepted, true); const permit = await pending;
  assert.equal(f.guard.allowQuit(permit), true); f.owner.close(); assert.equal(f.closes, 1); f.guard.dispose();
});
test('main-frame navigation starts a new review epoch and cannot reuse approval for the previous renderer', async () => {
  const f = fixture(); f.guard.update(f.event, { documentId: 'old', revision: 10, dirty: true });
  const pending = f.guard.confirmQuit(), request = f.messages.at(-1).value;
  assert.equal(f.guard.reply(f.event, { ...request, action: 'discard' }).accepted, false);
  f.guard.reply(f.event, { requestId: request.requestId, documentId: 'old', revision: 10, action: 'discard' });
  const oldPermit = await pending;
  f.contents.emit('did-start-navigation', {}, 'new-document', false, true);
  f.contents.mainFrame = {}; const nextEvent = { sender: f.contents, senderFrame: f.contents.mainFrame };
  assert.equal(f.guard.update(nextEvent, { documentId: 'new', revision: 1, dirty: true }).accepted, true);
  assert.equal(f.guard.allowQuit(oldPermit), false); f.guard.dispose();
});
test('backend source replacement blocks both an old decision and a clean window close before renderer acknowledgement', async () => {
  let identity = 'A'; const f = fixture({ getSourceIdentity: () => identity, getPendingContent: () => true });
  const pending = f.guard.confirmQuit(), request = f.messages.at(-1).value;
  identity = 'B';
  assert.equal(f.guard.reply(f.event, { requestId: request.requestId, documentId: request.documentId, revision: request.revision, action: 'discard' }).accepted, false);
  assert.equal((await pending).proceed, false);
  assert.equal(f.guard.update(f.event, { documentId: 'source-A', revision: 2, dirty: false, ready: true, sourceIdentity: 'A' }).accepted, false);
  identity = 'A'; f.guard.update(f.event, { documentId: 'source-A', revision: 2, dirty: false, ready: true, sourceIdentity: 'A' });
  identity = 'B'; f.owner.close(); assert.equal(f.closes, 0); assert.equal((await f.guard.confirmQuit()).proceed, false);
  f.guard.dispose();
});
test('confirmed application quit keeps the no-new-capture gate until explicit cancellation, including renderer loss', async () => {
  const f = fixture(), pending = f.guard.confirmQuit(), request = f.messages.at(-1).value;
  f.guard.reply(f.event, { requestId: request.requestId, documentId: request.documentId, revision: request.revision, action: 'discard' });
  assert.equal(f.guard.allowQuit(await pending), true); assert.equal(f.guard.isQuitting(), true);
  f.contents.emit('render-process-gone'); assert.equal(f.guard.isQuitting(), true);
  f.owner.emit('closed'); assert.equal(f.guard.isQuitting(), true);
  f.guard.revokeQuit(); assert.equal(f.guard.isQuitting(), false); f.guard.dispose();
});
test('a required custom close review restores its hidden or minimized log window instead of waiting invisibly', async () => {
  const f = fixture(), visibility = [];
  f.owner.isMinimized = () => true; f.owner.restore = () => visibility.push('restore');
  f.owner.isVisible = () => false; f.owner.show = () => visibility.push('show'); f.owner.focus = () => visibility.push('focus');
  const pending = f.guard.confirmQuit(); assert.deepEqual(visibility, ['restore', 'show', 'focus']);
  const request = f.messages.at(-1).value;
  f.guard.reply(f.event, { requestId: request.requestId, documentId: request.documentId, revision: request.revision, action: 'cancel' });
  await pending; f.guard.dispose();
});
test('a previously closed log window cannot block quitting the remaining main app', async () => {
  const f = fixture(); f.owner.isDestroyed = () => true; f.ownerRef.current = null; f.owner.emit('closed');
  const permit = await f.guard.confirmQuit(); assert.equal(permit.proceed, true); assert.equal(f.guard.allowQuit(permit), true); f.guard.dispose();
});

test('a second real-style owner attaches after destroyed window.webContents starts throwing', () => {
  const f = fixture(); let destroyed = false;
  Object.defineProperty(f.owner, 'webContents', { get() { if (destroyed) throw Error('Object has been destroyed'); return f.contents; } });
  f.owner.isDestroyed = () => destroyed;
  destroyed = true; f.ownerRef.current = null; f.owner.emit('closed');
  const contents = new EventEmitter(); contents.mainFrame = {}; contents.isDestroyed = () => false; contents.send = () => {};
  const next = new EventEmitter(); next.isDestroyed = () => false; next.webContents = contents;
  f.ownerRef.current = next;
  assert.doesNotThrow(() => f.guard.attach(next));
  assert.equal(f.contents.listenerCount('render-process-gone'), 0); assert.equal(f.contents.listenerCount('did-start-navigation'), 0);
  assert.equal(f.guard.update({ sender: contents, senderFrame: contents.mainFrame }, { documentId: 'second', revision: 1, dirty: false }).accepted, true);
  f.guard.dispose();
});
test('committed application quit disables the owned log window and cancellation restores its original input state', async () => {
  const f = fixture(); let enabled = true; f.owner.isEnabled = () => enabled; f.owner.setEnabled = value => { enabled = value; };
  f.guard.update(f.event, { documentId: 'source-A', revision: 2, dirty: false });
  assert.equal(f.guard.allowQuit(await f.guard.confirmQuit()), true); assert.equal(enabled, false);
  f.guard.revokeQuit(); assert.equal(enabled, true); f.guard.dispose();
});

test('quit cancellation does not enable a log window already disabled by another owner', async () => {
  const f = fixture(); const changes = []; f.owner.isEnabled = () => false; f.owner.setEnabled = value => changes.push(value);
  f.guard.update(f.event, { documentId: 'source-A', revision: 2, dirty: false });
  assert.equal(f.guard.allowQuit(await f.guard.confirmQuit()), true);
  f.guard.revokeQuit(); assert.deepEqual(changes, []); f.guard.dispose();
});
