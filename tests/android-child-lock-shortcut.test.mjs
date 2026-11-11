import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { BUILTIN_SHORTCUTS, SHORTCUTS_KEY, defaultDeviceShortcuts, normalizeDeviceShortcuts, readDeviceShortcuts, createShortcutExecutor } from '../src/shared/deviceNavigationShortcuts.js';
const require = createRequire(import.meta.url);
const { createCapabilityService } = require('../electron/lib/device-shortcut-capabilities.cjs');
const backend = require('../electron/lib/device-shortcuts-policy.cjs');
const action = id => ({ id: 'slot-4', type: 'builtin', action: id, label: BUILTIN_SHORTCUTS.find(item => item.id === id)?.label || id });
const unlockCommand = 'input keyevent KEYCODE_VOLUME_DOWN KEYCODE_VOLUME_DOWN KEYCODE_VOLUME_UP KEYCODE_VOLUME_UP 2>&1';

test('Android factory shortcut changes only the fourth action and keeps selectable volume and whiteboard built-ins', () => {
  assert.deepEqual(defaultDeviceShortcuts().slots.map(slot => slot.action), ['home', 'sidebar', 'settings', 'childLockUnlock']);
  assert.deepEqual(defaultDeviceShortcuts('hdc:target').slots.map(slot => slot.action), ['home', 'back', 'settings', 'apps']);
  for (const id of ['childLockUnlock', 'volumeUp', 'volumeDown', 'whiteboard']) assert.ok(BUILTIN_SHORTCUTS.some(item => item.id === id));
  assert.equal(defaultDeviceShortcuts().version, 1); assert.equal(SHORTCUTS_KEY, 'adb-workbench.device-shortcuts.v1');
});

test('saved old factory choices, renamed whiteboard and reordered custom slots remain untouched', () => {
  const old = { version: 1, slots: ['home', 'sidebar', 'settings', 'whiteboard'].map((id, index) => ({ ...action(id), id: `slot-${index + 1}` })) };
  const renamed = structuredClone(old); renamed.slots[3].label = '会议白板';
  const reordered = structuredClone(renamed); reordered.slots.reverse();
  for (const value of [old, renamed, reordered]) {
    const raw = JSON.stringify(value), storage = { getItem: key => { assert.equal(key, SHORTCUTS_KEY); return raw; }, setItem: () => assert.fail('No automatic rewrite') };
    assert.deepEqual(readDeviceShortcuts(storage).config, value);
    assert.deepEqual(backend.normalizeDeviceShortcuts(value), value);
  }
});

test('unlock sends exactly the documented four short keys to the invoked device with no package/file/root access', async () => {
  const calls = [], run = createShortcutExecutor();
  const api = { adbShell: async (...args) => { calls.push(args); return { success: true, output: '' }; },
    packageLaunch: () => assert.fail('No app launch'), packageList: () => assert.fail('No package inventory') };
  assert.deepEqual(await run({ api, deviceId: 'USB-selected', shortcut: action('childLockUnlock') }), { ok: true });
  assert.deepEqual(calls, [['USB-selected', unlockCommand]]);
  assert.doesNotMatch(calls[0][1], /su\b|push\b|setprop|settings put|am broadcast|sleep|KEYCODE_POWER/);
});

test('volume built-ins are selectable single keyevents without adding back fixed common-tool buttons', async () => {
  const calls = [], run = createShortcutExecutor(), api = { adbShell: async (...args) => { calls.push(args); return { success: true }; } };
  for (const id of ['volumeUp', 'volumeDown']) await run({ api, deviceId: 'card-B', shortcut: action(id) });
  assert.deepEqual(calls, [['card-B', 'input keyevent KEYCODE_VOLUME_UP 2>&1'], ['card-B', 'input keyevent KEYCODE_VOLUME_DOWN 2>&1']]);
});

test('unlock command errors are not success and pending input suppresses repeated dispatch', async () => {
  const run = createShortcutExecutor(), shortcut = action('childLockUnlock'); let release, calls = 0;
  const pending = run({ api: { adbShell: () => { calls++; return new Promise(resolve => { release = resolve; }); } }, deviceId: 'A', shortcut });
  assert.deepEqual(await run({ api: {}, deviceId: 'A', shortcut }), { skipped: true });
  release({ success: false, error: 'device offline' }); await assert.rejects(pending, /offline/); assert.equal(calls, 1);
  await assert.rejects(run({ api: { adbShell: async () => ({ success: true, output: 'java.lang.SecurityException: denied' }) }, deviceId: 'A', shortcut }), /denied/);
});

test('vendor child-lock capability stays unknown and preflight never sends the keys', async () => {
  const value = defaultDeviceShortcuts();
  value.slots = ['home', 'back', 'recents', 'childLockUnlock'].map((id, index) => ({ ...action(id), id: `slot-${index + 1}` }));
  const result = await createCapabilityService({ run: () => assert.fail('No mutating or speculative device probe') }).check({ deviceId: 'A', config: value });
  assert.equal(result.success, true);
  assert.equal(result.checks[3].status, 'unknown'); assert.match(result.checks[3].reason, /设备需支持音量组合键/);
  const volumes = structuredClone(value); volumes.slots[2] = { ...action('volumeUp'), id: 'slot-3' }; volumes.slots[3] = action('volumeDown');
  assert.deepEqual(normalizeDeviceShortcuts(volumes), backend.normalizeDeviceShortcuts(volumes));
  const checked = await createCapabilityService({ run: () => assert.fail('No probe for standard keys') }).check({ deviceId: 'A', config: volumes });
  assert.deepEqual(checked.checks.map(item => item.status), ['supported', 'supported', 'supported', 'supported']);
});

test('Harmony cannot accidentally receive any newly added Android key action', async () => {
  const run = createShortcutExecutor(), api = { adbShell: () => assert.fail('No Android command to HDC'), packageList: () => assert.fail('No inventory') };
  for (const id of ['childLockUnlock', 'volumeUp', 'volumeDown']) await assert.rejects(run({ api, deviceId: 'hdc:A', shortcut: action(id) }), /适用于 Android/);
});
