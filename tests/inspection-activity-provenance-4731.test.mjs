import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import { buildActivityItems, prepareActivityItems, recordActivityDismissals, isActivityDismissed } from '../src/shared/activityDismissals.js';

const require = createRequire(import.meta.url), { parse } = require('@babel/parser'), traverse = require('@babel/traverse').default;
const appSource = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const inspectionSource = fs.readFileSync(new URL('../electron/lib/inspection.cjs', import.meta.url), 'utf8');
const appFunctions = new Map(), backendFunctions = new Map(), callbacks = new Map();
traverse(parse(appSource, { sourceType: 'module', plugins: ['jsx'] }), {
  FunctionDeclaration({ node }) { if (['toSidebarTask', 'getBackgroundTaskPercent', 'isBackgroundTaskActive'].includes(node.id.name)) appFunctions.set(node.id.name, appSource.slice(node.start, node.end)); },
  'CallExpression|OptionalCallExpression'({ node }) { const method = node.callee.property?.name; if (['onInspectionProgress', 'onInspectionDone'].includes(method)) callbacks.set(method, appSource.slice(node.arguments[0].start, node.arguments[0].end)); },
});
traverse(parse(inspectionSource), { FunctionDeclaration({ node }) {
  if (['sendProgress', 'sendDone', 'publicInspectionTask'].includes(node.id.name)) backendFunctions.set(node.id.name, inspectionSource.slice(node.start, node.end));
} });

function fixture() {
  const events = [], tasks = new Map(), task = { id: 'same-inspection-occurrence', deviceId: 'fixture-device', tracked: true,
    status: 'running', startedAt: '2026-11-17T00:00:00.000Z', result: null, progress: null };
  const backend = vm.runInNewContext(`let lastTaskState=null;${[...backendFunctions.values()].join('\n')};({sendProgress,sendDone,publicInspectionTask,state:()=>lastTaskState})`,
    { sendToSender: (_task, channel, value) => events.push({ channel, value }) });
  const context = vm.createContext({ tr: value => value, ClipboardCheck: 'icon', Gauge: 'icon',
    setTask: (key, value) => tasks.set(key, value), setDeviceOperationErrors: update => update({}) });
  vm.runInContext([...appFunctions.values()].join('\n'), context);
  const progress = vm.runInContext(`(${callbacks.get('onInspectionProgress')})`, context), done = vm.runInContext(`(${callbacks.get('onInspectionDone')})`, context);
  backend.sendProgress(task, { id: 'step', label: 'Read-only fixture' }, 0, 1, 'success', { ok: true }); progress(events.at(-1).value);
  const liveProgress = tasks.get('inspection');
  backend.sendDone(task, { ok: false, error: 'Fixture failure', deviceId: task.deviceId, startedAt: '2026-11-17T00:00:05.000Z' }); done(events.at(-1).value);
  return { task, events, backend, liveProgress, liveDone: tasks.get('inspection'), convert: value => context.toSidebarTask('inspection', value) };
}
const rows = task => buildActivityItems({ registry: { items: [] }, external: { tasks: [], guards: [], recordings: [] }, tasks: [task] });
const prepare = async task => (await prepareActivityItems(rows(task), new Map(), webcrypto))[0];

test('actual backend progress/done and actual App DTOs preserve the canonical run start rather than a report or UI clock', () => {
  const f = fixture();
  assert.equal(f.liveProgress.startedAt, f.task.startedAt);
  assert.equal(f.liveDone.startedAt, f.task.startedAt);
  assert.equal(f.backend.publicInspectionTask(f.task).startedAt, f.task.startedAt);
});

test('clearing an actual live failed inspection stays cleared when the same backend run rehydrates', async t => {
  const f = fixture(), values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const live = await prepare(f.convert(f.liveDone)), preferences = recordActivityDismissals([live], storage);
  const hydrated = await prepare(f.convert(f.backend.state()));
  t.diagnostic(JSON.stringify({ sameKey: live.key === hydrated.key, liveThrough: live.through, hydratedThrough: hydrated.through,
    hiddenBefore: isActivityDismissed(live, preferences), hiddenAfter: isActivityDismissed(hydrated, preferences) }));
  assert.equal(hydrated.key, live.key);
  assert.equal(hydrated.through, live.through, 'The same run must not acquire a different dismissal version when timestamps are hydrated');
  assert.equal(isActivityDismissed(hydrated, preferences), true);
  const fresh = await prepare(f.convert({ ...f.backend.state(), id: 'new-inspection-occurrence', status: 'running' }));
  assert.equal(isActivityDismissed(fresh, preferences), false);
});
