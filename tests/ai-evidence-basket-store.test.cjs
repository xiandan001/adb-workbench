const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createEvidenceBasketStore, BASKET_LIMITS } = require('../electron/lib/ai-evidence-basket-store.cjs');
const { computeWorkspaceJob } = require('../electron/lib/ai-workspace-compute.cjs');
const { createHandoffBroker } = require('../electron/lib/ai-analysis-handoff.cjs');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { createRequire } = require('node:module');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-basket-'));
  const filename = path.join(directory, 'basket.json');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createEvidenceBasketStore({ filename });
  const provenance = { trust: 'renderer-view', origin: 'log-filter' };
  const frozen = await computeWorkspaceJob('freeze', { sources: [{ kind: 'log', label: 'Fixture', text: 'password=private-value\nsecond line', provenance }], now: 1000000 });
  const item = () => ({ id: randomUUID(), origin: 'log-filter', title: 'Fixture', question: 'Analyze fixture', deviceId: 'selected-device',
    createdAt: new Date(1000000).toISOString(), provenance, truncated: false, entries: frozen.entries });
  return { store, filename, item };
}

test('basket appends frozen redacted evidence and survives restart without source reads', async t => {
  const f = await fixture(t), first = f.item(), second = f.item();
  const result = await f.store.append(first);
  assert.equal(result.revision, 1); assert.equal(result.items.length, 1);
  assert.equal(result.items[0].entries, undefined);
  await f.store.append(second);
  const restored = createEvidenceBasketStore({ filename: f.filename });
  assert.equal((await restored.list()).items.length, 2);
  const context = await restored.resolve(2);
  assert.equal(context.entries.length, 2); assert.equal(context.entries[0].targetKey, null);
  assert.ok(!JSON.stringify(context).includes('private-value'));
  await assert.rejects(() => restored.resolve(1), { code: 'AI_BASKET_CHANGED' });
  await restored.remove(first.id); assert.equal((await restored.list()).items[0].id, second.id);
  await restored.clear(); assert.equal((await restored.list()).items.length, 0);
  assert.equal((await restored.list()).revision, 4);
});

test('basket rejects capabilities, unknown fields and excess items without altering saved bytes', async t => {
  const f = await fixture(t);
  await f.store.append(f.item()); const before = await fs.readFile(f.filename);
  for (const changes of [{ taskTargets: [{ token: 'forged' }] }, { contextRef: {} }, { reference: {} }, { command: 'never-run' }]) {
    await assert.rejects(() => f.store.append({ ...f.item(), ...changes }));
    assert.deepEqual(await fs.readFile(f.filename), before);
  }
  for (let index = 1; index < BASKET_LIMITS.items; index++) await f.store.append(f.item());
  const full = await fs.readFile(f.filename);
  await assert.rejects(() => f.store.append(f.item()), { code: 'AI_BASKET_LIMIT' });
  assert.deepEqual(await fs.readFile(f.filename), full);
});

test('corrupt and over-budget basket files remain untouched, including clear', async t => {
  const f = await fixture(t);
  for (const content of ['{broken', JSON.stringify({ version: 9, revision: 0, items: [] }), 'x'.repeat(BASKET_LIMITS.bytes + 1)]) {
    await fs.writeFile(f.filename, content);
    for (const action of [() => f.store.list(), () => f.store.append(f.item()), () => f.store.clear()]) await assert.rejects(action);
    assert.equal(await fs.readFile(f.filename, 'utf8'), content);
  }
});

test('atomic basket write failure preserves old file and permits a single successful retry', async t => {
  const f = await fixture(t); await f.store.append(f.item());
  const before = await fs.readFile(f.filename);
  let denied = true;
  const store = createEvidenceBasketStore({ filename: f.filename, io: { ...fs, rename: async (...args) => {
    if (denied) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' });
    return fs.rename(...args);
  } } });
  await assert.rejects(() => store.append(f.item())); assert.deepEqual(await fs.readFile(f.filename), before);
  denied = false; await store.append(f.item()); assert.equal((await store.list()).items.length, 2);
});

