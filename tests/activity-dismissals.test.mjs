import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { ACTIVITY_DISMISSALS_KEY, buildActivityItems, prepareActivityItems, readActivityDismissals, normalizeActivityDismissals, recordActivityDismissals, isActivityDismissed } from '../src/shared/activityDismissals.js';

const storage = () => { const values = new Map(), writes = []; return { values, writes, fail: false, getItem: key => values.get(key) ?? null, setItem(key, value) { if (this.fail) throw Error('quota'); values.set(key, value); writes.push({ key, value }); } }; };
const prepare = (rows, tracker = new Map()) => prepareActivityItems(rows, tracker, webcrypto);
const sources = () => ({ registry: { items: [] }, external: { tasks: [], guards: [], recordings: [] }, tasks: [] });

test('all merged sources have stable opaque removal identities, aliases merge and a later occurrence survives', async () => {
  const source = sources(); source.registry.items.push({ id: 'registry-a', kind: 'task', title: 'private title', status: 'completed', startedAt: 10, updatedAt: 30, target: { page: 'tasks', id: 'same-task' } });
  source.external.tasks.push({ id: 'same-task', status: 'success', scriptName: 'secret command', startedAt: 12, endedAt: 29, artifactDir: 'C:/private/output' });
  source.external.guards.push({ id: 'guard', status: 'completed', startedAt: 10, endedAt: 40 });
  source.external.recordings.push({ id: 'recording', status: 'saved', startedAt: 10, endedAt: 50 });
  source.tasks.push({ id: 'legacy-id', key: 'inspection', tab: 'devices', status: 'success', title: 'legacy title', startedAt: 10, endedAt: 60 });
  const rows = await prepare(buildActivityItems(source)); assert.equal(rows.length, 4);
  const store = storage(), saved = recordActivityDismissals(rows, store); assert.ok(rows.every(item => isActivityDismissed(item, saved))); assert.equal(saved.entries.length, 4);
  const raw = store.values.get(ACTIVITY_DISMISSALS_KEY); assert.doesNotMatch(raw, /private|command|output|same-task|guard|recording|legacy/); assert.deepEqual(readActivityDismissals(store), saved);
  const aliasOnly = sources(); aliasOnly.external.tasks = source.external.tasks; assert.equal(isActivityDismissed((await prepare(buildActivityItems(aliasOnly)))[0], saved), true);
  aliasOnly.external.tasks = [{ ...source.external.tasks[0], startedAt: 31, endedAt: 80 }]; assert.equal(isActivityDismissed((await prepare(buildActivityItems(aliasOnly)))[0], saved), false);
});

test('authoritative active membership overrides unknown statuses and stored dismissal; observed timeless reuse keeps its later result', async () => {
  const source = sources(), tracker = new Map(), store = storage(); source.external.tasks = [{ id: 'reused', status: 'unknown-old' }];
  const old = await prepare(buildActivityItems(source), tracker), saved = recordActivityDismissals(old, store); assert.equal(isActivityDismissed(old[0], saved), true);
  source.external.tasks = [{ id: 'reused', status: 'future-active-status', activityActive: true }]; const live = await prepare(buildActivityItems(source), tracker); assert.equal(live[0].active, true); assert.equal(isActivityDismissed(live[0], saved), false);
  source.external.tasks = [{ id: 'reused', status: 'future-terminal-status' }]; const ended = await prepare(buildActivityItems(source), tracker); assert.equal(isActivityDismissed(ended[0], saved), false);
  const activeGuard = sources(); activeGuard.external.guards = [{ id: 'g', status: 'unknown', activityActive: true }]; const guards = await prepare(buildActivityItems(activeGuard)); assert.equal(guards[0].active, true); assert.equal(recordActivityDismissals(guards, storage()).entries.length, 0);
});

test('clear snapshots include all ended rows below the 60-row view cap and never include subsequent completions', async () => {
  const source = sources(); source.external.tasks = Array.from({ length: 90 }, (_, index) => ({ id: 'ended-' + index, status: 'success', startedAt: 1, endedAt: 10 + index }));
  source.external.tasks.push({ id: 'live', status: 'unfamiliar', activityActive: true, startedAt: 200 }); const before = await prepare(buildActivityItems(source)), saved = recordActivityDismissals(before, storage()); assert.equal(saved.entries.length, 90);
  source.external.tasks = [{ id: 'live', status: 'success', startedAt: 200, endedAt: 300 }]; assert.equal(isActivityDismissed((await prepare(buildActivityItems(source)))[0], saved), false);
});

test('strict bounded metadata preserves corrupt bytes and quota failures without evicting saved removals', () => {
  const store = storage(); assert.deepEqual(readActivityDismissals(store), { version: 1, entries: [] }); assert.equal(store.writes.length, 0);
  for (const value of [{ version: 2, entries: [] }, { version: 1, entries: [], hidden: [] }, { version: 1, entries: [{ key: 'x', through: 1 }] }, { version: 1, entries: [{ key: 'a'.repeat(64), through: -1 }] }, { version: 1, entries: Array.from({ length: 2049 }, (_, index) => ({ key: index.toString(16).padStart(64, '0'), through: 1 })) }]) assert.throws(() => normalizeActivityDismissals(value));
  store.values.set(ACTIVITY_DISMISSALS_KEY, '{broken'); assert.throws(() => recordActivityDismissals([], store)); assert.equal(store.values.get(ACTIVITY_DISMISSALS_KEY), '{broken'); assert.equal(store.writes.length, 0);
  store.values.delete(ACTIVITY_DISMISSALS_KEY); store.fail = true; assert.throws(() => recordActivityDismissals([{ key: 'a'.repeat(64), through: 1, active: false }], store)); assert.equal(store.values.has(ACTIVITY_DISMISSALS_KEY), false);
  const full = { version: 1, entries: Array.from({ length: 2048 }, (_, index) => ({ key: index.toString(16).padStart(64, '0'), through: 1 })) }; store.fail = false; store.values.set(ACTIVITY_DISMISSALS_KEY, JSON.stringify(full)); assert.throws(() => recordActivityDismissals([{ key: 'f'.repeat(64), through: 2, active: false }], store)); assert.deepEqual(readActivityDismissals(store), full);
});

test('metadata rejects accessors, sparse arrays, duplicate identities, private fields and excess raw bytes without reading getters', () => {
  let getters = 0; const getter = {}; Object.defineProperty(getter, 'version', { enumerable: true, get() { getters++; return 1; } }); getter.entries = [];
  assert.throws(() => normalizeActivityDismissals(getter)); assert.equal(getters, 0);
  assert.throws(() => normalizeActivityDismissals({ version: 1, entries: new Array(1) }));
  assert.throws(() => normalizeActivityDismissals({ version: 1, entries: [{ key: 'a'.repeat(64), through: 1 }, { key: 'a'.repeat(64), through: 2 }] }));
  assert.throws(() => normalizeActivityDismissals({ version: 1, entries: [{ key: 'a'.repeat(64), through: 1, title: 'Private' }] }));
  assert.throws(() => normalizeActivityDismissals(Object.assign(Object.create({ inherited: true }), { version: 1, entries: [] })));
  const store = storage(); store.values.set(ACTIVITY_DISMISSALS_KEY, ' '.repeat(200 * 1024 + 1)); assert.throws(() => readActivityDismissals(store)); assert.equal(store.writes.length, 0);
});
