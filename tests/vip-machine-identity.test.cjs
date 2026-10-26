const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { hashMachineId, candidateMachineIds, createIdentityStore } = require('../electron/lib/machine-identity.cjs');

const full = { cpu: 'CPU-A', board: 'BOARD-A', disk: 'DISK-A', guid: 'GUID-A' };
function evidence(primary = full, changes = {}) {
  return { primary, registry: { cpu: '', board: 'HARDWARE-A', disk: '', guid: primary.guid }, disks: primary.disk ? [primary.disk] : [], ...changes };
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-identity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const key = crypto.randomBytes(32);
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString: text => {
      const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(text), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString: bytes => {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
    }
  };
  const file = path.join(directory, 'machine-identity.dat');
  return { file, storage, open: options => createIdentityStore({ file, safeStorage: storage, ...options }) };
}

test('the existing four-source fingerprint remains byte-for-byte compatible', () => {
  assert.equal(hashMachineId(full), crypto.createHash('sha256').update('CPU-A|BOARD-A|DISK-A|GUID-A').digest('hex'));
});
test('historical fingerprints are reconstructed only from currently observed local sources', () => {
  const ids = candidateMachineIds(evidence(full, { disks: ['DISK-A', 'DISK-B'] }));
  assert.ok(ids.has(hashMachineId({ ...full, disk: 'DISK-B' })));
  assert.ok(ids.has(hashMachineId({ ...full, disk: '', board: '' })));
  assert.ok(ids.has(hashMachineId({ cpu: '', board: 'HARDWARE-A', disk: '', guid: 'GUID-A' })));
  assert.ok(ids.has(hashMachineId({ cpu: '', board: '', disk: '', guid: 'GUID-A' }, 'registry-guid-v1')));
  assert.equal(ids.has(hashMachineId({ ...full, guid: 'OTHER-WINDOWS' })), false);
  assert.equal(ids.has(hashMachineId({ cpu: 'CPU-A', board: '', disk: '', guid: '' })), false);
});
test('a verified fingerprint survives process restart, missing CIM fields and disk enumeration changes', t => {
  const h = fixture(t); const id = hashMachineId(full);
  assert.equal(h.open().remember(id, evidence()), true);
  assert.equal(h.open().read(evidence({ ...full, disk: 'DISK-B' }, { disks: ['DISK-B', 'DISK-A'] })), id);
  assert.equal(h.open().read(evidence({ cpu: '', board: '', disk: '', guid: 'GUID-A' })), id);
  assert.equal(h.open().read(evidence({ ...full, cpu: '', board: '' })), id);
  assert.equal(fs.readFileSync(h.file).includes(Buffer.from(id)), false);
});
test('a copied anchor cannot authorize another Windows identity or unrelated hardware with a cloned GUID', t => {
  const h = fixture(t); h.open().remember(hashMachineId(full), evidence());
  assert.equal(h.open().read(evidence({ ...full, guid: 'GUID-B' })), null);
  assert.equal(h.open().read(evidence({ cpu: 'CPU-B', board: 'BOARD-B', disk: 'DISK-B', guid: 'GUID-A' },
    { registry: { guid: 'GUID-A', board: 'HARDWARE-B' } })), null);
  assert.equal(h.open({ safeStorage: { ...h.storage, decryptString: () => { throw Error('different Windows user or machine'); } } }).read(evidence()), null);
});
test('a common CPU identifier cannot override explicit motherboard or disk conflicts', t => {
  const h = fixture(t); h.open().remember(hashMachineId(full), evidence());
  const changed = evidence({ ...full, board: 'BOARD-B', disk: 'DISK-B' }, { registry: { guid: full.guid, board: 'HARDWARE-B' } });
  assert.equal(h.open().read(changed), null);
  assert.equal(candidateMachineIds(changed).has(hashMachineId(full)), false);
  assert.equal(h.open().read(evidence({ ...full, disk: 'DISK-B' })), null);
  assert.equal(h.open().read(evidence({ ...full, disk: 'DISK-B', guid: '' }, { registry: {} })), null);
});
test('encrypted identity anchors are excluded from portable import and export', () => {
  const policy = require('../electron/lib/data-migration-policy.cjs');
  assert.equal(policy.isAllowedFile('machine-identity.dat'), false);
  assert.throws(() => policy.sanitizeFile('machine-identity.dat', {}));
});
test('known hardware can establish identity during a temporary registry read failure, not a GUID change', t => {
  const h = fixture(t); const id = hashMachineId(full); h.open().remember(id, evidence());
  assert.equal(h.open().read(evidence({ ...full, guid: '' }, { registry: {} })), id);
  assert.equal(h.open().read(evidence({ cpu: 'CPU-A', board: '', disk: '', guid: '' }, { registry: {} })), null);
});
test('unrelated IDs, insufficient hardware, unavailable encryption and tampered anchors fail closed', t => {
  const h = fixture(t);
  assert.equal(h.open().remember('a'.repeat(64), evidence()), false);
  const guidOnly = evidence({ cpu: '', board: '', disk: '', guid: 'GUID-A' }, { registry: { guid: 'GUID-A' } });
  assert.equal(h.open().remember(hashMachineId(guidOnly.primary, 'registry-guid-v1'), guidOnly), false);
  assert.equal(h.open({ safeStorage: { isEncryptionAvailable: () => false } }).remember(hashMachineId(full), evidence()), false);
  h.open().remember(hashMachineId(full), evidence());
  const bytes = fs.readFileSync(h.file); bytes[15] ^= 1; fs.writeFileSync(h.file, bytes);
  assert.equal(h.open().read(evidence()), null);
});
test('private state is flushed before rename and a failed flush preserves the previous file', t => {
  const h = fixture(t); const events = []; const files = Object.create(fs); let failFlush = false;
  files.fsyncSync = descriptor => { events.push('flush'); if (failFlush) throw Error('flush failed'); fs.fsyncSync(descriptor); };
  files.renameSync = (...args) => { events.push('rename'); return fs.renameSync(...args); };
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../electron/lib/machine-identity.cjs'), 'utf8'), {
    module: mod, require: name => name === 'fs' ? files : require(name)
  });
  mod.exports.atomicWritePrivateFile(h.file, 'previous');
  assert.deepEqual(events, ['flush', 'rename']);
  failFlush = true; events.length = 0;
  assert.throws(() => mod.exports.atomicWritePrivateFile(h.file, 'replacement'), /flush failed/);
  assert.equal(fs.readFileSync(h.file, 'utf8'), 'previous');
  assert.deepEqual(events, ['flush']);
  assert.deepEqual(fs.readdirSync(path.dirname(h.file)), ['machine-identity.dat']);
});
