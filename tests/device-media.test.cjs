const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createDeviceMediaStore } = require('../electron/lib/device-media.cjs');

async function fixture(t, maxItems = 500) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'adb-media-test-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('adb-media-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const calls = [];
  const options = { directory, maxItems, shell: { openPath: async file => { calls.push(file); return ''; }, showItemInFolder: file => calls.push(file) },
    nativeImage: { createFromPath: file => ({ isEmpty: () => false, file }) }, clipboard: { writeImage: image => calls.push(image.file) } };
  return { directory, calls, options, store: createDeviceMediaStore(options),
    file: async (name, body = 'fixture') => { const file = path.join(directory, name); await fs.writeFile(file, body); return file; } };
}

test('recent images/videos persist across instances, filter by exact device and keep related logs', async t => {
  const h = await fixture(t);
  const first = await h.store.add({ type: 'image', deviceId: 'a', path: await h.file('one.png'), createdAt: 1 });
  const video = await h.store.add({ type: 'video', deviceId: 'b', path: await h.file('two.mp4'), logPath: await h.file('two.log'), createdAt: 2, durationMs: 1200, logTruncated: true });
  const restored = createDeviceMediaStore(h.options);
  assert.deepEqual((await restored.list({ deviceId: 'a' })).map(item => item.id), [first.id]);
  assert.equal((await restored.list({ deviceId: 'b' }))[0].logTruncated, true);
  await restored.perform({ id: video.id, action: 'log' });
  await restored.perform({ id: first.id, action: 'copy' });
  assert.deepEqual(h.calls, [video.logPath, first.path]);
  await assert.rejects(restored.perform({ id: video.id, action: 'copy' }), /只有截图/);
  await assert.rejects(restored.perform({ id: 'fake', action: 'open' }), /不在最近记录/);
});

test('metadata trimming never deletes media and missing files are removed persistently', async t => {
  const h = await fixture(t, 2);
  const original = await h.file('old.png');
  await h.store.add({ type: 'image', deviceId: 'a', path: original, createdAt: 1 });
  await Promise.all(['new.png', 'last.png'].map(async (name, i) => h.store.add({ type: 'image', deviceId: 'a', path: await h.file(name), createdAt: 2 + i })));
  assert.equal((await fs.stat(original)).size, 7);
  const item = (await h.store.list({ deviceId: 'a' }))[0];
  await fs.unlink(item.path);
  assert.equal((await h.store.list({ deviceId: 'a' })).length, 1);
  const restored = createDeviceMediaStore(h.options);
  assert.equal((await restored.list({ deviceId: 'a' })).some(entry => entry.id === item.id), false);
  await assert.rejects(restored.perform({ id: item.id, action: 'open' }), error => error.code === 'MEDIA_RECORD_MISSING');
  assert.deepEqual(h.calls, []);
});

test('deleted logs lose only their link, leaving the video and other metadata intact', async t => {
  const h = await fixture(t);
  const video = await h.store.add({ type: 'video', deviceId: 'a', path: await h.file('video.mp4'), logPath: await h.file('video.log'), logTruncated: true });
  await fs.unlink(video.logPath);
  const [retained] = await h.store.list({ deviceId: 'a' });
  assert.equal(retained.id, video.id);
  assert.equal(retained.available, true);
  for (const key of ['logPath', 'logRealPath', 'logBytes', 'logTruncated']) assert.equal(Object.hasOwn(retained, key), false);
  const [restored] = await createDeviceMediaStore(h.options).list({ deviceId: 'a' });
  assert.equal(Object.hasOwn(restored, 'logPath'), false);
  await h.store.perform({ id: video.id, action: 'open' });
  assert.deepEqual(h.calls, [video.path]);
});

test('recent ten are filled from older existing records after missing entries are reconciled', async t => {
  const h = await fixture(t);
  const media = [];
  for (let i = 0; i < 13; i++) media.push(await h.store.add({ type: 'image', deviceId: 'a', path: await h.file(`${i}.png`), createdAt: i }));
  for (const item of media.slice(10)) await fs.unlink(item.path);
  const result = await h.store.list({ deviceId: 'a' });
  assert.deepEqual(result.map(item => item.id), media.slice(0, 10).reverse().map(item => item.id));
  const index = JSON.parse(await fs.readFile(path.join(h.directory, 'device-media-history.json'), 'utf8'));
  assert.equal(index.items.length, 10);
});

