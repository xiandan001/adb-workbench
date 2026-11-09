const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const nativeData = require('../electron/lib/harmony-quality-data.cjs');
const nativeQuality = require('../electron/lib/harmony-quality-native.cjs');

const params = { 'const.product.model': 'Fixture Phone', 'const.product.software.version': 'Fixture OS 1', 'const.ohos.apiversion': '18' };
const metric = () => ({ platform: 'harmony', cpu: { usage: null }, memory: { usage: 30 }, disk: [{ mount: '/data', usage: 40 }],
  battery: { temperature: null }, thermal: { hottest: null }, fps: { foreground: { fps: null } }, warnings: [],
  unavailable: [{ metric: 'cpu', reason: 'requires second sample' }, { metric: 'fps', reason: 'not verified' }], sampleError: '' });
const packages = [{ packageName: 'com.fixture.app', versionCode: '', versionName: '', system: null, path: '' }];
const qualitySnapshot = () => ({ deviceId: 'hdc:QA', platform: 'harmony', device: { model: 'Fixture Phone', systemVersion: 'Fixture OS 1' }, props: { ...params },
  packages: structuredClone(packages), packageError: '', versionMetadataIncomplete: true, performance: metric(), performanceError: '', performanceSkipped: false,
  propertyErrors: [], logs: { issues: [] }, logError: '' });

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-harmony-quality-'));
  const state = { legacyCalls: [], nativeCalls: [], modelCalls: 0, metric: metric(), log: { ok: true, stdout: 'I Fixture no fault event' }, online: true };
  const cache = new Map();
  const deviceRef = { id: 'hdc:QA', targetKey: 'QA', transport: 'hdc', status: 'device', generation: 0 };
  function load(name) {
    if (cache.has(name)) return cache.get(name);
    const filename = path.resolve(__dirname, '../electron/lib', name), actualRequire = createRequire(filename), module = { exports: {} };
    const model = { module, exports: module.exports, Buffer, console, process, setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
      require(request) {
        if (request === 'electron') return { app: { getPath: () => directory }, shell: { openPath: async () => '' } };
        if (request === 'child_process') return { execFile() { throw new Error('No real child process allowed'); } };
        if (request === './app-context.cjs') return { broadcastToAllWindows() {}, getMainWindow: () => null };
        if (request === './version.cjs') return { getAppVersion: () => 'fixture' };
        if (request === './vip.cjs') return { getStatusAsync: async () => ({ activated: true }) };
        if (request === './ai-source-lifecycle.cjs') return { bindSummaryLifetime: () => ({ dispose() {} }) };
        if (request === './ai-analyze.cjs') return { generateAiSummary() { state.modelCalls++; throw new Error('No model invocation allowed'); } };
        if (request === './adb-runtime.cjs') return { runAdb: async args => { state.legacyCalls.push(args); if (state.allowAndroid) return { ok: true, stdout: args.at(-1) === 'getprop' ? '[ro.product.model]: [Android Fixture]\n[ro.build.version.release]: [13]' : '' }; throw new Error('Harmony must not call Android collectors'); } };
        if (request === './performance-monitor.cjs') return { collectSnapshot: async () => { if (state.allowAndroid) return { cpu: { usage: 12 }, memory: { usage: 25 }, disk: [] }; throw new Error('No Android metrics collector allowed'); } };
        if (request === './package-manager.cjs') return { listPackages: async () => { if (state.allowAndroid) return []; throw new Error('No Android package collector allowed'); }, getPackageDetail: async () => { throw new Error('No Android detail collector allowed'); } };
        if (request === './hdc-runtime.cjs') return { runHdc: async (id, args) => { state.nativeCalls.push({ id, args }); return { ok: true, stdout: args[1] === 'id' ? 'uid=2000(shell)' : 'fixture native text' }; } };
        if (request === './harmony-metrics.cjs') return { collectHarmonySnapshot: async () => state.pendingMetric ? state.pendingMetric : structuredClone(state.metric) };
        if (request === './harmony-apps.cjs') return { listPackages: async () => structuredClone(packages), getPackageDetail: async () => ({ packageName: 'com.fixture.app', versionName: '1.0', versionCode: 1, path: '/data/app/fixture' }) };
        if (request === './harmony-log.cjs') return { readHiLogSnapshot: async () => ({ ...state.log }) };
        if (request === './harmony-media.cjs') return { captureScreenshot: async (id, file) => { state.nativeCalls.push({ id, screenshot: file }); fs.writeFileSync(file, 'fixture png'); return { ok: true, path: file }; } };
        if (request === './harmony-quality-native.cjs') return { ...nativeQuality,
          taskReadOptions: (task, id, options = {}) => ({ ...options, deviceRef: { ...deviceRef, id, targetKey: id.slice(4) }, isCancelled: () => task?.cancelled === true }),
          checkHarmonyDevice: async () => ({ ok: state.online, error: state.online ? '' : 'fixture offline' }),
          readHarmonyDeviceInfo: async () => ({ props: { ...params }, errors: [], device: { model: 'Fixture Phone', platform: 'harmony', systemVersion: 'Fixture OS 1', apiVersion: 18 } }),
          collectHarmonyQualitySnapshot: async () => qualitySnapshot() };
        if (request === './harmony-inspection.cjs') return load('harmony-inspection.cjs').module.exports;
        if (request === './inspection.cjs') return load('inspection.cjs').module.exports;
        return actualRequire(request);
      }
    };
    cache.set(name, model); vm.runInNewContext(fs.readFileSync(filename, 'utf8'), model, { filename });
    if (name === 'inspection.cjs') model.createZip = async (_root, destination) => fs.writeFileSync(destination, 'fixture archive');
    return model;
  }
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('awb-harmony-quality-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, state, load, deviceRef };
}

