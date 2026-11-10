import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const labelsFor = locale => ({ locale, title: 'Media', streaming: locale + '-video-live', controlSending: locale + '-sending',
  controlFailed: locale + '-safe-failure', controlErrors: { INPUT_BUSY: locale + '-busy', INPUT_HELP: locale + '-help-failed', INPUT_UNKNOWN: locale + '-safe-failure' } });
async function fixture(reply = async () => ({ success: true })) {
  const callbacks = {}, decoders = [], lifecycle = {}, calls = [], diagnostics = [], elements = new Map();
  let clock = 100, stopped = 0, paints = 0;
  const element = id => {
    if (!elements.has(id)) {
      const listeners = new Map();
      elements.set(id, { dataset: {}, style: {}, checked: false, disabled: false, hidden: false, textContent: '', value: '',
        parentElement: { clientWidth: 640, clientHeight: 360 }, width: 640, height: 360,
        addEventListener: (name, handler) => listeners.set(name, handler), setAttribute() {}, setPointerCapture() {},
        getBoundingClientRect: () => ({ left: 20, top: 30, width: 320, height: 180 }),
        getContext: () => ({ drawImage() { paints++; } }),
        fire(name, value = {}) { if (name === 'click' && this.disabled) return; return listeners.get(name)?.(value); }
      });
    }
    return elements.get(id);
  };
  const api = { init: async () => ({ success: true, labels: labelsFor('en'), session: { id: 'A', deviceId: 'hdc:fixture', status: 'streaming' } }),
    ready: async () => ({ success: true }), ack: async () => ({ success: true }), diagnostic: async value => diagnostics.push(value),
    input: async value => { calls.push(value); return reply(value, calls.length); }, stop: async () => { stopped++; return { success: true }; } };
  for (const name of ['onFrame', 'onState', 'onRecordCommand', 'onLocale', 'onRecordingState']) api[name] = callback => { callbacks[name] = callback; return () => {}; };
  const context = vm.createContext({
    document: { getElementById: element, documentElement: {}, querySelectorAll: () => [] },
    window: { harmonyMedia: api, addEventListener: (name, callback) => { lifecycle[name] = callback; } },
    ResizeObserver: class { observe() {} disconnect() {} }, performance: { now: () => clock },
    setCodecMessages() {}, createMediaRecorderController: () => ({ command() {}, dispose() {} }),
    createH264Decoder: options => { const decoder = { options, disposed: false, push() {}, dispose() { this.disposed = true; } }; decoders.push(decoder); return decoder; }
  });
  const source = fs.readFileSync(new URL('../electron/harmony-media-renderer.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
  vm.runInContext(source, context); await flush();
  const paint = (id = 'A') => decoders.at(-1).options.onFrame({ displayWidth: 640, displayHeight: 360 }, { sessionId: id, sequence: 0 });
  const toggle = checked => { element('control').checked = checked; element('control').fire('change'); };
  const tap = async () => {
    element('screen').fire('pointerdown', { button: 0, pointerId: 1, clientX: 180, clientY: 120 }); clock += 50;
    element('screen').fire('pointerup', { pointerId: 1, clientX: 180, clientY: 120 }); await flush();
  };
  return { api, calls, diagnostics, callbacks, decoders, lifecycle, element, tap, toggle, paint,
    tick: value => { clock += value; }, stopped: () => stopped, paints: () => paints };
}

test('real pointer mapping requires opt-in and a painted frame, preserving normalized tap/swipe coordinates', async () => {
  const h = await fixture(); await h.tap(); assert.equal(h.calls.length, 0);
  h.toggle(true); await h.tap(); assert.equal(h.calls.length, 0);
  h.paint(); await h.tap(); assert.equal(h.calls[0].type, 'tap'); assert.equal(h.calls[0].x, .5); assert.equal(h.calls[0].y, .5);
  h.element('screen').fire('pointerdown', { button: 0, pointerId: 7, clientX: 100, clientY: 75 }); h.tick(300);
  h.element('screen').fire('pointerup', { pointerId: 7, clientX: 260, clientY: 165 }); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1])), { type: 'swipe', x: .25, y: .25, endX: .75, endY: .75, durationMs: 300 });
  h.element('screen').fire('pointerdown', { button: 0, pointerId: 8, clientX: 100, clientY: 75 });
  h.element('screen').fire('pointercancel'); h.element('screen').fire('pointerup', { pointerId: 8, clientX: 100, clientY: 75 }); await flush();
  assert.equal(h.calls.length, 2); h.lifecycle.beforeunload();
});
test('pending input disables buttons but repeated canvas clicks reach native busy refusal and remain visible', async () => {
  const pending = deferred();
  const h = await fixture(async (_value, number) => number === 1 ? pending.promise : { success: false, code: 'INPUT_BUSY', error: 'RAW_PRIVATE' });
  h.toggle(true); h.paint(); await h.tap();
  for (const name of ['home', 'back', 'text', 'send']) assert.equal(h.element(name).disabled, true);
  assert.equal(h.element('control-status').textContent, 'en-sending');
  await h.tap(); assert.equal(h.calls.length, 2); assert.equal(h.element('control-status').textContent, 'en-busy');
  pending.resolve({ success: true }); await flush();
  assert.equal(h.element('control-status').hidden, true); assert.equal(h.element('home').disabled, false);
  assert.equal(h.stopped(), 0); h.lifecycle.beforeunload();
});
test('a delayed busy refusal cannot replace an earlier successful text completion with permanent busy state', async () => {
  const first = deferred(), repeated = deferred();
  const h = await fixture((_value, number) => number === 1 ? first.promise : repeated.promise);
  h.toggle(true); h.paint(); h.element('text').value = 'PRIVATE_INPUT'; h.element('send').fire('click'); await flush();
  await h.tap(); assert.equal(h.calls.length, 2);
  first.resolve({ success: true }); await flush();
  assert.equal(h.element('text').value, '', 'the real earlier success must still clear its submitted text');
  repeated.resolve({ success: false, code: 'INPUT_BUSY' }); await flush();
  assert.equal(h.element('control-status').hidden, true); assert.equal(h.element('home').disabled, false);
  assert.equal(h.stopped(), 0); h.lifecycle.beforeunload();
});
test('a delayed busy refusal cannot overwrite a real failure from the earlier executing request', async () => {
  const first = deferred(), repeated = deferred();
  const h = await fixture((_value, number) => number === 1 ? first.promise : repeated.promise);
  h.toggle(true); h.paint(); await h.tap(); await h.tap();
  first.resolve({ success: false, code: 'INPUT_HELP' }); await flush();
  repeated.resolve({ success: false, code: 'INPUT_BUSY' }); await flush();
  assert.equal(h.element('control-status').textContent, 'en-help-failed');
  assert.equal(h.element('control-status').dataset.error, 'true'); assert.equal(h.element('home').disabled, false);
  h.callbacks.onLocale(labelsFor('ja')); assert.equal(h.element('control-status').textContent, 'ja-help-failed');
  assert.equal(h.stopped(), 0); h.lifecycle.beforeunload();
});
test('typed control failures persist through video updates and retranslate without stopping video; success clears them', async () => {
  const h = await fixture(async (_value, number) => number === 1 ? { success: false, code: 'INPUT_HELP', error: 'RAW_PRIVATE' } : { success: true });
  h.toggle(true); h.paint(); await h.tap(); assert.equal(h.element('control-status').textContent, 'en-help-failed');
  h.callbacks.onState({ id: 'A', deviceId: 'hdc:fixture', status: 'streaming' }); h.paint();
  assert.equal(h.element('control-status').textContent, 'en-help-failed');
  h.callbacks.onLocale(labelsFor('ja')); assert.equal(h.element('control-status').textContent, 'ja-help-failed');
  assert.equal(h.stopped(), 0); assert.equal(h.decoders[0].disposed, false); assert.equal(h.paints(), 2);
  await h.tap(); assert.equal(h.element('control-status').hidden, true); h.lifecycle.beforeunload();
});
test('only fixed codes or recognized localized messages become descriptors; arbitrary errors and IPC exceptions stay private', async () => {
  const h = await fixture(async (_value, number) => {
    if (number === 1) return { success: false, error: 'en-help-failed' };
    if (number === 2) return { success: false, code: 'PRIVATE_CODE', error: 'PRIVATE_TEXT PRIVATE_COORDINATES' };
    throw Error('PRIVATE_COMMAND PRIVATE_PATH');
  });
  h.toggle(true); h.paint(); await h.tap(); h.callbacks.onLocale(labelsFor('ko'));
  assert.equal(h.element('control-status').textContent, 'ko-help-failed');
  await h.tap(); assert.equal(h.element('control-status').textContent, 'ko-safe-failure');
  await h.tap(); assert.equal(h.element('control-status').textContent, 'ko-safe-failure');
  assert.deepEqual(h.diagnostics, []); assert.equal(h.stopped(), 0); h.lifecycle.beforeunload();
});
test('control toggle clears errors and invalidates a late reply without silently cancelling an already submitted command', async () => {
  const pending = deferred(); const h = await fixture(() => pending.promise);
  h.toggle(true); h.paint(); await h.tap(); h.toggle(false); h.toggle(true);
  pending.resolve({ success: false, code: 'INPUT_HELP' }); await flush();
  assert.equal(h.element('control-status').hidden, true); assert.equal(h.calls.length, 1); assert.equal(h.stopped(), 0); h.lifecycle.beforeunload();
});
test('late old-session text replies cannot clear the current input or leak text to diagnostics', async () => {
  const pending = deferred(); const h = await fixture((_value, number) => number === 1 ? pending.promise : { success: true });
  h.toggle(true); h.paint(); h.element('text').value = 'PRIVATE_INPUT'; h.element('send').fire('click'); await flush();
  assert.equal(h.calls[0].text, 'PRIVATE_INPUT'); assert.deepEqual(h.diagnostics, []);
  h.callbacks.onState({ id: 'B', deviceId: 'hdc:new-fixture', status: 'streaming' }); h.paint('B');
  h.element('text').value = 'NEW_PRIVATE_INPUT'; pending.resolve({ success: true }); await flush();
  assert.equal(h.element('text').value, 'NEW_PRIVATE_INPUT'); assert.equal(h.element('control-status').hidden, true);
  h.element('send').fire('click'); await flush(); assert.equal(h.element('text').value, ''); assert.equal(h.stopped(), 0); h.lifecycle.beforeunload();
});
test('failed text remains available for correction, with no raw text in notices or diagnostics', async () => {
  const h = await fixture(async () => ({ success: false, code: 'INPUT_HELP', error: 'PRIVATE_INPUT' }));
  h.toggle(true); h.paint(); h.element('text').value = 'PRIVATE_INPUT'; h.element('send').fire('click'); await flush();
  assert.equal(h.element('text').value, 'PRIVATE_INPUT'); assert.equal(h.element('control-status').textContent, 'en-help-failed');
  assert.deepEqual(h.diagnostics, []); assert.equal(h.stopped(), 0); h.lifecycle.beforeunload();
});
test('unload ignores a pending control completion without rendering or stopping the video again', async () => {
  const pending = deferred(); const h = await fixture(() => pending.promise); h.toggle(true); h.paint(); await h.tap();
  const before = h.element('control-status').textContent; h.lifecycle.beforeunload();
  pending.resolve({ success: false, code: 'INPUT_HELP' }); await flush();
  assert.equal(h.element('control-status').textContent, before); assert.equal(h.stopped(), 0); assert.equal(h.decoders[0].disposed, true);
});
