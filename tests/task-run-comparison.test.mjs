import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { compareTaskRuns, runDuration } from '../src/shared/taskRunComparison.js';

const require = createRequire(import.meta.url);
const { createRunComparisonIdentity, deviceComparisonIdentity } = require('../electron/lib/task-run-manifest.cjs');
const script = {
  id: 'script-one', name: '录制打开应用', mode: 'replay', continueOnError: true,
  steps: [{ id: 'tap', label: '点击图标', type: 'tap', x: 10, y: 20 }, { id: 'check', label: '验证页面', type: 'assertText', text: '首页' }]
};
const identity = deviceComparisonIdentity({ androidId: 'a1b2c3d4e5f67890', roSerialno: 'unique-device-a' });
const makeStep = (index, status) => ({
  ...script.steps[index], index, status,
  startedAt: '2026-10-21T00:00:00.000Z', endedAt: '2026-10-21T00:00:01.000Z', artifact: `evidence-${index}.png`
});
const makeRun = (id, statuses = ['success', 'failed']) => ({
  id, mode: 'replay', status: 'failed', ...createRunComparisonIdentity(script),
  startedAt: '2026-10-21T00:00:00.000Z', endedAt: '2026-10-21T00:00:03.000Z',
  deviceRuns: [{ deviceId: '192.168.1.8:5555', comparisonIdentity: identity, steps: statuses.map((status, index) => makeStep(index, status)) }]
});

test('canonical script hash ignores object insertion order and metadata, but includes behavior and run options', () => {
  const expected = createRunComparisonIdentity(script);
  const reordered = { ...script, name: '改名', updatedAt: 'later', steps: script.steps.map(step => Object.fromEntries(Object.entries(step).reverse())) };
  assert.equal(createRunComparisonIdentity(reordered).scriptHash, expected.scriptHash);
  assert.notEqual(createRunComparisonIdentity({ ...script, steps: [{ ...script.steps[0], x: 30 }, script.steps[1]] }).scriptHash, expected.scriptHash);
  assert.notEqual(createRunComparisonIdentity(script, { continueOnError: false }).scriptHash, expected.scriptHash);
  assert.notEqual(createRunComparisonIdentity(script, { concurrency: 2 }).scriptHash, expected.scriptHash);
  assert.equal(createRunComparisonIdentity(script, { concurrency: 8 }).scriptHash, createRunComparisonIdentity(script, { concurrency: 4 }).scriptHash);
});

test('device identity stores only digests and ignores address, model, and common placeholder values', () => {
  assert.deepEqual(deviceComparisonIdentity({ adbId: 'same-ip', model: 'Same Model', roSerialno: '0123456789ABCDEF', androidId: '9774d56d682e549c', wifiMac: '02:00:00:00:00:00' }), {});
  assert.equal(identity.roSerialno.length, 64);
  assert.ok(!JSON.stringify(identity).includes('unique-device-a'));
});

test('comparison matches step identity and devices across ADB address changes, retaining both evidence paths', () => {
  const before = makeRun('old');
  const after = makeRun('new', ['failed', 'success']);
  after.deviceRuns[0].deviceId = 'new-usb-address';
  after.deviceRuns[0].steps[0].endedAt = '2026-10-21T00:00:02.000Z';
  const result = compareTaskRuns(before, after);
  assert.equal(result.comparable, true);
  assert.equal(result.newFailures, 1);
  assert.equal(result.recovered, 1);
  assert.equal(result.steps[0].deltaMs, 1000);
  assert.equal(result.steps[0].before.artifact, 'evidence-0.png');
  assert.equal(result.steps[0].after.artifact, 'evidence-0.png');
});

test('same name or address never bypasses missing versions, changed script/settings, or conflicting device identity', () => {
  const before = makeRun('old');
  for (const patch of [{ comparisonVersion: undefined }, { scriptId: 'other' }, { scriptHash: 'changed' }, { mode: 'stress' }, { status: 'running' }]) {
    assert.equal(compareTaskRuns(before, { ...makeRun('new'), ...patch }).comparable, false);
  }
  const unknown = makeRun('new');
  unknown.deviceRuns[0].comparisonIdentity = {};
  assert.equal(compareTaskRuns(before, unknown).comparable, false);
  unknown.deviceRuns[0].comparisonIdentity = { ...identity, roSerialno: 'conflict' };
  assert.equal(compareTaskRuns(before, unknown).comparable, false);
});

test('duplicate device identities and missing or changed step identities are rejected', () => {
  const before = makeRun('old');
  const after = makeRun('new');
  before.deviceRuns.push({ ...before.deviceRuns[0], deviceId: 'another' });
  after.deviceRuns.push({ ...after.deviceRuns[0], deviceId: 'another' });
  assert.equal(compareTaskRuns(before, after).comparable, false);
  const malformed = makeRun('new');
  malformed.deviceRuns[0].steps[0].id = 'wrong-step';
  assert.equal(compareTaskRuns(makeRun('old'), malformed).comparable, false);
  malformed.deviceRuns[0].steps = [makeStep(0, 'success'), makeStep(0, 'failed')];
  assert.equal(compareTaskRuns(makeRun('old'), malformed).comparable, false);
});

test('cancelled, missing, queued, and running steps never become recovered/new failures', () => {
  for (const status of ['cancelled', 'queued', 'running']) {
    const before = makeRun('old');
    const after = makeRun('new', ['failed', status]);
    after.status = 'cancelled';
    const result = compareTaskRuns(before, after);
    assert.equal(result.recovered, 0);
    assert.equal(result.unobserved, 1);
    assert.equal(result.steps[1].deltaMs, null);
  }
  const before = makeRun('old', ['success']);
  const after = makeRun('new');
  const result = compareTaskRuns(before, after);
  assert.equal(result.newFailures, 0);
  assert.equal(result.steps[1].change, 'unobserved');
});

test('duration handles missing or reversed timestamps without inventing zero time', () => {
  assert.equal(runDuration({}), null);
  assert.equal(runDuration({ startedAt: '2026-10-21T00:01:00Z', endedAt: '2026-10-21T00:00:00Z' }), null);
  assert.equal(runDuration({ startedAt: '2026-10-21T00:00:00Z', endedAt: '2026-10-21T00:00:00Z' }), 0);
});
