// Acceptance suites: build practical task-center scripts from common QA flows.

const fs = require('fs');
const taskCenter = require('./task-center.cjs');

const DEFAULT_LAUNCH_WAIT_MS = 5000;

const SUITES = [
  {
    id: 'smoke',
    name: '基础冒烟验收',
    description: '回到桌面、采集截图和性能快照，并检查 Crash/ANR 日志。',
    required: []
  },
  {
    id: 'install-launch',
    name: '安装后启动验收',
    description: '安装 APK、清理日志、启动目标应用并采集首屏与性能证据。',
    required: ['apkPath', 'packageName']
  },
  {
    id: 'launch-stability',
    name: '启动稳定性验收',
    description: '按设定轮次反复启动应用，自动生成压测验收报告。',
    required: ['packageName']
  },
  {
    id: 'visual-compare',
    name: '页面截图比对验收',
    description: '采集当前页面截图，与基准图比对相似度并生成结果。',
    required: ['baselinePath']
  }
];

function register(ipcMain) {
  ipcMain.handle('acceptance:listSuites', async () => ({ ok: true, suites: SUITES }));

  ipcMain.handle('acceptance:run', async (event, args) => {
    try {
      return await runAcceptanceSuite(args || {}, event.sender);
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
}

async function runAcceptanceSuite(args, sender) {
  const suiteId = String(args?.suiteId || '').trim() || 'smoke';
  const suite = SUITES.find(item => item.id === suiteId);
  if (!suite) return { ok: false, error: 'acceptance_suite_not_found' };
  const deviceIds = normalizeDeviceIds(args?.deviceIds);
  if (deviceIds.length === 0) return { ok: false, error: '请至少选择一台在线设备' };
  const script = buildSuiteScript(suiteId, args);
  return taskCenter.runInlineScript(script, deviceIds, sender, {
    outputBaseDir: args?.outputBaseDir,
    concurrency: clampNumber(args?.concurrency, 1, 4, 1),
    continueOnError: script.continueOnError
  });
}

function buildSuiteScript(suiteId, args) {
  if (suiteId === 'install-launch') return buildInstallLaunchSuite(args);
  if (suiteId === 'launch-stability') return buildLaunchStabilitySuite(args);
  if (suiteId === 'visual-compare') return buildVisualCompareSuite(args);
  return buildSmokeSuite(args);
}

function buildSmokeSuite(args) {
  return baseStressScript({
    id: 'acceptance-smoke',
    name: String(args?.name || '').trim() || '基础冒烟验收',
    description: '回到桌面、采集截图和性能快照，并检查 Crash/ANR 日志。',
    loop: { count: 1, intervalMs: 0 },
    report: { includePerformance: true },
    steps: [
      { id: 'model', type: 'shell', label: '读取设备型号', command: 'getprop ro.product.model', timeoutMs: 15000 },
      { id: 'home', type: 'keyevent', label: '返回桌面', keyCode: 'HOME', timeoutMs: 10000 },
      { id: 'wait-home', type: 'delay', label: '等待桌面稳定', durationMs: 1200 },
      { id: 'screen', type: 'screenshot', label: '采集当前截图', timeoutMs: 30000 },
      { id: 'perf', type: 'perfSnapshot', label: '采集性能快照', timeoutMs: 30000 }
    ]
  });
}

function buildInstallLaunchSuite(args) {
  const apkPath = requireFile(args?.apkPath, 'apk_required');
  const packageName = requirePackageName(args?.packageName);
  const waitMs = clampNumber(args?.launchWaitMs, 1000, 60000, DEFAULT_LAUNCH_WAIT_MS);
  return baseStressScript({
    id: 'acceptance-install-launch',
    name: String(args?.name || '').trim() || '安装后启动验收',
    description: '安装 APK、清理日志、启动目标应用并采集首屏与性能证据。',
    loop: { count: 1, intervalMs: 0 },
    report: { includePerformance: true },
    steps: [
      { id: 'install', type: 'installApk', label: '安装 APK', localPath: apkPath, timeoutMs: 180000, critical: true },
      { id: 'clear-log', type: 'shell', label: '清理日志缓冲区', command: 'logcat -c', timeoutMs: 15000, continueOnError: true },
      { id: 'launch', type: 'shell', label: '启动目标应用', command: `monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`, timeoutMs: 30000, critical: true },
      { id: 'wait-launch', type: 'delay', label: '等待首屏稳定', durationMs: waitMs },
      { id: 'screen', type: 'screenshot', label: '采集首屏截图', timeoutMs: 30000 },
      { id: 'perf', type: 'perfSnapshot', label: '采集性能快照', timeoutMs: 30000 }
    ]
  });
}

function buildLaunchStabilitySuite(args) {
  const packageName = requirePackageName(args?.packageName);
  const rounds = clampNumber(args?.rounds, 1, 100, 5);
  const waitMs = clampNumber(args?.launchWaitMs, 1000, 60000, DEFAULT_LAUNCH_WAIT_MS);
  const intervalMs = clampNumber(args?.intervalMs, 0, 600000, 1000);
  return baseStressScript({
    id: 'acceptance-launch-stability',
    name: String(args?.name || '').trim() || '启动稳定性验收',
    description: `反复启动 ${packageName} ${rounds} 轮，检查 Crash/ANR 并采集性能证据。`,
    loop: { count: rounds, intervalMs, continueOnError: false },
    report: { includePerformance: true },
    steps: [
      { id: 'clear-log', type: 'shell', label: '清理日志缓冲区', command: 'logcat -c', timeoutMs: 15000, continueOnError: true },
      { id: 'stop', type: 'shell', label: '停止目标应用', command: `am force-stop ${packageName}`, timeoutMs: 15000, continueOnError: true },
      { id: 'launch', type: 'shell', label: '启动目标应用', command: `monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`, timeoutMs: 30000, critical: true },
      { id: 'wait-launch', type: 'delay', label: '等待首屏稳定', durationMs: waitMs },
      { id: 'screen', type: 'screenshot', label: '采集当前截图', timeoutMs: 30000 }
    ]
  });
}

function buildVisualCompareSuite(args) {
  const baselinePath = requireFile(args?.baselinePath, 'baseline_image_required');
  const threshold = clampNumber(args?.threshold, 1, 100, 98);
  return baseStressScript({
    id: 'acceptance-visual-compare',
    name: String(args?.name || '').trim() || '页面截图比对验收',
    description: `截图相似度阈值 ${threshold}%。`,
    loop: { count: 1, intervalMs: 0 },
    report: { includePerformance: false },
    steps: [
      { id: 'compare', type: 'imageCompare', label: '截图比对', baselinePath, threshold, timeoutMs: 30000, critical: true },
      { id: 'perf', type: 'perfSnapshot', label: '采集性能快照', timeoutMs: 30000, continueOnError: true }
    ]
  });
}

function baseStressScript(source) {
  return {
    mode: 'stress',
    continueOnError: false,
    acceptance: {
      minSuccessRate: 100,
      failOnCrash: true,
      failOnAnr: true,
      thresholds: {}
    },
    ...source
  };
}

function requireFile(value, errorCode) {
  const filePath = String(value || '').trim();
  if (!filePath) throw new Error(errorCode);
  if (!fs.existsSync(filePath)) throw new Error(`file_not_found:${filePath}`);
  return filePath;
}

function requirePackageName(value) {
  const packageName = String(value || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(packageName)) {
    throw new Error('package_name_invalid');
  }
  return packageName;
}

function normalizeDeviceIds(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(item => String(item || '').trim()).filter(Boolean)));
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

module.exports = { register, runAcceptanceSuite, buildSuiteScript };
