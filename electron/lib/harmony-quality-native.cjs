const { tr } = require('./localization.cjs');
const { runHdc } = require('./hdc-runtime.cjs');
const { resolveDeviceRef } = require('./device-registry.cjs');
const { collectHarmonySnapshot } = require('./harmony-metrics.cjs');
const { listPackages } = require('./harmony-apps.cjs');
const { readHiLogSnapshot } = require('./harmony-log.cjs');

const PARAMS = ['const.product.model', 'const.product.software.version', 'const.ohos.apiversion'];
function taskReadOptions(task, deviceId, options = {}) {
  const deviceRef = resolveDeviceRef(deviceId, { deviceRef: options.deviceRef || task?.deviceRef });
  return { ...options, deviceRef, isCancelled: () => task?.cancelled === true,
    ...(task?.aiSummarySignal ? { signal: task.aiSummarySignal } : {}),
    onProcess: proc => { if (task) task.currentProc = proc; } };
}

async function checkHarmonyDevice(deviceId, options = {}, run = runHdc) {
  try {
    const deviceRef = resolveDeviceRef(deviceId, options);
    return await run(deviceId, ['shell', 'true'], { timeoutMs: 5000, ...options, deviceRef, maxBuffer: 4096 });
  } catch (error) { return { ok: false, error: error.message }; }
}

async function readHarmonyDeviceInfo(deviceId, options = {}, run = runHdc) {
  const ref = resolveDeviceRef(deviceId, options), props = {}, errors = [];
  for (const key of PARAMS) {
    const result = await run(deviceId, ['shell', 'param', 'get', key], { ...options, deviceRef: ref, timeoutMs: 8000, maxBuffer: 8192 });
    const value = result.ok ? String(result.stdout || '').trim() : '';
    if (value) props[key] = value;
    else errors.push(`${key}: ${result.error || tr('未取得可验证的数据')}`);
  }
  const api = props['const.ohos.apiversion'];
  return { props, errors, device: { id: deviceId, platform: 'harmony', transport: 'hdc',
    model: props['const.product.model'] || ref.model || deviceId,
    systemVersion: props['const.product.software.version'] || '', build: props['const.product.software.version'] || '',
    apiVersion: /^\d+$/.test(api || '') ? Number(api) : null } };
}

function analyzeHarmonyLogs(text) {
  const lines = String(text || '').split(/\r?\n/).slice(-2000);
  const definitions = [
    { label: tr('鸿蒙 JS 崩溃'), pattern: /\b(?:JS_CRASH|JS_ERROR)\b/i, severity: 'high' },
    { label: tr('鸿蒙 C++ 崩溃'), pattern: /\b(?:CPP_CRASH|APP_CRASH)\b/i, severity: 'high' },
    { label: tr('鸿蒙应用无响应'), pattern: /\b(?:APP_FREEZE|AppFreeze)\b/i, severity: 'high' }
  ];
  const issues = definitions.flatMap(item => {
    const matching = lines.filter(line => item.pattern.test(line));
    return matching.length ? [{ label: item.label, severity: item.severity, count: matching.length, detail: matching.slice(-3).join('\n').slice(0, 2000) }] : [];
  });
  return { issues, matchedCount: issues.reduce((sum, item) => sum + item.count, 0),
    topPatterns: issues.map(item => item.label), matchedLines: lines.filter(line => definitions.some(item => item.pattern.test(line))).slice(-100) };
}

async function collectHarmonyQualitySnapshot(deviceId, options = {}, dependencies = {}) {
  const deviceRef = resolveDeviceRef(deviceId, options), native = { ...options, deviceRef };
  const info = await readHarmonyDeviceInfo(deviceId, native, dependencies.runHdc || runHdc);
  const [packagesResult, logResult, performanceResult] = await Promise.all([
    (dependencies.listPackages || listPackages)(deviceId, native).then(packages => ({ packages, error: '' })).catch(error => ({ packages: [], error: error.message })),
    (dependencies.readHiLogSnapshot || readHiLogSnapshot)(deviceId, { ...native, maxLines: 600 }),
    options.includePerformance === false ? Promise.resolve({ snapshot: null, skipped: true })
      : (dependencies.collectHarmonySnapshot || collectHarmonySnapshot)(deviceId, { ...native, includeProcesses: false, timeoutMs: 12000 })
        .then(snapshot => ({ snapshot, error: snapshot.sampleError || '' })).catch(error => ({ snapshot: null, error: error.message }))
  ]);
  const packages = packagesResult.packages || [];
  const versionMetadataIncomplete = packages.some(item => (item.versionCode === null || item.versionCode === undefined || item.versionCode === '')
    && (item.versionName === null || item.versionName === undefined || item.versionName === ''));
  return { deviceId, platform: 'harmony', transport: 'hdc', capturedAt: new Date().toISOString(), device: info.device, props: info.props,
    propertyErrors: info.errors, packages, packageError: packagesResult.error, versionMetadataIncomplete,
    performance: performanceResult.snapshot, performanceSkipped: performanceResult.skipped === true, performanceError: performanceResult.error || '',
    logs: analyzeHarmonyLogs(logResult.ok ? logResult.stdout : ''), logError: logResult.ok ? '' : logResult.error || tr('鸿蒙日志采集失败。') };
}

module.exports = { PARAMS, taskReadOptions, checkHarmonyDevice, readHarmonyDeviceInfo, analyzeHarmonyLogs, collectHarmonyQualitySnapshot };