test('access errors and temporary read errors retain metadata and explain unavailability without raw paths', async t => {
  const h = await fixture(t);
  const image = await h.store.add({ type: 'image', deviceId: 'a', path: await h.file('image.png') });
  const video = await h.store.add({ type: 'video', deviceId: 'a', path: await h.file('video.mp4'), logPath: await h.file('video.log') });
  const lstat = fs.lstat.bind(fs);
  const failureCodes = new Map([[image.path, 'EIO'], [video.path, 'EACCES'], [video.logPath, 'EPERM']]);
  const mock = t.mock.method(fs, 'lstat', async file => {
    if (failureCodes.has(file)) throw Object.assign(new Error(`failed ${file}`), { code: failureCodes.get(file) });
    return lstat(file);
  });
  const result = await h.store.list({ deviceId: 'a' });
  assert.equal(result.length, 2);
  for (const item of result) {
    assert.equal(item.available, false);
    assert.equal(item.exists, null);
    assert.match(item.availabilityError, /暂时无法读取/);
    assert.equal(item.availabilityError.includes(h.directory), false);
  }
  const unavailableVideo = result.find(item => item.id === video.id);
  assert.equal(unavailableVideo.logPath, video.logPath);
  assert.equal(unavailableVideo.logAvailable, false);
  await assert.rejects(h.store.perform({ id: video.id, action: 'open' }), error => error.code === 'MEDIA_ACCESS_DENIED' && !error.message.includes(h.directory));
  mock.mock.restore();
  const restored = await createDeviceMediaStore(h.options).list({ deviceId: 'a' });
  assert.equal(restored.length, 2);
  assert.ok(restored.every(item => item.available));
});

test('reconciliation and concurrent additions are serialized without losing the new metadata', async t => {
  const h = await fixture(t);
  const old = await h.store.add({ type: 'image', deviceId: 'a', path: await h.file('old.png') });
  const newPath = await h.file('new.png');
  await fs.unlink(old.path);
  let entered;
  let release;
  const enteredCheck = new Promise(resolve => { entered = resolve; });
  const pendingCheck = new Promise(resolve => { release = resolve; });
  const lstat = fs.lstat.bind(fs);
  t.mock.method(fs, 'lstat', async file => {
    if (file === old.path) { entered(); await pendingCheck; }
    return lstat(file);
  });
  const listing = h.store.list({ deviceId: 'a' });
  await enteredCheck;
  const adding = h.store.add({ type: 'image', deviceId: 'a', path: newPath });
  release();
  assert.deepEqual(await listing, []);
  const added = await adding;
  assert.deepEqual((await h.store.list({ deviceId: 'a' })).map(item => item.id), [added.id]);
  assert.deepEqual((await createDeviceMediaStore(h.options).list({ deviceId: 'a' })).map(item => item.id), [added.id]);
});

test('a file removed after list or during opening is pruned and returns a friendly error code', async t => {
  const h = await fixture(t);
  const first = await h.store.add({ type: 'image', deviceId: 'a', path: await h.file('first.png') });
  await h.store.list({ deviceId: 'a' });
  await fs.unlink(first.path);
  await assert.rejects(h.store.perform({ id: first.id, action: 'folder' }), error => error.code === 'MEDIA_FILE_MISSING' && !error.message.includes('ENOENT'));
  const video = await h.store.add({ type: 'video', deviceId: 'a', path: await h.file('video.mp4'), logPath: await h.file('video.log') });
  h.options.shell.openPath = async file => { await fs.unlink(file); return `ENOENT: ${file}`; };
  await assert.rejects(h.store.perform({ id: video.id, action: 'log' }), error => error.code === 'MEDIA_LOG_MISSING' && !error.message.includes(h.directory));
  const [retained] = await h.store.list({ deviceId: 'a' });
  assert.equal(retained.id, video.id);
  assert.equal(retained.logPath, undefined);
  await assert.rejects(h.store.perform({ id: video.id, action: 'open' }), error => error.code === 'MEDIA_FILE_MISSING' && !error.message.includes(h.directory));
  assert.deepEqual(await h.store.list({ deviceId: 'a' }), []);
  assert.deepEqual(await createDeviceMediaStore(h.options).list({ deviceId: 'a' }), []);
});

test('an optional log removed before indexing does not prevent a valid video from being saved', async t => {
  const h = await fixture(t);
  const log = await h.file('video.log');
  await fs.unlink(log);
  const video = await h.store.add({ type: 'video', deviceId: 'a', path: await h.file('video.mp4'), logPath: log });
  assert.equal(video.logPath, undefined);
  assert.equal((await h.store.list({ deviceId: 'a' }))[0].id, video.id);
  await assert.rejects(h.store.add({ type: 'video', deviceId: 'a', path: video.path, logPath: path.join(h.directory, 'outside', 'wrong.log') }), /必须位于/);
  await assert.rejects(h.store.add({ type: 'video', deviceId: 'a', path: video.path, logPath: path.join(h.directory, 'wrong.txt') }), /必须位于/);
  const directoryLog = path.join(h.directory, 'directory.log');
  await fs.mkdir(directoryLog);
  await assert.rejects(h.store.add({ type: 'video', deviceId: 'a', path: video.path, logPath: directoryLog }), /文件无效/);
});

