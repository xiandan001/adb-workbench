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
function appUpdateFunctions() {
  const require = createRequire(import.meta.url), { parse } = require('@babel/parser'), traverse = require('@babel/traverse').default;
  const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8'), functions = {};
  traverse(parse(source, { sourceType: 'module', plugins: ['jsx'] }), { VariableDeclarator({ node }) {
    if (['handleManualUpdateCheck', 'handleInstallUpdate'].includes(node.id.name)) {
      const callback = node.init.arguments[0]; functions[node.id.name] = source.slice(callback.start, callback.end);
    }
  } });
  return { source, functions, parse, traverse };
}

test('cached ready state is restored after a renderer reload', async () => {
  const f = fixture(async () => ({ downloaded: true, checking: false, info: { version: '5.0.0' }, currentVersion: '4.7.2' }));
  await flush(); assert.equal(f.state().downloaded, true); assert.equal(f.state().info.version, '5.0.0');
  assert.equal(Object.hasOwn(f.state(), 'currentVersion'), false); f.stop();
});
test('installer startup state survives snapshots, live progress and failed-launch retry reset', async () => {
  const f = fixture(async () => ({ downloaded: true, installing: true }));
  await flush(); assert.equal(f.state().installing, true);
  f.emit({ eventName: 'state', payload: { installing: false, error: 'fixture retryable failure' } });
  assert.equal(f.state().installing, false); assert.equal(f.state().downloaded, true);
  f.emit({ eventName: 'state', payload: { installing: true, error: null } });
  assert.equal(f.state().installing, true); assert.equal(f.state().error, null); f.stop();
});
test('manual refresh keeps cached readiness only until a newer download is confirmed and carries refreshing throughout', async () => {
  const f = fixture(async () => ({ downloaded: true, refreshing: true, checking: true, info: { version: '4.7.23' } }));
  await flush(); assert.equal(f.state().refreshing, true); assert.equal(f.state().downloaded, true);
  f.emit({ eventName: 'state', payload: { downloaded: false, checking: false, downloading: true, refreshing: true, info: { version: '4.7.24' } } });
  assert.equal(f.state().downloaded, false); assert.equal(f.state().info.version, '4.7.24');
  f.emit({ eventName: 'download-progress', payload: { percent: 40 } }); assert.equal(f.state().progress.percent, 40);
  f.emit({ eventName: 'update-downloaded', payload: { version: '4.7.24' } });
  assert.equal(f.state().refreshing, true); assert.equal(f.state().downloaded, true); assert.equal(f.state().info.version, '4.7.24');
  f.emit({ eventName: 'state', payload: { refreshing: false } }); assert.equal(f.state().refreshing, false); f.stop();
});
test('failed latest-version checks preserve the valid cached package and clear refresh busy state', async () => {
  const f = fixture(async () => ({ downloaded: true, refreshing: true, checking: true, info: { version: '4.7.23' } })); await flush();
  f.emit({ eventName: 'state', payload: { refreshing: false, checking: false, error: 'fixture offline' } });
  assert.equal(f.state().downloaded, true); assert.equal(f.state().info.version, '4.7.23'); assert.equal(f.state().refreshing, false); f.stop();
});
test('manual check is single-flight in the same tick and all old install callbacks are blocked before state events arrive', async () => {
  const { functions } = appUpdateFunctions(); assert.ok(functions.handleManualUpdateCheck); assert.ok(functions.handleInstallUpdate);
  const pending = deferred(), calls = [], busy = [], reference = { current: false };
  let state = { downloaded: true, info: { version: '4.7.23' } };
  const sandbox = { manualUpdateCheckRef: reference, updateActionBusy: false, updaterState: state, tr: value => value,
    setManualUpdateChecking: value => busy.push(value), setUpdaterState: update => { state = update(state); },
    window: { electronAPI: { checkForUpdates: () => { calls.push('check'); return pending.promise; }, installUpdate: () => calls.push('install') } } };
  const check = runInNewContext(`(${functions.handleManualUpdateCheck})`, sandbox), install = runInNewContext(`(${functions.handleInstallUpdate})`, sandbox);
  const first = check(); await check(); install(); assert.deepEqual(calls, ['check']); assert.equal(reference.current, true);
  assert.equal(state.downloaded, true); assert.equal(state.info.version, '4.7.23');
  state = { ...state, downloaded: true, refreshing: false, info: { version: '4.7.24' } };
  pending.resolve({ success: true, available: true, info: { version: '4.7.24' } }); await first;
  assert.equal(reference.current, false); assert.deepEqual(busy, [true, false]); assert.equal(state.info.version, '4.7.24');
  sandbox.updaterState = state; install(); assert.deepEqual(calls, ['check', 'install']);
});
test('manual check rejection resets the local gate without discarding a usable cached package', async () => {
  const { functions } = appUpdateFunctions(); assert.ok(functions.handleManualUpdateCheck);
  let state = { downloaded: true, info: { version: '4.7.23' } }; const busy = [], reference = { current: false };
  const check = runInNewContext(`(${functions.handleManualUpdateCheck})`, { manualUpdateCheckRef: reference, updateActionBusy: false,
    setManualUpdateChecking: value => busy.push(value), setUpdaterState: update => { state = update(state); }, tr: value => value,
    window: { electronAPI: { checkForUpdates: async () => { throw Error('private fixture path must not leak'); } } } });
  await check(); assert.equal(reference.current, false); assert.deepEqual(busy, [true, false]);
  assert.equal(state.checking, false); assert.equal(state.error, '检查失败'); assert.equal(state.downloaded, true); assert.equal(state.info.version, '4.7.23');
});
test('settings, sidebar and modal install controls share refresh busy guards, and stale confirmation is hidden', () => {
  const { source, parse, traverse } = appUpdateFunctions(); const installs = [], others = []; let modal;
  traverse(parse(source, { sourceType: 'module', plugins: ['jsx'] }), {
    JSXElement({ node }) {
      if (node.openingElement.name.name !== 'button') return;
      const attributes = node.openingElement.attributes, click = attributes.find(item => item.name?.name === 'onClick')?.value?.expression;
      if (click?.name === 'handleInstallUpdate') installs.push(node);
      if (click?.name === 'handleManualUpdateCheck' || (click && source.slice(click.start, click.end).includes('setUpdateInstallModal(true)'))) others.push(node);
    },
    LogicalExpression({ node }) {
      if (node.right.type === 'JSXElement' && source.slice(node.right.start, node.right.end).includes('tr("安装更新并重启")')) modal = node.left;
    }
  });
  assert.equal(installs.length, 2); assert.equal(others.length, 2);
  for (const node of [...installs, ...others]) assert.equal(node.openingElement.attributes.find(item => item.name?.name === 'disabled')?.value?.expression?.name, 'updateActionBusy');
  assert.ok(modal);
  const visible = state => runInNewContext(source.slice(modal.start, modal.end), { updateInstallModal: true, updaterState: { downloaded: false }, updateInstalling: false, ...state });
  assert.equal(visible({}), false); assert.equal(visible({ updaterState: { downloaded: true } }), true); assert.equal(visible({ updateInstalling: true }), true);
});
test('the user-facing cached-refresh release note is translated once in each core catalog', () => {
  const key = '已下载更新后仍可检查并自动下载更新版本。';
  for (const prefix of ['en', 'tw', 'ja', 'ko']) {
    const source = readFileSync(new URL(`../electron/locales/${prefix}-core.json`, import.meta.url), 'utf8');
    assert.equal(source.split(JSON.stringify(key) + ':').length - 1, 1); assert.ok(JSON.parse(source)[key]);
  }
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
