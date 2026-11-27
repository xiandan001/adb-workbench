import test from 'node:test';
import assert from 'node:assert/strict';
import { getTaskReadiness, getTaskRequiredFields, TASK_PACKAGE_PLACEHOLDER } from '../src/shared/taskLibrary.js';

const devices = [{ id: 'ADB-A', status: 'device' }, { id: 'hdc:B', status: 'device' }, { id: 'ADB-OFF', status: 'offline' }];
const script = { id: 'script-a', steps: [{ id: 'shot', type: 'screenshot' }] };
const check = (candidate, ids) => getTaskReadiness(candidate, ids, devices);

test('readiness preserves selected targets and requires a selection instead of silently using another device', () => {
  assert.equal(check(script, ['ADB-A']).ready, true);
  assert.equal(check(script, []).issue.key, 'targets');
  assert.equal(check(script, ['ADB-OFF']).issue.key, 'targets');
  assert.equal(check(script, ['ADB-A', 'hdc:B']).issue.key, 'targets');
  assert.equal(check({ ...script, aiTargetDeviceId: 'ADB-A' }, ['ADB-OFF']).ready, false);
  assert.equal(check({ ...script, steps: [] }, ['ADB-A']).issue.key, 'steps');
});

test('configuration exposes required package, file and baseline fields from their exact steps', () => {
  const draft = { ...script, steps: [
    { id: 'install', type: 'installApk', localPath: '' },
    { id: 'launch', type: 'shell', command: `monkey -p ${TASK_PACKAGE_PLACEHOLDER} 1` },
    { id: 'compare', type: 'imageCompare', baselinePath: '' }
  ] };
  const fields = getTaskRequiredFields(draft);
  assert.deepEqual(fields.map(field => [field.index, field.name, field.missing]), [[0, 'localPath', true], [1, 'packageName', true], [2, 'baselinePath', true]]);
  assert.equal(check(draft, ['ADB-A']).issue.key, fields[0].key);
  assert.equal(check(draft, []).issue.key, fields[0].key);
  const configured = { ...draft, steps: [{ ...draft.steps[0], localPath: 'app.apk' }, { ...draft.steps[1], command: 'monkey -p com.veylo.test 1' }, { ...draft.steps[2], baselinePath: 'screen.png' }] };
  assert.equal(check(configured, ['ADB-A']).ready, true);
  assert.equal(check({ ...script, targetPlatform: 'harmony', steps: [{ id: 'launch', type: 'launchApp', packageName: '' }] }, ['hdc:B']).issue.name, 'packageName');
});

test('a real app named com.example.app or arbitrary imported commands keep working', () => {
  for (const command of ['monkey -p com.example.app 1', 'monkey -p "com.real.app" 1', 'monkey -p com.real.app && cmd 1']) {
    assert.equal(check({ ...script, steps: [{ type: 'shell', command }] }, ['ADB-A']).ready, true);
  }
});

test('an incomplete swipe points to its step instead of turning an empty endpoint into zero', () => {
  const swipe = { id: 'gesture', type: 'swipe', x: 0, y: 0, endX: 2, endY: 3 };
  assert.equal(check({ ...script, steps: [swipe] }, ['ADB-A']).ready, true);
  for (const step of [{ ...swipe, x: '' }, { ...swipe, points: [{ x: '', y: 0 }, { x: 2, y: 3 }] }, { ...swipe, points: '{broken' }]) {
    assert.equal(check({ ...script, steps: [step] }, ['ADB-A']).issue.key, 'edit-step-0');
  }
});
