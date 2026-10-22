const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSshProfileStore, validateProfile } = require('../electron/lib/ssh-profiles.cjs');

const profile = { name: '测试主机', host: 'localhost', port: 22, username: 'tester', authType: 'password' };
function fixture(t, encryptionAvailable = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-profiles-test-'));
  t.after(() => { assert.equal(path.dirname(directory), os.tmpdir()); fs.rmSync(directory, { recursive: true, force: true }); });
  const options = { directory, canEncrypt: () => encryptionAvailable,
    encrypt: text => Buffer.from(text).map(byte => byte ^ 0x43), decrypt: bytes => Buffer.from(bytes).map(byte => byte ^ 0x43).toString() };
  return { directory, options, store: createSshProfileStore(options) };
}
test('profile validation is bounded and strips untrusted extra fields', () => {
  for (const invalid of [{ host: '' }, { port: 0 }, { port: 65536 }, { username: 'bad\nname' }, { authType: 'agent' }, { host: 'ssh://host' }]) {
    assert.throws(() => validateProfile({ ...profile, ...invalid }));
  }
  assert.equal(validateProfile({ ...profile, password: 'secret', host: 'LOCALHOST' }).password, undefined);
  assert.equal(validateProfile(profile).port, 22);
});
test('public data never contains credentials; secure store survives reload and binds identity', t => {
  const { store, options, directory } = fixture(t);
  const saved = store.save({ profile, credential: { password: 'unique-password-123' }, rememberCredentials: true });
  assert.equal(saved.hasSavedCredential, true);
  assert.ok(!JSON.stringify(store.list()).includes('unique-password'));
  assert.ok(!fs.readFileSync(path.join(directory, 'ssh-connections.json'), 'utf8').includes('unique-password'));
  const reload = createSshProfileStore(options);
  assert.equal(reload.resolve({ profileId: saved.id }).password, 'unique-password-123');
  assert.throws(() => reload.resolve({ profile: { ...saved, host: 'different-host' } }), /凭据/);
  reload.save({ profile: { ...saved, host: 'different-host' }, rememberCredentials: false });
  assert.equal(reload.list()[0].hasSavedCredential, false);
});
test('no plaintext fallback when local encryption unavailable; unsaved login still works', t => {
  const { store, directory } = fixture(t, false);
  assert.throws(() => store.save({ profile, credential: { password: 'password' }, rememberCredentials: true }), /加密/);
  assert.ok(!fs.existsSync(path.join(directory, 'ssh-connections.json')));
  const saved = store.save({ profile, rememberCredentials: false });
  assert.equal(store.resolve({ profileId: saved.id, credential: { password: 'once' } }).password, 'once');
});
test('host trust requires explicit approval, rejects changed fingerprint and aborted approval', async t => {
  const { store } = fixture(t);
  const fingerprint = `SHA256:${Buffer.alloc(32, 4).toString('base64').replace(/=+$/, '')}`;
  const challenge = { host: 'localhost', port: 22, fingerprint, keyType: 'ssh-ed25519', signal: new AbortController().signal };
  let asked = 0;
  assert.equal(await store.verifyHostKey(challenge, async () => { asked++; return false; }), false);
  assert.equal(await store.verifyHostKey(challenge, async () => { asked++; return true; }), true);
  assert.equal(await store.verifyHostKey(challenge, async () => { throw Error('must not ask again'); }), true);
  await assert.rejects(store.verifyHostKey({ ...challenge, fingerprint: `SHA256:${'A'.repeat(43)}` }, async () => true), /指纹.*变化/);
  const controller = new AbortController();
  assert.equal(await store.verifyHostKey({ ...challenge, port: 2200, signal: controller.signal }, async () => { controller.abort(); return true; }), false);
  assert.equal(await store.verifyHostKey({ ...challenge, port: 2200 }, async () => false), false);
  assert.equal(asked, 2);
});
test('corrupt stored settings fail closed and are never overwritten', t => {
  const { store, directory } = fixture(t);
  const file = path.join(directory, 'ssh-connections.json'); fs.writeFileSync(file, '{broken');
  assert.throws(() => store.list(), /配置/);
  assert.throws(() => store.save({ profile }), /配置/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
