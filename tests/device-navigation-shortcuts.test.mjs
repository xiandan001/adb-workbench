import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { SHORTCUTS_KEY, defaultDeviceShortcuts, normalizeDeviceShortcuts, readDeviceShortcuts, saveDeviceShortcuts, createShortcutExecutor } from '../src/shared/deviceNavigationShortcuts.js';
import { collectMigrationPreferences, applyMigrationPreferences } from '../src/shared/dataMigrationStorage.js';
const require = createRequire(import.meta.url);
const backend = require('../electron/lib/device-shortcuts-policy.cjs');
const migration = require('../electron/lib/data-migration-policy.cjs');
const config = change => { const value = defaultDeviceShortcuts(); if (change) change(value); return value; };
const storage = (raw = null) => ({ raw, writes: 0, getItem(key) { return key === SHORTCUTS_KEY ? this.raw : null; }, setItem(key, value) { assert.equal(key, SHORTCUTS_KEY); this.raw = value; this.writes++; } });
const app = { id: 'slot-2', label: '常用应用', type: 'app', packageName: 'com.example.app' };
const shell = { id: 'slot-3', label: '回到桌面', type: 'shell', command: 'rm -rf /data/local/tmp/example' };

test('four global slots retain default actions and accept reordered builtins apps and advanced shell', () => {
  const defaults = defaultDeviceShortcuts();
  assert.deepEqual(defaults.slots.map(slot => slot.action), ['home', 'sidebar', 'settings', 'whiteboard']);
  const custom = config(value => { value.slots[1] = app; value.slots[2] = shell; value.slots.reverse(); });
  assert.deepEqual(normalizeDeviceShortcuts(custom), custom);
  assert.deepEqual(backend.normalizeDeviceShortcuts(custom), custom);
  assert.notEqual(defaults.slots, defaultDeviceShortcuts().slots);
});

test('frontend and backend reject identical invalid shapes, duplicate IDs/operations and unsafe fields', () => {
  const invalid = [null, [], { version: 2, slots: [] }, config(value => { value.extra = true; }),
    config(value => value.slots.pop()), config(value => { value.slots[0].id = value.slots[1].id; }),
    config(value => { value.slots[1].action = 'home'; }), config(value => { value.slots[0].action = 'root'; }),
    config(value => { value.slots[0].label = ''; }), config(value => { value.slots[0].label = 'a'.repeat(17); }),
    config(value => { value.slots[0].label = 'home\nrm'; }), config(value => { value.slots[0].command = 'reboot'; }),
    config(value => { value.slots[1] = { ...app, packageName: 'com.example.app;reboot' }; }),
    ...['echo x; reboot', 'echo x && reboot', 'cat /etc/a | sh', 'echo $(reboot)', 'echo `reboot`', 'echo x\nreboot', 'echo x > /data/a', ''].map(command => config(value => { value.slots[2] = { ...shell, command }; })),
    config(value => { value.slots[0].type = '__proto__'; }),
    JSON.parse('{"version":1,"slots":[],"__proto__":{}}')];
  for (const value of invalid) {
    assert.throws(() => normalizeDeviceShortcuts(value));
    assert.throws(() => backend.normalizeDeviceShortcuts(value));
    assert.throws(() => migration.normalizePreferences({ [SHORTCUTS_KEY]: JSON.stringify(value) }));
    assert.throws(() => applyMigrationPreferences({ [SHORTCUTS_KEY]: JSON.stringify(value) }, storage()));
  }
});

test('missing settings read defaults without writing, corrupt settings remain untouched until explicit reset', () => {
  const empty = storage();
  assert.deepEqual(readDeviceShortcuts(empty).config, defaultDeviceShortcuts());
  assert.equal(empty.writes, 0);
  const corrupt = storage('{invalid');
  assert.equal(readDeviceShortcuts(corrupt).config, null);
  assert.match(readDeviceShortcuts(corrupt).error, /原配置未改动/);
  assert.equal(corrupt.raw, '{invalid');
  saveDeviceShortcuts(defaultDeviceShortcuts(), corrupt, () => {});
  assert.deepEqual(readDeviceShortcuts(corrupt).config, defaultDeviceShortcuts());
});

test('sparse slot arrays are invalid in both validators', () => {
  const value = { version: 1, slots: new Array(4) };
  assert.throws(() => normalizeDeviceShortcuts(value));
  assert.throws(() => backend.normalizeDeviceShortcuts(value));
});