test('native quality collection uses real param names and records unknown versions/metrics rather than Android text or zeros', async t => {
  const h = await fixture(t), calls = [];
  const result = await nativeQuality.collectHarmonyQualitySnapshot('hdc:QA', { deviceRef: h.deviceRef }, {
    runHdc: async (id, args) => { calls.push({ id, args }); return { ok: true, stdout: params[args.at(-1)] }; },
    listPackages: async () => packages, readHiLogSnapshot: async () => ({ ok: true, stdout: 'E FaultLogger APP_FREEZE' }), collectHarmonySnapshot: async () => metric()
  });
  assert.equal(result.platform, 'harmony'); assert.equal(result.device.android, undefined);
  assert.equal(result.performance.cpu.usage, null); assert.equal(result.versionMetadataIncomplete, true);
  assert.equal(result.logs.issues.length, 1);
  assert.ok(calls.every(call => call.id === 'hdc:QA' && call.args[1] === 'param'));
});

test('native regression excludes null metrics/unknown package versions and blocks cross-platform baselines', async t => {
  const h = await fixture(t), model = h.load('regression-report.cjs');
  const baseline = qualitySnapshot(), current = qualitySnapshot();
  current.packages[0].versionCode = '2';
  const diff = model.compareSnapshots(baseline, current);
  assert.equal(diff.packageDiff.changed.length, 0);
  assert.ok(diff.mediumCount > 0);
  assert.ok(diff.performanceDiff.metrics.every(item => item.before !== null && item.after !== null));
  assert.ok(!diff.performanceDiff.metrics.some(item => /CPU|FPS/.test(item.label)));
  assert.throws(() => model.compareSnapshots({ ...baseline, platform: undefined }, current), /平台/);
  const baselinePath = path.join(h.directory, 'baseline.json'); fs.writeFileSync(baselinePath, JSON.stringify({ name: 'Fixture', snapshot: baseline }));
  const result = await model.module.exports.runRegression('hdc:QA', baselinePath, {});
  assert.notEqual(result.status, 'passed'); assert.equal(result.platform, 'harmony');
  const report = fs.readFileSync(result.reportPath, 'utf8'); assert.match(report, /Harmony\/OpenHarmony/); assert.doesNotMatch(report, /null%|0 FPS/);
  assert.equal(h.state.legacyCalls.length, 0); assert.equal(h.state.modelCalls, 0);
});

