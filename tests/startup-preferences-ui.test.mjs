import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../src/components/StartupPreferences.jsx', import.meta.url), 'utf8');
const ast = require('@babel/parser').parse(source, { sourceType: 'module', plugins: ['jsx'] });
function callback(name, context) {
  let selected;
  require('@babel/traverse').default(ast, {
    FunctionDeclaration({ node }) { if (node.id?.name === name) selected = node; },
    VariableDeclarator({ node }) { if (node.id?.name === name) selected = node.init?.callee?.name === 'useCallback' ? node.init.arguments[0] : node.init; },
  });
  assert.ok(selected, `missing real callback ${name}`);
  context.tr = (message, params = {}) => message.replace(/\{(\d+)\}/g, (token, index) => Object.hasOwn(params, index) ? String(params[index] ?? '') : token);
  return runInNewContext(`(${source.slice(selected.start, selected.end)})`, context);
}
const defaults = () => ({ version: 1, reducedMotion: false, startupAnimation: true });
const state = (enabled = true, mode = 'development') => ({ enabled, preferredEnabled: enabled, registered: mode === 'packaged' ? enabled : null, initialized: true, mode, message: mode === 'development' ? '开发/验证模式仅保存选择，不修改系统启动项' : 'Fixture state' });
const response = (enabled = true, mode) => ({ success: true, result: state(enabled, mode) });
function startupHarness(api, initial = state()) {
  const observed = { startup: initial, loading: false, saving: false, error: '', writes: 0 };
  const context = { api, startup: initial, operation: { current: { generation: 0, busy: false } }, mounted: { current: true },
    setStartup(value) { observed.startup = value; observed.writes++; }, setStartupLoading(value) { observed.loading = value; },
    setStartupSaving(value) { observed.saving = value; }, setStartupError(value) { observed.error = value; },
    startupSettingsResult: callback('startupSettingsResult', {}),
  };
  return { context, observed, load: callback('loadStartup', context), save: callback('saveStartup', context) };
}
test('initial motion reads are safe and corrupt storage remains untouched until an explicit repair', () => {
  let writes = 0;
  const good = callback('initialMotionState', { readUiMotionPreferences: defaults, defaultUiMotionPreferences: defaults });
  assert.deepEqual(structuredClone(good()), { value: defaults(), error: '' });
  const bad = callback('initialMotionState', { readUiMotionPreferences() { throw new Error('corrupt fixture'); }, defaultUiMotionPreferences: defaults, saveUiMotionPreferences() { writes++; } });
  assert.deepEqual(structuredClone(bad().value), defaults()); assert.match(bad().error, /corrupt/); assert.equal(writes, 0);
});
test('motion save only updates on persistence success and merges the latest other option', () => {
  let value = defaults(); let notice = ''; const writes = [];
  const context = { motionSaving: { current: false }, motion: { value: defaults(), error: '' },
    readUiMotionPreferences: () => ({ ...defaults(), startupAnimation: false }),
    saveUiMotionPreferences(next) { writes.push(next); return next; },
    setMotion(next) { value = typeof next === 'function' ? next(value) : next; }, setMotionNotice(next) { notice = next; },
  };
  callback('saveMotion', context)('reducedMotion', true);
  assert.equal(value.value.reducedMotion, true); assert.equal(value.value.startupAnimation, false); assert.match(notice, /立即生效/);
  assert.equal(writes.length, 1); assert.equal(context.motionSaving.current, false);
  value = { value: defaults(), error: '' }; context.saveUiMotionPreferences = () => { throw new Error('disk full'); };
  callback('saveMotion', context)('startupAnimation', false);
  assert.equal(value.value.startupAnimation, true); assert.match(value.error, /disk full/); assert.equal(notice, '');
});
test('a valid explicit motion choice repairs corrupt input without silently changing the other confirmed option', () => {
  let observed;
  const context = { motionSaving: { current: false }, motion: { value: { ...defaults(), startupAnimation: false }, error: 'bad' },
    readUiMotionPreferences() { throw new Error('invalid stored JSON'); }, saveUiMotionPreferences: value => value,
    setMotion: value => { observed = value; }, setMotionNotice() {},
  };
  callback('saveMotion', context)('reducedMotion', true);
  assert.deepEqual(structuredClone(observed), { value: { version: 1, reducedMotion: true, startupAnimation: false }, error: '' });
});
test('native loading validates a real result and never treats missing or malformed APIs as confirmed state', async () => {
  const valid = startupHarness({ startupSettingsGet: async () => response(false) }, null); await valid.load(); assert.equal(valid.observed.startup.enabled, false); assert.equal(valid.observed.loading, false);
  for (const api of [{}, { startupSettingsGet: async () => ({ success: true, result: { enabled: 'true' } }) }, { startupSettingsGet: async () => ({ success: false, error: { message: 'fixture read failed' } }) }]) {
    const f = startupHarness(api, null); await f.load(); assert.equal(f.observed.startup, null); assert.ok(f.observed.error); assert.equal(f.observed.writes, 0); assert.equal(f.context.operation.current.busy, false);
  }
});
test('startup preference saves are single-flight and update only after acknowledged success', async () => {
  let resolve; let calls = 0; const args = [];
  const f = startupHarness({ startupSettingsSet(value) { calls++; args.push(value); return new Promise(done => { resolve = done; }); } });
  const request = f.save(false); assert.equal(f.observed.saving, true); assert.equal(f.observed.startup.enabled, true);
  await f.save(true); await f.load(); assert.equal(calls, 1);
  resolve(response(false)); await request;
  assert.equal(f.observed.startup.enabled, false); assert.equal(f.observed.saving, false); assert.equal(f.context.operation.current.busy, false);
  assert.deepEqual(structuredClone(args), [{ enabled: false }]);
});
test('native save failure keeps the previously confirmed checkbox even if failure metadata exists', async () => {
  const f = startupHarness({ startupSettingsSet: async () => ({ success: false, error: { message: 'fixture OS denied' }, result: state(false) }) });
  await f.save(false); assert.equal(f.observed.startup.enabled, true); assert.equal(f.observed.writes, 0); assert.match(f.observed.error, /OS denied/); assert.equal(f.observed.saving, false);
});
test('unmount and a subsequent load discard the old completion without unlocking the new request', async () => {
  const pending = []; const f = startupHarness({ startupSettingsGet: () => new Promise(resolve => pending.push(resolve)) }, null);
  const first = f.load(); f.context.mounted.current = false; f.context.operation.current.generation++; f.context.operation.current.busy = false;
  f.context.mounted.current = true; const second = f.load(); pending[0](response(false)); await first;
  assert.equal(f.observed.startup, null); assert.equal(f.context.operation.current.busy, true); assert.equal(f.observed.loading, true);
  pending[1](response(true)); await second; assert.equal(f.observed.startup.enabled, true); assert.equal(f.context.operation.current.busy, false);
  let finish; const saving = startupHarness({ startupSettingsSet: () => new Promise(resolve => { finish = resolve; }) });
  const request = saving.save(false); saving.context.mounted.current = false; saving.context.operation.current.generation++; finish(response(false)); await request; assert.equal(saving.observed.startup.enabled, true);
});
test('development mode clearly distinguishes a saved preference from actual system registration', () => {
  const describe = callback('startupDescription', {});
  assert.match(describe(state(true)), /仅保存选择.*不修改系统启动项/);
  assert.match(describe({ ...state(false), message: '' }), /开发.*不修改系统启动项/);
  assert.match(describe({ ...state(true, 'unsupported'), message: '' }), /不支持系统启动项/);
});
test('three compact switches are native accessible controls in Appearance, and settings scrolling honors reduced motion', () => {
  assert.match(source, /role="switch" type="checkbox"/); assert.match(source, /aria-describedby/);
  for (const title of ['减少动态效果', '启动动画', '开机自启']) assert.ok(source.includes(`title={tr("${title}")}`));
  assert.match(source, /系统的“减少动态效果”设置始终优先/); assert.match(source, /下次启动生效/);
  assert.match(source, /UI_MOTION_CHANGED/); assert.match(source, /UI_MOTION_PREFS_KEY/); assert.doesNotMatch(source, /localStorage\.setItem|setLoginItemSettings|showMessageBox/);
  const app = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /settings-appearance[\s\S]*?<StartupPreferences theme=\{t\} isDark=\{isDark\}/);
  assert.match(app, /scrollIntoView\(\{ behavior: preferredScrollBehavior\(\)/);
});
