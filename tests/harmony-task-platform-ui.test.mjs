import test from 'node:test';
import assert from 'node:assert/strict';
import { taskPlatformForDevice, taskPlatformMismatch, adaptPristineBuiltin, createHarmonyTaskTemplate } from '../src/shared/taskPlatform.js';

test('new Harmony templates are native without silently changing existing Android scripts', () => {
  assert.equal(taskPlatformForDevice('hdc:USB-1'), 'harmony');
  assert.equal(taskPlatformForDevice('192.168.1.1:5555'), 'android');
  assert.equal(taskPlatformMismatch({}, ['hdc:USB-1']), true);
  const seed = { id: 'new', steps: [], loop: { count: 1 } };
  const result = createHarmonyTaskTemplate('install-launch', seed, type => ({ id: type, type }));
  assert.equal(result.targetPlatform, 'harmony');
  assert.equal(result.mode, 'stress');
  assert.equal(result.steps[0].type, 'installApk');
  assert.ok(result.steps.some(step => step.type === 'launchApp'));
  assert.doesNotMatch(JSON.stringify(result), /monkey|logcat|EntryAbility|getprop/);
  assert.deepEqual(seed.steps, []);
  assert.equal(createHarmonyTaskTemplate('launch', seed, type => ({ id: type, type })).loop.count, 10);
  assert.equal(createHarmonyTaskTemplate('record', seed, type => ({ id: type, type })).mode, 'replay');
  const original = { id: 'default-smoke-test', createdAt: 'builtin', updatedAt: 'builtin', steps: [{ type: 'shell', command: 'getprop ro.product.model' }] };
  assert.equal(adaptPristineBuiltin(original, 'hdc:A').steps[0].command, 'param get const.product.model');
  assert.equal(original.steps[0].command, 'getprop ro.product.model');
  assert.equal(adaptPristineBuiltin({ ...original, updatedAt: 'user-edit' }, 'hdc:A'), null);
  assert.equal(adaptPristineBuiltin({ ...original, id: 'user-script' }, 'hdc:A'), null);
});