test('save notifies only after successful persistence and rejects invalid data without writes', () => {
  const saved = storage(); let notifications = 0;
  saveDeviceShortcuts(defaultDeviceShortcuts(), saved, () => { notifications++; });
  assert.equal(saved.writes, 1); assert.equal(notifications, 1);
  assert.throws(() => saveDeviceShortcuts({}, saved, () => { notifications++; }));
  assert.equal(saved.writes, 1); assert.equal(notifications, 1);
  saved.setItem = () => { throw new Error('quota'); };
  assert.throws(() => saveDeviceShortcuts(defaultDeviceShortcuts(), saved, () => { notifications++; }), /quota/);
  assert.equal(notifications, 1);
});

test('migration round trip preserves all four operations and performs no execution', () => {
  const original = config(value => { value.slots[1] = app; value.slots[2] = shell; });
  const source = storage(JSON.stringify(original));
  const exported = collectMigrationPreferences(source);
  const portable = migration.normalizePreferences(exported);
  const target = storage();
  applyMigrationPreferences(portable, target);
  assert.deepEqual(readDeviceShortcuts(target).config, original);
  assert.equal(target.writes, 1);
});

test('builtins and apps target the invoked card device, vendor probe failure offers replacement', async () => {
  const calls = [];
  const api = { adbShell: async (...args) => { calls.push(args); return { success: true, output: '' }; },
    packageLaunch: async args => { calls.push(args); return { ok: true }; } };
  const run = createShortcutExecutor();
  await run({ api, deviceId: 'card-B', shortcut: config().slots[0] });
  assert.deepEqual(calls[0], ['card-B', 'input keyevent KEYCODE_HOME 2>&1']);
  await run({ api, deviceId: 'card-C', shortcut: app });
  assert.deepEqual(calls[1], { deviceId: 'card-C', packageName: app.packageName });
  await assert.rejects(run({ api, deviceId: 'card-B', shortcut: config().slots[1] }), /编辑此按钮替换/);
  assert.deepEqual(calls[2], ['card-B', 'pm path com.xbh.navisetting']);
  assert.equal(calls.length, 3);
});

test('shell execution always requires confirmation of full command and device irrespective of safe-looking label', async () => {
  let calls = 0; let prompts = 0;
  const api = { adbShell: async () => { calls++; return { success: true }; } };
  const run = createShortcutExecutor();
  const args = { api, deviceId: 'card-A', shortcut: shell };
  assert.deepEqual(await run(args), { cancelled: true });
  assert.deepEqual(await run({ ...args, confirmShell: async request => { prompts++; assert.deepEqual(request, { deviceId: 'card-A', command: shell.command, label: shell.label }); return false; } }), { cancelled: true });
  assert.equal(calls, 0);
  await run({ ...args, confirmShell: async () => { prompts++; return true; } });
  await run({ ...args, confirmShell: async () => { prompts++; return true; } });
  assert.equal(calls, 2); assert.equal(prompts, 3);
});

test('executor locks repeated clicks through confirmation and execution and unlocks after failure', async () => {
  let release; let calls = 0;
  const run = createShortcutExecutor();
  const api = { adbShell: async () => { calls++; throw new Error('offline'); } };
  const args = { api, deviceId: 'card-A', shortcut: shell, confirmShell: () => new Promise(resolve => { release = resolve; }) };
  const pending = run(args);
  assert.deepEqual(await run(args), { skipped: true });
  release(true);
  await assert.rejects(pending, /offline/);
  assert.equal(calls, 1);
  assert.deepEqual(await run({ ...args, confirmShell: async () => false }), { cancelled: true });
});

test('malformed operation never executes and Android error output is not treated as success', async () => {
  let calls = 0;
  const run = createShortcutExecutor();
  const api = { adbShell: async () => { calls++; return { success: true, output: 'Error: unavailable' }; } };
  await assert.rejects(run({ api, deviceId: 'card-A', shortcut: { ...shell, command: 'reboot; reboot' }, confirmShell: async () => true }));
  assert.equal(calls, 0);
  await assert.rejects(run({ api, deviceId: 'card-A', shortcut: config().slots[0] }), /unavailable/);
  assert.equal(calls, 1);
});
