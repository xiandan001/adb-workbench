const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { createWorksetStore, register } = require('../electron/lib/workbench-worksets.cjs');
const policy = require('../electron/lib/workbench-worksets-policy.cjs');
const firstId = '10000000-0000-4000-8000-000000000001', secondId = '10000000-0000-4000-8000-000000000002';
const args = { name: 'My board', deviceId: 'USB-AbC', packageName: 'com.test.app', page: 'devices' };
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-worksets-'));
  t.after(async () => { assert.equal(path.dirname(await fs.realpath(directory)), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, file: path.join(directory, policy.FILE_NAME) };
}
test('worksets persist metadata only and reload through a second store without executing anything', async t => {
  const { directory } = await fixture(t), store = createWorksetStore({ directory, uuid: () => firstId });
  await store.remember('logs', { deviceId: args.deviceId, filter: { pkg: args.packageName, minLevel: 'W' }, buffers: ['main'] });
  await store.remember('ssh', { profileId: secondId });
  await store.remember('serial', { workspace: 'terminal', schemeId: 'scheme-A' });
  const saved = await store.save(args);
  assert.equal(saved.items[0].id, firstId);
  assert.deepEqual(await createWorksetStore({ directory }).read(), saved);
  assert.equal(saved.items[0].logs.deviceId, args.deviceId);
  assert.equal(saved.items[0].ssh.profileId, secondId);
  assert.equal(saved.items[0].serial.schemeId, 'scheme-A');
  assert.equal(JSON.stringify(saved).includes('password'), false);
});
test('worksets retain exact Android and HDC identities and never attach another device log filter', async t => {
  const { directory } = await fixture(t); let next = 0;
  const store = createWorksetStore({ directory, uuid: () => [firstId, secondId][next++] });
  await store.remember('logs', { deviceId: 'hdc:USB-AbC', filter: { text: 'native' }, buffers: ['app'] });
  await store.save(args);
  const saved = await store.save({ ...args, name: 'Native', deviceId: 'hdc:USB-AbC' });
  assert.equal(saved.items[0].logs.deviceId, 'hdc:USB-AbC');
  assert.equal(saved.items[1].logs, null);
  assert.equal(saved.items[1].deviceId, 'USB-AbC');
});
test('explicit update preserves ID and creation time; duplicate names do not overwrite another item', async t => {
  const { directory, file } = await fixture(t), store = createWorksetStore({ directory, uuid: () => firstId });
  const first = await store.save(args);
  const changed = await store.save({ ...args, id: firstId, name: 'Updated' });
  assert.equal(changed.items[0].createdAt, first.items[0].createdAt);
  const before = await fs.readFile(file, 'utf8');
  await assert.rejects(createWorksetStore({ directory, uuid: () => secondId }).save({ ...args, name: 'updated' }));
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.equal((await store.remove(firstId)).items.length, 0);
});
test('corrupt files and failed atomic writes preserve original bytes and allow a later safe retry', async t => {
  const { directory, file } = await fixture(t), store = createWorksetStore({ directory, uuid: () => firstId });
  await store.save(args); const original = await fs.readFile(file, 'utf8');
  const failed = createWorksetStore({ directory, persist: async () => { throw Error('disk full'); } });
  await assert.rejects(failed.save({ ...args, id: firstId, name: 'Not saved' }), /disk full/);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  await fs.writeFile(file, '{corrupt');
  await assert.rejects(store.read(), /原文件已保留/);
  await assert.rejects(store.save(args));
  assert.equal(await fs.readFile(file, 'utf8'), '{corrupt');
});
test('serialized metadata updates preserve simultaneous source references', async t => {
  const { directory } = await fixture(t), store = createWorksetStore({ directory });
  await Promise.all([store.remember('ssh', { profileId: firstId }), store.remember('serial', { workspace: 'rs232', schemeId: 'serial-A' })]);
  const saved = await store.read(); assert.equal(saved.context.ssh.profileId, firstId); assert.equal(saved.context.serial.schemeId, 'serial-A');
});
test('workset schemas reject hidden execution authority, oversized values, sparse arrays and unknown fields', () => {
  for (const [part, value] of [['ssh', { profileId: firstId, password: 'no' }], ['serial', { workspace: 'terminal', schemeId: 'A', command: 'no' }], ['application', { deviceId: 'A', packageName: 'a', token: 'no' }]]) assert.throws(() => policy.normalizePart(part, value));
  assert.throws(() => policy.normalizeSave({ ...args, deviceId: 'A shell bad' }));
  assert.throws(() => policy.normalizeSave({ ...args, page: 'execute' }));
  assert.throws(() => policy.normalizeStore({ ...policy.emptyStore(), items: Array(2) }));
  assert.throws(() => policy.normalizePart('logs', { deviceId: 'A', filter: { text: 'x'.repeat(4097) }, buffers: ['main'] }));
  const item = { ...args, id: firstId, logs: null, ssh: null, serial: null, createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z' };
  assert.throws(() => policy.normalizeStore({ ...policy.emptyStore(), items: Array.from({ length: 21 }, (_, index) => ({ ...item, id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`, name: String(index) })) }));
});
test('IPC requires exact main frame owner; log window can remember only log configuration', async () => {
  const handlers = new Map(), frame = {}, otherFrame = {}, logFrame = {}, main = { isDestroyed: () => false, webContents: { mainFrame: frame } }, log = { isDestroyed: () => false, webContents: { mainFrame: logFrame } };
  const calls = [], empty = policy.emptyStore();
  register({ handle: (name, fn) => handlers.set(name, fn) }, { context: { getMainWindow: () => main, getLogAnalyzerWindow: () => log }, store: {
    read: async () => empty, remember: async (...args) => { calls.push(args); return empty; }
  } });
  assert.equal((await handlers.get('worksets:list')({ sender: main.webContents, senderFrame: otherFrame })).ok, false);
  assert.equal((await handlers.get('worksets:list')({ sender: log.webContents, senderFrame: logFrame })).ok, false);
  assert.equal((await handlers.get('worksets:remember')({ sender: log.webContents, senderFrame: logFrame }, { part: 'ssh', value: { profileId: firstId } })).ok, false);
  const response = await handlers.get('worksets:remember')({ sender: log.webContents, senderFrame: logFrame }, { part: 'logs', value: { deviceId: 'A', filter: {}, buffers: ['main'] } });
  assert.deepEqual(response, { ok: true }); assert.equal(calls.length, 1);
  assert.equal((await handlers.get('worksets:list')({ sender: main.webContents, senderFrame: frame })).ok, true);
});

test('failed source metadata blocks stale workset saves until that source explicitly succeeds', async () => {
  const handlers = new Map(), frame = {}, main = { isDestroyed: () => false, webContents: { mainFrame: frame } };
  let failing = true, saves = 0;
  const empty = policy.emptyStore(), event = { sender: main.webContents, senderFrame: frame };
  register({ handle: (name, fn) => handlers.set(name, fn) }, { context: { getMainWindow: () => main, getLogAnalyzerWindow: () => null }, store: {
    remember: async () => { if (failing) throw Error('disk full'); return empty; }, save: async () => { saves++; return empty; }
  } });
  assert.equal((await handlers.get('worksets:remember')(event, { part: 'logs', value: { deviceId: 'A', filter: {}, buffers: ['main'] } })).ok, false);
  assert.equal((await handlers.get('worksets:save')(event, args)).ok, false); assert.equal(saves, 0);
  failing = false;
  assert.equal((await handlers.get('worksets:remember')(event, { part: 'logs', value: { deviceId: 'A', filter: {}, buffers: ['main'] } })).ok, true);
  assert.equal((await handlers.get('worksets:save')(event, args)).ok, true); assert.equal(saves, 1);
});

test('late older metadata success cannot clear a newer failure or let a stale workset save proceed', async () => {
  const handlers = new Map(), frame = {}, main = { isDestroyed: () => false, webContents: { mainFrame: frame } };
  let release, calls = 0, saves = 0;
  const pending = new Promise(resolve => { release = resolve; }), empty = policy.emptyStore(), event = { sender: main.webContents, senderFrame: frame };
  register({ handle: (name, fn) => handlers.set(name, fn) }, { context: { getMainWindow: () => main, getLogAnalyzerWindow: () => null }, store: {
    remember: async () => { if (++calls === 1) return pending; throw Error('new invalid filter'); }, save: async () => { saves++; return empty; }
  } });
  const first = handlers.get('worksets:remember')(event, { part: 'logs', value: null });
  assert.equal((await handlers.get('worksets:save')(event, args)).ok, false);
  assert.equal((await handlers.get('worksets:remember')(event, { part: 'logs', value: null })).ok, false);
  release(empty); assert.equal((await first).ok, true);
  assert.equal((await handlers.get('worksets:save')(event, args)).ok, false); assert.equal(saves, 0);
});
