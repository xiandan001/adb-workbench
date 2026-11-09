const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
function load(name, mocks, expose = '') {
  const filename = path.join(__dirname, '../electron/lib', name), realRequire = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + expose, { module, Buffer, console: { log() {}, warn() {} }, setImmediate,
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : realRequire(name) }, { filename });
  return module.exports;
}
test('native fault names trigger distinct rules and HiLog context retains domain/process without a model request', async () => {
  const events = [];
  const api = load('auto-diagnose.cjs', { electron: { app: { getPath: () => 'private-fixture' } }, fs: { readFileSync() { throw new Error('no persisted fixture'); } },
    './app-context.cjs': { broadcastToAllWindows: (channel, payload) => events.push({ channel, payload }) },
    './ai-analyze.cjs': { aiKeys: {} }, './vip.cjs': {}, './ai-outbound-transport.cjs': {} }, '\nmodule.exports.detectIssue = detectIssue;');
  for (const [word, type] of [['JS_CRASH', 'harmony_js_crash'], ['CPP_CRASH', 'harmony_cpp_crash'], ['APP_FREEZE', 'harmony_app_freeze']]) assert.equal(api.detectIssue(word).type, type);
  assert.equal(api.detectIssue('FATAL EXCEPTION: main').type, 'crash');
  const raw = '11-09 12:00:00.001 1 2 E A0001/fixture/Hiview: APP_FREEZE';
  await api.autoDiagnoseScanFile([{ raw, logFormat: 'hilog', level: 'E' }], 'file');
  assert.equal(events.find(event => event.channel === 'auto-diagnose:detected').payload.issues[0].context, raw);
  assert.equal(events.find(event => event.channel === 'auto-diagnose:scan-complete').payload.issueCount, 1);
});
test('real MCP tools use merged descriptors and existing native domain providers, preserving unavailable metrics', async () => {
  const calls = [], targets = [{ id: 'android', status: 'device', platform: 'android' }, { id: 'hdc:H', status: 'device', platform: 'harmony' }, { id: 'hdc:R', status: 'ready', platform: 'harmony' }];
  const api = load('mcp-server.cjs', {
    './ai-outbound-transport.cjs': {}, './app-context.cjs': {}, './ai-analyze.cjs': { aiKeys: {} }, './version.cjs': { getAppVersion: () => 'fixture' },
    './log-analyzer.cjs': { getLogStore: () => ({}), getCurrentLogSource: () => 'realtime', getLogcatProc: () => null,
      startLogCapture: async args => { calls.push(['capture', args]); return { ok: true }; },
      clearLogs: async args => { calls.push(['clear', args]); return { ok: false, error: 'target mismatch' }; } },
    './device-discovery.cjs': { listDevices: async () => targets },
    './package-manager.cjs': { listPackages: async id => { calls.push(['packages', id]); return [{ packageName: 'native', system: null }, { packageName: 'system', system: true }]; },
      getPackageDetail: async (id, name) => ({ platform: 'harmony', bundleName: name, id }) },
    './performance-monitor.cjs': { collectSnapshot: async id => ({ deviceId: id, cpu: { usage: null }, sampleError: 'unsupported' }) },
    './inspection.cjs': {}, './vip.cjs': { getStatusAsync: async () => ({ activated: true }) }
  }, '\nmodule.exports.callMcpTool = callMcpTool; module.exports.buildMcpTools = buildMcpTools;');
  const call = async (name, args = {}) => JSON.parse((await api.callMcpTool(name, args)).content[0].text);
  assert.deepEqual((await call('device_list')).devices, targets);
  assert.equal((await call('capture_start')).ok, false); assert.equal(calls.length, 0);
  assert.equal((await call('capture_start', { deviceId: 'hdc:H', types: ['app'] })).ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), { deviceId: 'hdc:H', types: ['app'] });
  assert.equal((await call('log_clear', { source: 'realtime', deviceId: 'hdc:R' })).ok, false);
  assert.equal((await call('package_list', { deviceId: 'hdc:H' })).packages[0].system, null);
  assert.equal((await call('package_detail', { deviceId: 'hdc:H', packageName: 'com.example.app' })).detail.platform, 'harmony');
  const sample = await call('perf_snapshot', { deviceId: 'hdc:H' }); assert.equal(sample.ok, false); assert.equal(sample.snapshot.cpu.usage, null);
  assert.ok(api.buildMcpTools().find(tool => tool.name === 'log_filter').inputSchema.properties.filter.properties.domain);
});
