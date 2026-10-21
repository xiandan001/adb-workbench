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

test('metadata trimming never deletes media and moved files remain visible as missing', async t => {
  const h = await fixture(t, 2);
  const original = await h.file('old.png');
  await h.store.add({ type: 'image', deviceId: 'a', path: original, createdAt: 1 });
  await Promise.all(['new.png', 'last.png'].map(async (name, i) => h.store.add({ type: 'image', deviceId: 'a', path: await h.file(name), createdAt: 2 + i })));
  assert.equal((await fs.stat(original)).size, 7);
  const item = (await h.store.list({ deviceId: 'a' }))[0];
  await fs.unlink(item.path);
  assert.equal((await h.store.list({ deviceId: 'a' }))[0].exists, false);
  await assert.rejects(h.store.perform({ id: item.id, action: 'open' }));
  await h.store.perform({ id: item.id, action: 'folder' });
  assert.equal(h.calls.at(-1), h.directory);
});

test('invalid media, out-of-folder log links and corrupt indexes are not accepted or overwritten', async t => {
  const h = await fixture(t);
  await assert.rejects(h.store.add({ type: 'image', deviceId: 'a', path: await h.file('bad.exe') }), /文件类型/);
  await fs.writeFile(path.join(h.directory, 'device-media-history.json'), '{invalid');
  await assert.rejects(h.store.add({ type: 'image', deviceId: 'a', path: await h.file('valid.png') }));
  assert.equal(await fs.readFile(path.join(h.directory, 'device-media-history.json'), 'utf8'), '{invalid');
});