test('legacy Android regression retains getprop/logcat collection and its original device schema', async t => {
  const h = await fixture(t), model = h.load('regression-report.cjs'); h.state.allowAndroid = true;
  const snapshot = await model.collectSnapshot('android-A', { includePerformance: false });
  assert.equal(snapshot.device.model, 'Android Fixture'); assert.equal(snapshot.device.android, '13');
  assert.equal(snapshot.platform, undefined); assert.equal(h.state.nativeCalls.length, 0);
  assert.ok(h.state.legacyCalls.some(args => args.at(-1) === 'getprop'));
  assert.ok(h.state.legacyCalls.some(args => args.includes('logcat')));
});

test('native inspection saves partial evidence and never runs Android standard collectors', async t => {
  const h = await fixture(t), model = h.load('inspection.cjs');
  const task = { id: 'inspection-fixture', deviceId: 'hdc:QA', cancelled: false, silent: true, currentProc: null };
  const result = await model.runInspectionBody(task, { deviceId: 'hdc:QA', outputBaseDir: path.join(h.directory, 'inspection'), includeAiSummary: false, includeBugreport: false });
  assert.equal(result.ok, false); assert.ok(result.failedCount > 0);
  assert.ok(fs.existsSync(result.reportPath));
  const report = fs.readFileSync(result.reportPath, 'utf8'); assert.match(report, /鸿蒙设备巡检|Harmony\/OpenHarmony/); assert.match(report, /未验证/);
  assert.doesNotMatch(JSON.stringify(h.state.nativeCalls), /getprop|dumpsys|logcat|screencap/);
  assert.equal(h.state.legacyCalls.length, 0); assert.equal(h.state.modelCalls, 0);
});

test('native troubleshooting reports unknown metrics and device-wide HiLog scope without a healthy claim', async t => {
  const h = await fixture(t), model = h.load('troubleshooting.cjs');
  const task = { id: 'trouble-fixture', deviceId: 'hdc:QA', deviceLabel: 'Fixture', issueType: 'generic', packageName: 'com.fixture.app',
    includeInspection: false, includeAiSummary: false, cancelled: false, startedAt: new Date().toISOString(), steps: model.createStepState({ includeInspection: false, includeAiSummary: false }) };
  const result = await model.runTroubleshootingBody(task);
  assert.equal(result.platform, 'harmony'); assert.equal(result.deviceId, 'hdc:QA'); assert.notEqual(result.status, 'healthy');
  assert.ok(result.checks.some(item => item.key === 'performance' && !item.ok && item.unavailable));
  assert.ok(result.checks.some(item => item.key === 'log-scope' && !item.ok));
  assert.equal(model.formatMetric(null, '%'), '-'); assert.equal(model.formatMetric(0, '%'), '0.0%');
  assert.equal(h.state.legacyCalls.length, 0); assert.equal(h.state.modelCalls, 0);
});

test('native guard retains unknown values, recognizes native fault labels and ignores late samples after stop', async t => {
  const h = await fixture(t), model = h.load('device-guard.cjs');
  h.state.log = { ok: true, stdout: 'E FaultLogger JS_CRASH\nE FaultLogger APP_FREEZE' };
  const guard = model.createGuard('hdc:QA', {});
  await model.runGuardTick(guard);
  assert.equal(guard.samples[0].snapshot.cpuUsage, null); assert.equal(guard.samples[0].snapshot.foregroundFps, null);
  assert.ok(guard.events.some(item => /JS|崩溃/.test(item.label)));
  assert.ok(guard.events.some(item => /无响应/.test(item.label)));
  assert.equal(model.formatMetric(null, '%'), '-');
  let resolve; h.state.pendingMetric = new Promise(done => { resolve = done; });
  const next = model.runGuardTick(guard); await new Promise(done => setImmediate(done));
  await model.stopGuard(guard, 'manual'); const count = guard.samples.length;
  assert.equal(guard.nativeController.signal.aborted, true);
  resolve(metric()); await next; assert.equal(guard.samples.length, count);
  assert.equal(h.state.legacyCalls.length, 0);
});