test('ENOTDIR prunes missing paths but a changed file identity is retained for manual inspection', async t => {
  const h = await fixture(t);
  const first = await h.store.add({ type: 'image', deviceId: 'a', path: await h.file('first.png') });
  const other = await h.store.add({ type: 'image', deviceId: 'a', path: await h.file('other.png') });
  const lstat = fs.lstat.bind(fs);
  const realpath = fs.realpath.bind(fs);
  t.mock.method(fs, 'lstat', file => file === first.path ? Promise.reject(Object.assign(new Error('not a directory'), { code: 'ENOTDIR' })) : lstat(file));
  t.mock.method(fs, 'realpath', file => file === other.path ? Promise.resolve(`${other.realPath}.changed`) : realpath(file));
  const result = await h.store.list({ deviceId: 'a' });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, other.id);
  assert.equal(result[0].available, false);
  assert.match(result[0].availabilityError, /位置已变化/);
});

test('a disconnected volume or network share retains apparently missing media until storage returns', async t => {
  const h = await fixture(t);
  const video = await h.store.add({ type: 'video', deviceId: 'a', path: await h.file('video.mp4'), logPath: await h.file('video.log') });
  const lstat = fs.lstat.bind(fs);
  const stat = fs.stat.bind(fs);
  const root = path.parse(video.path).root;
  const missing = () => Object.assign(new Error('volume unavailable'), { code: 'ENOENT' });
  const lstatMock = t.mock.method(fs, 'lstat', file => [video.path, video.logPath].includes(file) ? Promise.reject(missing()) : lstat(file));
  const statMock = t.mock.method(fs, 'stat', file => file === root ? Promise.reject(missing()) : stat(file));
  const [retained] = await h.store.list({ deviceId: 'a' });
  assert.equal(retained.id, video.id);
  assert.equal(retained.logPath, video.logPath);
  assert.equal(retained.available, false);
  assert.equal(retained.logAvailable, false);
  assert.match(retained.availabilityError, /存储位置暂时不可用/);
  await assert.rejects(h.store.perform({ id: video.id, action: 'open' }), error => error.code === 'MEDIA_STORAGE_UNAVAILABLE');
  lstatMock.mock.restore();
  statMock.mock.restore();
  const [restored] = await createDeviceMediaStore(h.options).list({ deviceId: 'a' });
  assert.equal(restored.id, video.id);
  assert.equal(restored.available, true);
  assert.equal(restored.logAvailable, true);
});

test('a junction target volume going offline preserves media and log links even while the visible drive is online', { skip: process.platform !== 'win32' }, async t => {
  const h = await fixture(t);
  const video = await h.store.add({ type: 'video', deviceId: 'a', path: await h.file('video.mp4'), logPath: await h.file('video.log') });
  const indexPath = path.join(h.directory, 'device-media-history.json');
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  const visibleRoot = path.parse(video.path).root;
  const targetRoot = visibleRoot.toUpperCase() === 'Z:\\' ? 'Y:\\' : 'Z:\\';
  Object.assign(index.items[0], { realPath: path.join(targetRoot, 'recordings', 'video.mp4'), logRealPath: path.join(targetRoot, 'recordings', 'video.log') });
  await fs.writeFile(indexPath, JSON.stringify(index));
  const lstat = fs.lstat.bind(fs);
  const stat = fs.stat.bind(fs);
  const checkedRoots = [];
  const missing = () => Object.assign(new Error('junction target disconnected'), { code: 'ENOENT' });
  t.mock.method(fs, 'lstat', file => [video.path, video.logPath].includes(file) ? Promise.reject(missing()) : lstat(file));
  t.mock.method(fs, 'stat', file => {
    checkedRoots.push(file);
    return file === targetRoot ? Promise.reject(missing()) : stat(file);
  });
  const [retained] = await h.store.list({ deviceId: 'a' });
  assert.equal(retained.id, video.id);
  assert.equal(retained.logPath, video.logPath);
  assert.equal(retained.available, false);
  assert.equal(retained.logAvailable, false);
  assert.match(retained.availabilityError, /存储位置暂时不可用/);
  assert.match(retained.logAvailabilityError, /存储位置暂时不可用/);
  assert.ok(checkedRoots.includes(visibleRoot));
  assert.ok(checkedRoots.includes(targetRoot));
  await assert.rejects(h.store.perform({ id: video.id, action: 'open' }), error => error.code === 'MEDIA_STORAGE_UNAVAILABLE');
  assert.deepEqual(JSON.parse(await fs.readFile(indexPath, 'utf8')), index);
  assert.equal((await createDeviceMediaStore(h.options).list({ deviceId: 'a' }))[0].id, video.id);
});

test('invalid media, out-of-folder log links and corrupt indexes are not accepted or overwritten', async t => {
  const h = await fixture(t);
  await assert.rejects(h.store.add({ type: 'image', deviceId: 'a', path: await h.file('bad.exe') }), /文件类型/);
  await fs.writeFile(path.join(h.directory, 'device-media-history.json'), '{invalid');
  await assert.rejects(h.store.add({ type: 'image', deviceId: 'a', path: await h.file('valid.png') }));
  assert.equal(await fs.readFile(path.join(h.directory, 'device-media-history.json'), 'utf8'), '{invalid');
});
