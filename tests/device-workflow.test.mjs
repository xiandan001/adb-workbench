import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceStatusLabel, resolveActiveDeviceId, singleFlight, summarizePackageBatch } from '../src/shared/deviceWorkflow.js';

test('active device survives disconnect and never falls back to another online device', () => {
  const devices = [{ id: 'second', status: 'device' }];
  assert.equal(resolveActiveDeviceId('first', devices), 'first');
  assert.equal(resolveActiveDeviceId('', devices), 'second');
  assert.equal(resolveActiveDeviceId('first', []), 'first');
  assert.equal(deviceStatusLabel('unauthorized'), '未授权');
});

test('manual and automatic device refresh share the same in-flight request', async () => {
  let calls = 0;
  let finish;
  const refresh = singleFlight(() => {
    calls += 1;
    return new Promise(resolve => { finish = resolve; });
  });
  const first = refresh();
  const overlapping = refresh();
  assert.equal(first, overlapping);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish(['device']);
  assert.deepEqual(await first, ['device']);
  const next = refresh();
  await Promise.resolve();
  assert.equal(calls, 2);
  finish([]);
  await next;
});

test('failed refresh releases the single-flight guard', async () => {
  let calls = 0;
  const refresh = singleFlight(async () => {
    if (++calls === 1) throw new Error('offline');
    return [];
  });
  await assert.rejects(refresh, /offline/);
  assert.deepEqual(await refresh(), []);
});

test('batch results preserve each failed package and unknown outcomes', () => {
  const result = summarizePackageBatch(['app.ok', 'app.fail', 'app.missing'], {
    results: [{ packageName: 'app.ok', ok: true }, { packageName: 'app.fail', ok: false, error: 'permission denied' }]
  });
  assert.equal(result.successCount, 1);
  assert.deepEqual(result.failures.map(item => item.packageName), ['app.fail', 'app.missing']);
  assert.equal(result.failures[0].error, 'permission denied');
  assert.match(result.failures[1].error, /核实设备状态/);
});

test('batch request failure retains all selected packages without claiming success', () => {
  const result = summarizePackageBatch(['app.one', 'app.two'], { ok: false, error: 'device offline' });
  assert.equal(result.successCount, 0);
  assert.equal(result.failures.length, 2);
  assert.equal(result.failures[0].error, 'device offline');
});
