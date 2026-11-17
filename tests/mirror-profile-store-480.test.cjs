const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createMirrorProfileStore, normalizeMirrorProfiles } = require('../electron/lib/mirror-profile-store.cjs');
const { deviceComparisonIdentity } = require('../electron/lib/task-run-manifest.cjs');
const identity = deviceComparisonIdentity({ androidId: 'aabbccdd11223344' });
const input = { identity, settings: { bitrate: '8 Mbps', maxSize: '1280', audioMode: 'disabled', screenOff: true, stayAwake: true },
  globalSettings: { bitrate: '8 Mbps', maxSize: '0' }, verification: 'user-confirmed', toolVersion: '5.0.1' };

test('atomic profile persistence survives a new controller, forget is explicit and failed writes leave exact old bytes', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veylo-profile480-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'profiles.json'); const store = createMirrorProfileStore({ filename });
  await store.remember(input);
  const before = await fs.readFile(filename), restarted = createMirrorProfileStore({ filename }), saved = await restarted.find(identity);
  assert.equal(saved.settings.audioMode, 'disabled'); assert.equal(saved.settings.screenOff, undefined); assert.equal(saved.settings.stayAwake, undefined);
  const failing = createMirrorProfileStore({ filename, io: { ...fs, rename: async () => { throw Object.assign(Error('synthetic failure'), { code: 'EACCES' }); } } });
  await assert.rejects(failing.remember({ ...input, settings: { bitrate: '4 Mbps', maxSize: '720' } }));
  assert.deepEqual(await fs.readFile(filename), before); assert.deepEqual((await fs.readdir(directory)).sort(), ['profiles.json']);
  await assert.rejects(restarted.remember(input, () => { throw Error('stale owner'); }), /stale owner/);
  assert.deepEqual(await fs.readFile(filename), before);
  await restarted.forget(saved.id); assert.equal((await restarted.list()).profiles.length, 0);
});

test('persisted power arguments, unknown keys, sparse lists, proxies and getter values are rejected without evaluating them', () => {
  let getters = 0; const getter = { version: 1, profiles: [] }; Object.defineProperty(getter, 'profiles', { enumerable: true, get() { getters++; return []; } });
  assert.throws(() => normalizeMirrorProfiles(getter)); assert.equal(getters, 0);
  assert.throws(() => normalizeMirrorProfiles({ version: 1, profiles: new Array(1) }));
  assert.throws(() => normalizeMirrorProfiles(new Proxy({}, { ownKeys() { throw Error('do not invoke'); } })));
});
