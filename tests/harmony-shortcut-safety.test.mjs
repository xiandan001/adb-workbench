import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as shortcuts from '../src/shared/deviceNavigationShortcuts.js';
import { tr } from '../src/shared/i18n.js';
const require = createRequire(import.meta.url), { parse } = require('@babel/parser'), traverse = require('@babel/traverse').default;
const power = { id: 'slot-4', type: 'builtin', action: 'power', label: '自定义电源名称' };
const apps = { id: 'slot-4', type: 'builtin', action: 'apps', label: '应用管理' };
const component = readFileSync(new URL('../src/components/DeviceNavigationControls.jsx', import.meta.url), 'utf8');
const ast = parse(component, { sourceType: 'module', plugins: ['jsx'] });
function expression(name, context) {
  let found; traverse(ast, { VariableDeclarator({ node }) { if (node.id.name === name) found = node.init; } });
  assert.ok(found, name); return runInNewContext(`(${component.slice(found.start, found.end)})`, { ...shortcuts, tr, ...context });
}
test('Harmony built-in Power rejects before any API access, while explicit Android Power still works', async () => {
  const calls = [], api = { adbShell: async (...args) => { calls.push(args); return { success: true }; } };
  const run = shortcuts.createShortcutExecutor();
  await assert.rejects(run({ deviceId: 'hdc:A', shortcut: power, api }), /电源控制已停用/);
  assert.deepEqual(calls, []);
  await run({ deviceId: 'android-A', shortcut: power, api });
  assert.deepEqual(calls, [['android-A', 'input keyevent KEYCODE_POWER 2>&1']]);
});
test('saved Power labels and semantics are retained without a silent migration or storage write', () => {
  const saved = shortcuts.defaultDeviceShortcuts('hdc:A'); saved.slots[3] = power;
  const raw = JSON.stringify(saved), storage = { getItem: key => key === shortcuts.HARMONY_SHORTCUTS_KEY ? raw : null, setItem: () => assert.fail('No automatic rewrite') };
  const loaded = shortcuts.readDeviceShortcuts(storage, 'hdc:A');
  assert.deepEqual(loaded.config.slots[3], power);
  assert.equal(shortcuts.defaultDeviceShortcuts('hdc:A').slots[3].action, 'apps');
  assert.deepEqual(shortcuts.defaultDeviceShortcuts().slots.map(item => item.action), ['home', 'sidebar', 'settings', 'childLockUnlock']);
});
test('Power is disabled synchronously in the real rendering path before asynchronous capability results', () => {
  for (const checks of [[], [{ id: power.id, status: 'supported', reason: 'stale prior probe' }]]) {
    const context = { deviceId: 'hdc:A', action: power, checks };
    const check = expression('check', context);
    assert.equal(check.status, 'unsupported'); assert.match(check.reason, /编辑替换/);
    assert.equal(expression('unsupported', { ...context, check }), true);
  }
});
test('local app manager shortcut invokes only the clicked card callback and does not need an Electron API', async () => {
  let opened = 0;
  const api = new Proxy({}, { get() { assert.fail('No ADB/HDC/package API access for local navigation'); } });
  const run = shortcuts.createShortcutExecutor();
  assert.deepEqual(await run({ deviceId: 'hdc:A', shortcut: apps, api, onOpenApps: () => { opened++; } }), { ok: true, local: true });
  assert.equal(opened, 1);
  await assert.rejects(run({ deviceId: 'hdc:A', shortcut: apps, api }), /应用管理入口不可用/);
  const card = readFileSync(new URL('../src/components/DeviceCard.jsx', import.meta.url), 'utf8');
  assert.match(card, /<DeviceNavigationControls\b[^>]*onOpenApps=\{onApkManager\}/);
});
test('real Controls handler opens local apps without a misleading sent-command toast', async () => {
  let opened = 0; const toasts = [];
  const run = expression('runAction', { deviceId: 'hdc:A', isOnline: true, busyRef: { current: false },
    executor: { current: shortcuts.createShortcutExecutor() }, window: { electronAPI: new Proxy({}, { get() { assert.fail('No device commands'); } }) },
    onOpenApps: () => { opened++; }, confirmShell: () => assert.fail('No shell confirmation'),
    setError() {}, setPending() {}, editing: false, showToast: value => toasts.push(value), deviceShortcutDisplayLabel: action => action.label });
  await run(apps); assert.equal(opened, 1); assert.deepEqual(toasts, []);
});
test('backend native capabilities mark Power unsupported and app management local without device probes', async () => {
  const filename = new URL('../electron/lib/device-shortcut-capabilities.cjs', import.meta.url), realRequire = createRequire(filename);
  const module = { exports: {} }; let calls = 0;
  runInNewContext(readFileSync(filename, 'utf8'), { module, require(name) {
    if (name === './adb-runtime.cjs') return { runAdb: () => { calls++; assert.fail('No ADB'); } };
    if (name === './device-registry.cjs') return { resolveDeviceRef: () => ({ transport: 'hdc', status: 'device', capabilities: { ui: true } }) };
    if (name === './harmony-apps.cjs') return { listPackages: () => { calls++; assert.fail('No HDC package probe'); } };
    return realRequire(name);
  } });
  const config = { version: 1, slots: [
    { id: 'slot-1', label: 'Home', type: 'builtin', action: 'home' }, { id: 'slot-2', label: 'Back', type: 'builtin', action: 'back' },
    { ...apps, id: 'slot-3' }, power
  ] };
  const result = await module.exports.createCapabilityService().check({ deviceId: 'hdc:A', config });
  assert.equal(result.success, true); assert.equal(result.checks.find(item => item.id === power.id).status, 'unsupported');
  assert.equal(result.checks.find(item => item.id === 'slot-3').status, 'supported'); assert.equal(calls, 0);
});
