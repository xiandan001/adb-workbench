const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const identity = require('../electron/lib/machine-identity.cjs');

const keys = crypto.generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const original = fs.readFileSync(path.resolve(__dirname, '../electron/lib/vip.cjs'), 'utf8');
const source = original.replace(/const PUBLIC_KEY = `[\s\S]*?`;/, `const PUBLIC_KEY = ${JSON.stringify(publicKey)};`);
const id = 'a'.repeat(64);
function signed(changes = {}) {
  const payload = Buffer.from(JSON.stringify({ m: id, s: 'vip', t: 'lifetime', i: 100, ...changes })).toString('base64url');
  return `${payload}.${crypto.sign(null, Buffer.from(payload), keys.privateKey).toString('base64url')}`;
}
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-persistence-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = { remember: [], resolve: [], atomic: 0 };
  let cached = options.initialFailure ? { success: false, error: 'collect_failed' } : { success: true, machineId: options.currentId || id };
  const machine = {
    getMachineIdAsync: async () => cached, getMachineIdSync: () => cached, preloadMachineId: async () => cached,
    resolveMachineIdAsync: async expected => { calls.resolve.push(expected); return options.acceptLegacy ?
      { success: true, machineId: expected } : cached; },
    rememberMachineId: value => { calls.remember.push(value); cached = { success: true, machineId: value }; return true; }
  };
  const handlers = new Map(); const mod = { exports: {} };
  const files = Object.create(fs);
  if (options.failHistory) files.writeFileSync = (file, ...args) => {
    if (String(file).endsWith('vip-activation-records.json')) throw Error('history denied');
    return fs.writeFileSync(file, ...args);
  };
  vm.runInNewContext(source, { module: mod, Buffer, console, require: name => {
    if (name === 'electron') return { app: { getPath: () => directory } };
    if (name === './localization.cjs') return { tr: value => value };
    if (name === './machine-id.cjs') return machine;
    if (name === './machine-identity.cjs') return { ...identity, atomicWritePrivateFile: (...args) => {
      calls.atomic++; if (options.failAtomic) throw Error('disk unavailable'); return identity.atomicWritePrivateFile(...args);
    } };
    if (name === 'fs') return files;
    return require(name);
  } });
  mod.exports.register({ handle: (name, handler) => handlers.set(name, handler) });
  return { directory, tokenPath: path.join(directory, 'vip-token.txt'), calls, vip: mod.exports,
    invoke: (name, ...args) => handlers.get(name)({}, ...args) };
}

test('old valid activations can adopt a locally reconstructed historical fingerprint without reactivation', async t => {
  const h = fixture(t, { currentId: 'b'.repeat(64), acceptLegacy: true });
  fs.writeFileSync(h.tokenPath, signed());
  assert.equal((await h.vip.getStatusAsync()).activated, true);
  assert.deepEqual(h.calls.remember, [id]);
  assert.equal(h.vip.getStatus().activated, true);
});
test('new activation writes atomically and ancillary history failures do not invalidate a saved license', async t => {
  const h = fixture(t, { failHistory: true }); const token = signed();
  const result = await h.invoke('vip:activate', token);
  assert.equal(result.success, true); assert.equal(result.status.activated, true);
  assert.equal(fs.readFileSync(h.tokenPath, 'utf8'), token);
  assert.equal(h.calls.atomic, 1); assert.ok(h.calls.remember.includes(id));
});
test('failed atomic activation preserves the previous signed license', async t => {
  const h = fixture(t, { failAtomic: true }); const before = signed(); fs.writeFileSync(h.tokenPath, before);
  const result = await h.invoke('vip:activate', signed({ i: 101 }));
  assert.equal(result.success, false); assert.equal(result.error, 'write_failed');
  assert.equal(fs.readFileSync(h.tokenPath, 'utf8'), before);
});
test('signature, expiry and foreign-device validation remain required before anchoring', async t => {
  const h = fixture(t, { currentId: 'b'.repeat(64) });
  fs.writeFileSync(h.tokenPath, signed()); assert.equal((await h.vip.getStatusAsync()).reason, 'machine_mismatch');
  assert.equal(h.calls.remember.length, 0);
  fs.writeFileSync(h.tokenPath, signed({ t: 'subscription', e: 1 }));
  assert.equal((await h.vip.getStatusAsync()).reason, 'expired');
  const token = signed(); fs.writeFileSync(h.tokenPath, token.slice(0, -4) + 'AAAA');
  assert.equal((await h.vip.getStatusAsync()).activated, false);
  assert.equal(h.calls.remember.length, 0);
});
test('synchronous and asynchronous status preserve the signed membership scope', async t => {
  const h = fixture(t); fs.writeFileSync(h.tokenPath, signed({ s: 'free' }));
  assert.equal((await h.vip.getStatusAsync()).scope, 'free'); assert.equal(h.vip.getStatus().scope, 'free');
});
test('deactivation removes the token and an identity anchor alone never grants membership', async t => {
  const h = fixture(t); fs.writeFileSync(h.tokenPath, signed());
  await h.vip.getStatusAsync(); const result = await h.invoke('vip:deactivate');
  assert.equal(result.success, true); assert.equal(result.status.activated, false); assert.equal(result.status.reason, 'no_token');
});
test('a valid existing token is allowed to retry a completely failed cold-start identity collection', async t => {
  const h = fixture(t, { initialFailure: true, acceptLegacy: true }); fs.writeFileSync(h.tokenPath, signed());
  assert.equal((await h.vip.preload()).activated, true);
  assert.equal(h.vip.getStatus().activated, true);
  assert.deepEqual(h.calls.resolve, [id]);
});
