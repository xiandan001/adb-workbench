const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { attachWindowRenderContinuity } = require('../electron/lib/window-render-continuity.cjs');

function fixture() {
  let visible = false, minimized = false, destroyed = false, contentDestroyed = false;
  const throttles = [], frames = new Map(); let next = 0, repaints = 0;
  const window = Object.assign(new EventEmitter(), { isVisible: () => visible, isMinimized: () => minimized, isDestroyed: () => destroyed,
    webContents: Object.assign(new EventEmitter(), { isDestroyed: () => contentDestroyed,
      setBackgroundThrottling: value => throttles.push(value), invalidate: () => repaints++ }) });
  const controller = attachWindowRenderContinuity(window, { schedule: callback => { frames.set(++next, callback); return next; }, cancel: id => frames.delete(id) });
  return { window, controller, throttles, frames, repaints: () => repaints,
    show: () => { visible = true; window.emit('show'); }, hide: () => { visible = false; window.emit('hide'); },
    minimize: () => { minimized = true; window.emit('minimize'); }, restore: () => { minimized = false; visible = true; window.emit('restore'); },
    close: () => { destroyed = true; window.emit('closed'); }, destroyContents: () => { contentDestroyed = true; window.webContents.emit('destroyed'); },
    flush: () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } } };
}

test('startup warmup stays unthrottled and a covered window never sleeps merely on blur', () => {
  const f = fixture(); assert.deepEqual(f.throttles, []); assert.equal(f.frames.size, 0);
  f.show(); f.flush(); f.window.emit('blur'); f.window.emit('blur');
  assert.deepEqual(f.throttles, []); assert.equal(f.repaints(), 1);
  f.controller.dispose();
});

test('minimize and hide enable throttling; show/restore synchronously resume and coalesce one repaint', () => {
  const f = fixture(); f.show(); f.flush();
  f.minimize(); f.minimize(); assert.deepEqual(f.throttles, [true]);
  f.window.emit('focus'); assert.equal(f.frames.size, 0);
  f.restore(); f.window.emit('show'); f.window.emit('focus');
  assert.deepEqual(f.throttles, [true, false]); assert.equal(f.frames.size, 1);
  f.flush(); assert.equal(f.repaints(), 2);
  f.hide(); f.hide(); f.show(); f.window.emit('focus'); f.flush();
  assert.deepEqual(f.throttles, [true, false, true, false]); assert.equal(f.repaints(), 3);
});

test('a pending repaint cannot wake or render a window hidden again in the same turn', () => {
  const f = fixture(); f.show(); assert.equal(f.frames.size, 1);
  f.hide(); f.flush(); assert.equal(f.repaints(), 0); assert.equal(f.frames.size, 0);
  f.window.emit('focus'); assert.equal(f.frames.size, 0); assert.deepEqual(f.throttles, [true]);
});

test('destroyed content and closed windows cancel work and detach every owned listener', () => {
  for (const ending of ['close', 'destroyContents']) {
    const f = fixture(); f.show(); f[ending](); f.flush(); f.controller.dispose();
    assert.equal(f.repaints(), 0); assert.equal(f.frames.size, 0);
    for (const event of ['show', 'restore', 'focus', 'hide', 'minimize', 'closed']) assert.equal(f.window.listenerCount(event), 0);
    assert.equal(f.window.webContents.listenerCount('destroyed'), 0);
    f.window.emit('focus'); assert.equal(f.frames.size, 0);
  }
});
