const test = require('node:test');
const assert = require('node:assert/strict');
const { createAppDiagnostics } = require('../electron/lib/app-diagnostics.cjs');

function fixture(options = {}) {
  const calls = [];
  const deps = { app: { isPackaged: true, getVersion: () => '4.7.0', getLocale: () => 'zh-CN' },
    screen: { getAllDisplays: () => [{ bounds: { width: 1920, height: 1080 }, scaleFactor: 1.25, id: 'never-export-display-id' }] },
    os: { platform: () => 'win32', type: () => 'Windows_NT', version: () => 'Windows 11 Pro', release: () => '10.0.26100',
      arch: () => 'x64', cpus: () => [{ model: 'Fixture CPU' }, { model: 'Fixture CPU' }], totalmem: () => 16 * 1024 ** 3 },
    versions: { electron: '41.2.0', chrome: '146.0.0.0', node: '24.15.0', private: 'hidden' }, now: () => new Date('2026-10-23T12:00:00Z'),
    execFile: (command, args, config, callback) => { calls.push({ command, args, config }); callback(null, JSON.stringify({ manufacturer: 'Fixture Maker', model: 'Model 2', cpu: 'Fixture CPU', logicalCores: 4, memoryBytes: 32 * 1024 ** 3, osName: 'Windows 11 Pro', osVersion: '10.0.26100', osBuild: '26100', serialNumber: 'never-export' })); return { kill() {} }; }, ...options };
  return { service: createAppDiagnostics(deps), calls };
}

test('host collector exposes only safe allowlisted metadata and executes one fixed readonly CIM query', async () => {
  const h = fixture(); const result = await h.service.collect();
  assert.deepEqual(Object.keys(result).sort(), ['app', 'collectedAt', 'computer', 'displays', 'os', 'unavailable']);
  assert.equal(result.computer.model, 'Model 2'); assert.equal(result.computer.logicalCores, 4); assert.equal(result.os.build, '26100');
  assert.equal(result.app.name, '卓控台'); assert.equal(result.app.version, '4.7.0'); assert.equal(result.os.locale, 'zh-CN');
  assert.deepEqual(result.displays, [{ width: 1920, height: 1080, scaleFactor: 1.25 }]);
  assert.doesNotMatch(JSON.stringify(result), /never-export|private|serialNumber/);
  assert.equal(h.calls.length, 1); const { command, args, config } = h.calls[0];
  assert.equal(command, 'powershell.exe'); assert.ok(args.includes('-NoProfile')); assert.ok(args.includes('-NonInteractive'));
  assert.match(args.at(-1), /Get-CimInstance/); assert.doesNotMatch(args.at(-1), /SerialNumber|UUID|UserName|IdentifyingNumber|ProductId|MachineGuid|Network|Invoke-Expression|Set-/i);
  assert.equal(config.timeout, 2500); assert.equal(config.maxBuffer, 16384); assert.equal(config.windowsHide, true);
});

test('CIM unavailable or hostile fields fall back without returning raw commands, paths, tokens or errors', async () => {
  for (const execFile of [(_c, _a, _o, cb) => cb(Error('secret C:\\Users\\person token=private')),
    (_c, _a, _o, cb) => cb(null, JSON.stringify({ manufacturer: 'token=secret', model: 'C:\\Users\\someone', cpu: 'Bearer private', logicalCores: -1, memoryBytes: Infinity }))]) {
    const h = fixture({ execFile }); const result = await h.service.collect();
    assert.equal(result.computer.manufacturer, null); assert.equal(result.computer.model, null);
    assert.equal(result.computer.cpu, 'Fixture CPU'); assert.equal(result.computer.logicalCores, 2);
    assert.ok(result.unavailable.includes('computer.model')); assert.doesNotMatch(JSON.stringify(result), /secret|someone|person|Bearer|C:\\/);
  }
});

test('parallel callers share the bounded CIM operation and late timeout results cannot mutate snapshots', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let callback; let count = 0; let killed = 0;
  const h = fixture({ execFile: (_c, _a, _o, cb) => { count++; callback = cb; return { kill() { killed++; } }; } });
  const a = h.service.collect(); const b = h.service.collect(); assert.equal(count, 1);
  t.mock.timers.tick(2500); const first = await a; assert.deepEqual(await b, first); assert.equal(killed, 1);
  callback(null, '{"model":"Late model"}'); assert.equal(first.computer.model, null);
});

test('non-Windows collection never invokes CIM and absent display/OEM fields remain explicit', async () => {
  const h = fixture({ platform: 'linux', screen: { getAllDisplays() { throw Error('private'); } } });
  const result = await h.service.collect(); assert.equal(h.calls.length, 0); assert.equal(result.os.platform, 'linux');
  assert.deepEqual(result.displays, []); assert.ok(result.unavailable.includes('displays')); assert.ok(result.unavailable.includes('computer.manufacturer'));
});
