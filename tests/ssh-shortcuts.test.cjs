const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSshShortcutGuard } = require('../electron/lib/ssh-shortcuts.cjs');

function fixture() {
  const owner = new EventEmitter(); const contents = new EventEmitter(); const changes = [];
  owner.webContents = contents; owner.isDestroyed = () => false; owner.isVisible = () => true; owner.isMinimized = () => false;
  contents.isDestroyed = () => false; contents.setIgnoreMenuShortcuts = value => changes.push(value);
  const ready = new Set(['a/one', 'a/two', 'b/one']);
  const guard = createSshShortcutGuard({ getOwner: () => owner, isTerminalReady: (s, t) => ready.has(`${s}/${t}`) });
  const focus = (sessionId, terminalId, focused = true) => guard.set({ sessionId, terminalId, focused }, contents);
  return { owner, contents, changes, ready, guard, focus };
}
test('only a ready terminal in the owner window can suppress native menu accelerators', () => {
  const f = fixture();
  assert.throws(() => f.guard.set({ sessionId: 'a', terminalId: 'one', focused: true }, {}));
  assert.throws(() => f.focus('a', 'missing'));
  assert.deepEqual(f.changes, []);
  f.focus('a', 'one'); assert.deepEqual(f.changes, [true]);
  f.focus('a', 'one', false); assert.deepEqual(f.changes, [true, false]);
});
test('late blur from another PTY cannot release the active terminal shortcut guard', () => {
  const f = fixture(); f.focus('a', 'one'); f.focus('b', 'one'); f.focus('a', 'one', false);
  assert.equal(f.changes.at(-1), true);
  f.focus('b', 'one', false); assert.equal(f.changes.at(-1), false);
});
test('reload, owner blur, natural terminal close and disposal restore menu shortcuts', () => {
  const f = fixture();
  f.focus('a', 'one'); f.owner.emit('blur'); assert.equal(f.changes.at(-1), false);
  f.focus('a', 'one'); f.contents.emit('did-start-loading'); assert.equal(f.changes.at(-1), false);
  f.focus('a', 'one'); f.ready.delete('a/one'); f.guard.validate(); assert.equal(f.changes.at(-1), false);
  f.focus('a', 'two'); f.guard.dispose(); assert.equal(f.changes.at(-1), false);
});
test('hidden window cannot acquire shortcut ownership and session removal is scoped', () => {
  const f = fixture(); f.owner.isVisible = () => false;
  assert.throws(() => f.focus('a', 'one'));
  f.owner.isVisible = () => true; f.focus('a', 'one'); f.guard.clearSession('b');
  assert.equal(f.changes.at(-1), true); f.guard.clearSession('a'); assert.equal(f.changes.at(-1), false);
});
