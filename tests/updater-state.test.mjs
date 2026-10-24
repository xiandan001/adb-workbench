import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { observeUpdaterState } from '../src/shared/updaterState.js';
const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(snapshot = async () => ({})) {
  let state = { checking: false, downloading: false, downloaded: false }, emit, detached = false;
  const stop = observeUpdaterState({ onUpdaterEvent: callback => { emit = callback; return () => { detached = true; }; }, getUpdaterStatus: snapshot }, update => { state = update(state); });
  return { stop, emit: value => emit(value), state: () => state, detached: () => detached };
}

test('cached ready state is restored after a renderer reload', async () => {
  const f = fixture(async () => ({ downloaded: true, checking: false, info: { version: '5.0.0' }, currentVersion: '4.7.2' }));
  await flush(); assert.equal(f.state().downloaded, true); assert.equal(f.state().info.version, '5.0.0');
  assert.equal(Object.hasOwn(f.state(), 'currentVersion'), false); f.stop();
});
test('a delayed snapshot cannot overwrite a newer automatic check or download event', async () => {
  const pending = deferred(), f = fixture(() => pending.promise); await flush();
  f.emit({ eventName: 'state', payload: { checking: true, error: null } });
  pending.resolve({ checking: false, notAvailable: true }); await flush(); assert.equal(f.state().checking, true);
  f.emit({ eventName: 'state', payload: { checking: false, notAvailable: true } }); assert.equal(f.state().notAvailable, true); f.stop();
});
test('legacy download events remain usable and late progress cannot erase readiness', async () => {
  const f = fixture(); await flush();
  f.emit({ eventName: 'download-progress', payload: { percent: 50 } }); assert.equal(f.state().downloading, true);
  f.emit({ eventName: 'update-downloaded', payload: { version: '5.0.0' } });
  f.emit({ eventName: 'download-progress', payload: { percent: 99 } });
  assert.equal(f.state().downloaded, true); assert.equal(f.state().downloading, false); f.stop();
});
test('unmount removes the listener and ignores pending snapshot and event results', async () => {
  const pending = deferred(), f = fixture(() => pending.promise); await flush(); const before = f.state();
  f.stop(); pending.resolve({ downloaded: true }); f.emit({ eventName: 'state', payload: { checking: true } }); await flush();
  assert.equal(f.state(), before); assert.equal(f.detached(), true);
});
test('the preference configures only the main scheduler and cleanup never disables a remounted owner', async () => {
  const require = createRequire(import.meta.url), { parse } = require('@babel/parser'), traverse = require('@babel/traverse').default;
  const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8'); let effect;
  traverse(parse(source, { sourceType: 'module', plugins: ['jsx'] }), { CallExpression({ node }) {
    if (node.callee.name === 'useEffect' && source.slice(node.arguments[0].start, node.arguments[0].end).includes('configureAutoUpdates')) effect = node;
  } });
  assert.ok(effect); assert.deepEqual(effect.arguments[1].elements.map(value => value.name), ['autoUpdateEnabled']);
  const body = source.slice(effect.arguments[0].start, effect.arguments[0].end);
  assert.doesNotMatch(body, /setTimeout|setInterval|checkForUpdates|downloadUpdate/);
  const pending = deferred(), calls = [], updates = [];
  const context = { window: { electronAPI: { configureAutoUpdates: enabled => { calls.push(enabled); return pending.promise; } } }, autoUpdateEnabled: true, setUpdaterState: value => updates.push(value), tr: value => value };
  const callback = runInNewContext(`(${body})`, context); const cleanup = callback(); await flush(); cleanup();
  pending.resolve({ success: false, error: 'fixture failure' }); await flush();
  assert.deepEqual(calls, [true]); assert.equal(updates.length, 0);
});
