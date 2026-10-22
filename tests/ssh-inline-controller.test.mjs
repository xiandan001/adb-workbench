import test from 'node:test';
import assert from 'node:assert/strict';
import { createSshInlineController } from '../src/shared/sshInlineController.js';

function setup(t) {
  const frames = []; const events = new Map(); const focusEvents = []; const sent = [];
  const textarea = { addEventListener() {}, removeEventListener() {}, removeAttribute() {} };
  const saved = new Map(['document', 'window', 'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: textarea, hidden: false, hasFocus: () => true } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { innerWidth: 900, innerHeight: 600, addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: callback => { frames.push(callback); return frames.length; } });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: () => {} });
  let line = '$ '; let popup = null;
  const buffer = { type: 'normal', baseY: 0, viewportY: 0, cursorY: 0, cursorX: 2, getLine: () => ({ isWrapped: false, translateToString: (trim, start = 0, end) => { const value = line.slice(start, end); return trim ? value.trimEnd() : value; } }) };
  const writerState = { queuedBytes: 0, inFlight: false, paused: false };
  const context = { active: true, connected: true, replaying: false, paused: false, readFailed: false };
  const event = name => callback => { events.set(name, callback); return { dispose() {} }; };
  const term = { textarea, rows: 12, cols: 80, buffer: { active: buffer }, registerMarker: () => ({ line: 0, dispose() {} }), onWriteParsed: event('write'), onCursorMove: event('cursor'), onScroll: event('scroll'), onResize: event('resize') };
  const controller = createSshInlineController({ term, host: { querySelector: () => ({ getBoundingClientRect: () => ({ left: 10, top: 20, width: 640, height: 192 }) }) }, getContext: () => context, getWriter: () => ({ state: () => writerState, enqueue: value => { sent.push(value); return true; } }),
    getEntries: () => [{ id: '1', command: 'git status' }, { id: '2', command: 'git show' }], onPopup: value => { popup = value; }, onFocus: value => focusEvents.push(value) });
  t.after(() => { controller.dispose(); for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const flush = () => { while (frames.length) frames.shift()(); };
  const render = value => { line = `$ ${value}`; buffer.cursorX = line.length; events.get('write')(); flush(); };
  const prompt = id => { line = '$ '; buffer.cursorX = 2; controller.shell({ status: 'ready', phase: 'prompt', promptId: id }); controller.marker({ kind: 'prompt', promptId: id }); flush(); };
  prompt(1);
  return { controller, context, writerState, sent, focusEvents, flush, render, prompt, popup: () => popup, type(value) { controller.input(value, true); } };
}

test('inline controller appends suffix only, never CR, and rejects an old popup while echo is behind', t => {
  const h = setup(t); h.type('git'); h.render('git'); assert.equal(h.popup().entries.length, 2);
  h.type('x'); h.writerState.queuedBytes = 1;
  assert.equal(h.controller.accept('git status'), false); assert.deepEqual(h.sent, []);
  h.writerState.queuedBytes = 0; assert.equal(h.controller.accept('git status'), false);
  h.render('gitx'); assert.equal(h.popup(), null);
  h.prompt(2); h.type('git'); h.render('git'); assert.equal(h.controller.accept('git status'), true); assert.deepEqual(h.sent, [' status']);
});

test('popup keyboard selection and dismissal do not change native Enter or CtrlR behavior', t => {
  const h = setup(t); h.type('git'); h.render('git');
  assert.equal(h.controller.key({ type: 'keydown', key: 'ArrowDown' }), true); assert.equal(h.popup().index, 1);
  assert.equal(h.controller.key({ type: 'keydown', key: 'Escape' }), true); h.controller.refresh(); h.flush(); assert.equal(h.popup(), null);
  h.prompt(2); h.type('git'); h.render('git');
  assert.equal(h.controller.key({ type: 'keydown', key: 'Enter' }), false); h.controller.refresh(); h.flush(); assert.equal(h.popup(), null);
  h.prompt(3); h.type('git'); h.render('git');
  assert.equal(h.controller.key({ type: 'keydown', key: 'r', ctrlKey: true }), false); h.controller.refresh(); h.flush(); assert.equal(h.popup(), null);
  assert.deepEqual(h.sent, []);
});

test('hidden and replaying terminals cannot accept candidates and focus is released on hide', t => {
  const h = setup(t); h.controller.sync(); assert.deepEqual(h.focusEvents, [true]);
  h.type('git'); h.render('git'); h.context.active = false; h.controller.sync();
  assert.equal(h.controller.accept('git status'), false); assert.deepEqual(h.focusEvents, [true, false]);
  h.context.active = true; h.context.replaying = true; assert.equal(h.controller.accept('git status'), false); assert.deepEqual(h.sent, []);
});

test('automatic terminal responses do not become expected input or local history', t => {
  const h = setup(t); h.controller.input('\x1b[1;3R', false); h.type('git'); h.render('git');
  assert.ok(h.popup()); assert.equal(h.controller.accept('git status'), true); assert.deepEqual(h.sent, [' status']);
});
