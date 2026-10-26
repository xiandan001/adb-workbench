const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const identity = require('../electron/lib/machine-identity.cjs');
const source = fs.readFileSync(path.resolve(__dirname, '../electron/lib/machine-id.cjs'), 'utf8');
const full = { cpu: 'CPU-A', board: 'BOARD-A', disk: 'DISK-A', guid: 'GUID-A', disks: ['DISK-A', 'DISK-B'] };

function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-reboot-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const key = crypto.randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => {
      const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString: bytes => {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8');
    }
  };
  function boot({ hardware = full, guid = 'GUID-A', board = 'HARDWARE-A', encryption = safeStorage } = {}) {
    const calls = []; let psCalls = 0; const mod = { exports: {} };
    vm.runInNewContext(source, { module: mod, process: { env: {} }, Date, require: name => {
      if (name === './localization.cjs') return { tr: value => value };
      if (name === 'electron') return { app: { getPath: () => directory }, safeStorage: encryption };
      if (name === './machine-identity.cjs') return identity;
      if (name === 'child_process') return { execFile: (file, args, options, callback) => {
        calls.push({ file, args, options });
        setImmediate(() => {
          if (file === 'powershell.exe') {
            const current = typeof hardware === 'function' ? hardware(++psCalls) : hardware;
            callback(current === null ? Error('CIM temporarily unavailable') : null, JSON.stringify(current || {}));
          } else {
            const value = args[3] === 'MachineGuid' ? guid : board;
            callback(value ? null : Error('registry temporarily unavailable'), `    ${args[3]}    REG_SZ    ${value}`);
          }
        });
      } };
      return require(name);
    } });
    return { ...mod.exports, calls };
  }
  return { directory, boot, safeStorage };
}

test('verified activation identity remains stable after independent boots with CIM missing or reordered disks', async t => {
  const h = harness(t); const first = h.boot(); const before = await first.getMachineIdAsync();
  assert.equal(before.machineId, identity.hashMachineId(full));
  assert.equal(fs.existsSync(path.join(h.directory, 'machine-identity.dat')), false);
  assert.equal(first.rememberMachineId(before.machineId), true);
  const missing = await h.boot({ hardware: null }).getMachineIdAsync(); assert.equal(missing.machineId, before.machineId);
  const reordered = await h.boot({ hardware: { ...full, disk: 'DISK-B', disks: ['DISK-B', 'DISK-A'] } }).getMachineIdAsync();
  assert.equal(reordered.machineId, before.machineId);
});
test('an old signed fingerprint can be restored without an existing anchor after disks reorder', async t => {
  const h = harness(t); const boot = h.boot({ hardware: { ...full, disk: 'DISK-B' } });
  const expected = identity.hashMachineId(full);
  assert.notEqual((await boot.getMachineIdAsync()).machineId, expected);
  assert.equal((await boot.resolveMachineIdAsync(expected)).machineId, expected);
  assert.equal(boot.rememberMachineId(expected), true);
  assert.equal((await h.boot({ hardware: null }).getMachineIdAsync()).machineId, expected);
});
test('legacy incomplete and registry-only fingerprints remain valid when full CIM becomes available', async t => {
  const h = harness(t); const boot = h.boot();
  const expected = identity.hashMachineId({ ...full, cpu: '', disk: '' });
  assert.equal((await boot.resolveMachineIdAsync(expected)).machineId, expected);
  assert.equal(boot.rememberMachineId(expected), true);
  assert.equal((await h.boot().getMachineIdAsync()).machineId, expected);
  const fallback = identity.hashMachineId({ guid: 'GUID-A' }, 'registry-guid-v1');
  assert.equal((await h.boot().resolveMachineIdAsync(fallback)).machineId, fallback);
});
test('a cold-start transient failure receives one bounded recovery and concurrent calls share collection', async t => {
  const h = harness(t); const boot = h.boot({ hardware: count => count === 1 ? null : full, board: '' });
  await Promise.all([boot.preloadMachineId(), boot.getMachineIdAsync(), boot.getMachineIdAsync()]);
  assert.equal(boot.calls.filter(call => call.file === 'powershell.exe').length, 1);
  const expected = identity.hashMachineId(full);
  const results = await Promise.all([boot.resolveMachineIdAsync(expected), boot.resolveMachineIdAsync(expected)]);
  assert.ok(results.every(result => result.machineId === expected));
  assert.equal(boot.calls.filter(call => call.file === 'powershell.exe').length, 2);
  assert.ok(boot.calls.every(call => call.options.windowsHide));
  assert.ok(boot.calls.filter(call => call.file === 'reg.exe').every(call => call.args.includes('/reg:64')));
});
test('a copied encrypted anchor plus copied signed fingerprint does not match unrelated hardware', async t => {
  const h = harness(t); const boot = h.boot(); const expected = (await boot.getMachineIdAsync()).machineId; boot.rememberMachineId(expected);
  const other = h.boot({ hardware: { cpu: 'CPU-B', board: 'BOARD-B', disk: 'DISK-C', guid: 'GUID-A', disks: ['DISK-C'] }, board: 'HARDWARE-B' });
  assert.notEqual((await other.getMachineIdAsync()).machineId, expected);
  assert.notEqual((await other.resolveMachineIdAsync(expected)).machineId, expected);
});
test('matching model-common CPU and a cloned GUID cannot bypass the historical full fingerprint', async t => {
  const h = harness(t); const boot = h.boot(); const expected = (await boot.getMachineIdAsync()).machineId; boot.rememberMachineId(expected);
  const other = h.boot({ hardware: { ...full, board: 'BOARD-B', disk: 'DISK-C', disks: ['DISK-C'] }, board: 'HARDWARE-B' });
  assert.notEqual((await other.getMachineIdAsync()).machineId, expected);
  assert.notEqual((await other.resolveMachineIdAsync(expected)).machineId, expected);
  assert.equal(other.rememberMachineId(expected), false);
});