test('basket aggregate bytes and nested capability fields are rejected without eviction or truncation', async t => {
  const f = await fixture(t); await f.store.append(f.item());
  const before = await fs.readFile(f.filename);
  for (const entry of [{ ...f.item().entries[0], token: 'authority' }, { ...f.item().entries[0], provenance: { trust: 'renderer-view', origin: 'log-filter', contextRef: {} } }]) {
    await assert.rejects(() => f.store.append({ ...f.item(), entries: [entry] }));
    assert.deepEqual(await fs.readFile(f.filename), before);
  }
  const long = await computeWorkspaceJob('freeze', { sources: [{ kind: 'text', label: 'Large', text: `${'fixture '.repeat(30)}\n`.repeat(2000) }], now: 1000000 });
  await f.store.append({ ...f.item(), entries: long.entries }); await f.store.append({ ...f.item(), entries: long.entries });
  const full = await fs.readFile(f.filename);
  await assert.rejects(() => f.store.append({ ...f.item(), entries: long.entries }), { code: 'AI_BASKET_LIMIT' });
  assert.deepEqual(await fs.readFile(f.filename), full); assert.equal((await f.store.list()).items.length, 3);
});

test('real handoff broker persists only frozen redacted snapshots and never persists control capabilities', async t => {
  const f = await fixture(t), owner = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  let sourceReads = 0, time = 1000000;
  const broker = createHandoffBroker({ getOwner: () => owner, freeze: computeWorkspaceJob.bind(null, 'freeze'),
    publish() {}, basket: f.store, now: () => time, readReference: async () => { sourceReads++; throw new Error('unexpected source read'); } });
  const created = await broker.createFromRenderer({ view: { origin: 'log-filter', title: 'password=private-title', question: 'token=private-question',
    text: 'password=private-body', deviceId: 'selected-device' } });
  assert.equal(broker.get(created.handoffId).basketItem, true);
  await broker.createInternal({ origin: 'task-targets', title: 'Selected control', deviceId: 'device-A', text: 'Selected control',
    taskTargets: [{ token: 'private-control-token', label: 'Control', deviceId: 'device-A', capturedAt: new Date(time).toISOString(), expiresAt: new Date(time + 100000).toISOString() }] });
  const disk = await fs.readFile(f.filename, 'utf8');
  for (const secret of ['private-title', 'private-question', 'private-body', 'private-control-token', 'taskTargets', 'contextRef']) assert.ok(!disk.includes(secret));
  assert.equal((await broker.list()).items.length, 1);
  time += 11 * 60 * 1000; assert.throws(() => broker.get(created.handoffId));
  broker.cleanup(); const restored = await createEvidenceBasketStore({ filename: f.filename }).resolve(1);
  assert.equal(restored.entries.length, 1); assert.equal(sourceReads, 0); assert.equal(restored.entries[0].targetKey, null);
});

test('basket IPC only permits the current owned main frame; detached log windows can append but not read or remove', async () => {
  const filename = path.join(__dirname, '../electron/lib/ai-analysis-handoff.cjs'), actualRequire = createRequire(filename);
  const mainContents = { mainFrame: {} }, logContents = { mainFrame: {} };
  const main = { isDestroyed: () => false, webContents: mainContents }, log = { isDestroyed: () => false, webContents: logContents };
  const calls = [], handlers = new Map(), module = { exports: {} };
  const source = await fs.readFile(filename, 'utf8');
  vm.runInNewContext(`${source}\nmodule.exports.setBrokerForTest = value => { broker = value; };`, { module, Buffer,
    require: name => name === './app-context.cjs' ? { getMainWindow: () => main, getLogAnalyzerWindow: () => log } : actualRequire(name) }, { filename });
  const basket = { revision: 1, items: [], bytes: 0 };
  module.exports.setBrokerForTest({ list: async () => { calls.push('list'); return basket; }, remove: async id => { calls.push(id); return basket; },
    clear: async () => { calls.push('clear'); return basket; }, createFromRenderer: async () => { calls.push('append'); return { handoffId: 'fixture' }; } });
  module.exports.register({ handle: (name, handler) => handlers.set(name, handler) });
  for (const method of ['list', 'remove', 'clear']) {
    const handler = handlers.get(`ai-handoff:${method}`);
    assert.equal((await handler({ sender: logContents, senderFrame: logContents.mainFrame }, { id: 'one' })).ok, false);
    assert.equal((await handler({ sender: mainContents, senderFrame: {} }, { id: 'one' })).ok, false);
    assert.equal(calls.length, 0);
  }
  for (const method of ['list', 'remove', 'clear']) assert.equal((await handlers.get(`ai-handoff:${method}`)({ sender: mainContents, senderFrame: mainContents.mainFrame }, { id: 'one' })).ok, true);
  assert.equal((await handlers.get('ai-handoff:create')({ sender: logContents, senderFrame: logContents.mainFrame }, {})).ok, true);
  assert.deepEqual(calls, ['list', 'one', 'clear', 'append']);
});
