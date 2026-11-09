const fs = require('node:fs/promises');
const path = require('node:path');
const { tr } = require('./localization.cjs');
const { runHdc } = require('./hdc-runtime.cjs');
const { collectHarmonySnapshot } = require('./harmony-metrics.cjs');
const { listPackages } = require('./harmony-apps.cjs');
const { readHiLogSnapshot } = require('./harmony-log.cjs');
const { captureScreenshot } = require('./harmony-media.cjs');
const { taskReadOptions, readHarmonyDeviceInfo, analyzeHarmonyLogs } = require('./harmony-quality-native.cjs');
const { evaluateHarmonyThresholds } = require('./harmony-quality-data.cjs');

function harmonyInspectionSteps(includeBugreport) {
  const definitions = [
    ['harmony-device', tr('采集鸿蒙设备参数'), 'device', 'harmony-device.json'],
    ['identity', tr('检查当前用户身份'), 'identity', 'identity.txt'],
    ['uptime', tr('采集运行时间'), 'uptime', 'uptime.txt'],
    ['harmony-performance', tr('采集鸿蒙性能与可用性'), 'performance', 'harmony-performance.json'],
    ['harmony-packages', tr('采集鸿蒙应用列表'), 'packages', 'harmony-packages.json'],
    ['harmony-logs', tr('采集 HiLog 日志'), 'logs', 'hilog.txt'],
    ['screenshot', tr('采集屏幕截图'), 'screenshot', 'screen.png'],
    ...(includeBugreport ? [['bugreport', tr('生成原生 bugreport'), 'bugreport', 'harmony-bugreport.txt']] : [])
  ];
  return definitions.map(([id, label, nativeOperation, file]) => ({ id, label, nativeOperation, file, kind: 'harmony', timeout: nativeOperation === 'bugreport' ? 300000 : 30000 }));
}

async function executeHarmonyInspectionStep(task, deviceId, step, dirs) {
  const options = taskReadOptions(task, deviceId, { timeoutMs: step.timeout });
  const filename = path.join(step.nativeOperation === 'screenshot' ? dirs.media : dirs.raw, step.file);
  let result, data = null, content = '', unavailable = [];
  if (step.nativeOperation === 'screenshot') {
    result = await captureScreenshot(deviceId, filename, options);
    return { id: step.id, label: step.label, platform: 'harmony', ok: result.ok, error: result.error || '', file: result.ok ? filename : '', bytes: result.ok ? (await fs.stat(filename)).size : 0 };
  }
  if (step.nativeOperation === 'device') {
    data = await readHarmonyDeviceInfo(deviceId, options); unavailable = data.errors;
    result = { ok: !unavailable.length, error: unavailable.join('\n') }; content = JSON.stringify(data, null, 2);
  } else if (step.nativeOperation === 'performance') {
    data = await collectHarmonySnapshot(deviceId, options); unavailable = (data.unavailable || []).map(item => `${item.metric}: ${item.reason}`);
    result = { ok: !data.sampleError && !unavailable.length, error: data.sampleError || (unavailable.length ? tr('部分性能项目未验证，原始样本已保存。') : '') }; content = JSON.stringify(data, null, 2);
  } else if (step.nativeOperation === 'packages') {
    data = await listPackages(deviceId, options); content = JSON.stringify(data, null, 2);
    if (data.some(item => (item.versionCode === '' || item.versionCode == null) && (item.versionName === '' || item.versionName == null))) unavailable.push(tr('部分应用仅取得 Bundle 名称，版本与系统类型未验证。'));
    result = { ok: true };
  } else {
    if (step.nativeOperation === 'logs') result = await readHiLogSnapshot(deviceId, { ...options, maxLines: 2000 });
    else if (step.nativeOperation === 'bugreport') result = await runHdc(deviceId, ['bugreport'], { ...options, maxBuffer: 16 * 1024 * 1024 });
    else result = await runHdc(deviceId, ['shell', ...(step.nativeOperation === 'identity' ? ['id'] : ['cat', '/proc/uptime'])], options);
    content = String(result.stdout || result.stderr || '');
  }
  await fs.writeFile(filename, content, 'utf8');
  return { id: step.id, label: step.label, platform: 'harmony', ok: result.ok, error: result.error || '', file: filename,
    bytes: Buffer.byteLength(content), nativeData: data, unavailable, ...(step.nativeOperation === 'logs' ? { logAnalysis: analyzeHarmonyLogs(result.ok ? result.stdout : '') } : {}) };
}

function harmonyInspectionAnalysis(results, errors) {
  const findings = results.flatMap(item => (item.logAnalysis?.issues || []).map(issue => ({ severity: issue.severity, label: issue.label, detail: issue.detail })));
  const snapshot = results.find(item => item.id === 'harmony-performance')?.nativeData;
  if (snapshot) for (const warning of evaluateHarmonyThresholds(snapshot, { memory: 85, batteryTemp: 45, dataUsed: 90 })) {
    findings.push({ severity: warning.unavailable ? 'medium' : warning.type === 'batteryTemp' ? 'high' : 'medium', label: warning.label, detail: warning.unavailable ? tr('该指标未验证') : `${warning.value} > ${warning.limit}` });
  }
  const unavailable = [...new Set(results.flatMap(item => item.unavailable || []))];
  if (unavailable.length) findings.push({ severity: 'medium', label: tr('部分巡检能力未验证'), detail: unavailable.join('\n') });
  errors.filter(item => item.id !== 'cancelled').forEach(item => findings.push({ severity: 'medium', label: tr('{0} 未完成', { 0: item.label || item.id }), detail: item.error || '' }));
  const severity = findings.some(item => item.severity === 'high') ? 'high' : findings.length ? 'medium' : 'normal';
  return { severity, findings, unavailable, summary: findings.length ? tr('发现 {0} 项风险或未验证项目', { 0: findings.length }) : tr('已采集的鸿蒙巡检项目未发现明确风险。') };
}

function buildHarmonyInspectionReport(state, results, errors, dirs, formatAiAnalysisLines) {
  const lines = [tr('# 鸿蒙设备巡检报告'), '', tr('- 设备平台：Harmony/OpenHarmony'), tr('- 设备 ID：{0}', { 0: state.deviceId }),
    tr('- 开始时间：{0}', { 0: state.startedAt }), tr('- 结束时间：{0}', { 0: state.endedAt || '' }),
    tr('- 不可用指标标为未验证，不作为零值或正常结论。'), '', tr('## 巡检概要'), '', state.analysis?.summary || '', '',
    tr('| 项目 | 状态 | 证据 |'), '| --- | --- | --- |'];
  for (const item of results) lines.push(`| ${item.label} | ${item.unavailable?.length ? tr('部分完成') : item.ok ? tr('成功') : tr('失败')} | ${item.file ? path.relative(dirs.root, item.file).replaceAll('\\', '/') : '-'} |`);
  lines.push('', tr('## 风险与未验证项目'), '');
  for (const item of state.analysis?.findings || []) lines.push(`- [${item.severity}] ${item.label}: ${item.detail || '-'}`);
  for (const item of errors) lines.push(`- ${item.label || item.id}: ${item.error || '-'}`);
  lines.push('', tr('## AI 总结'), '', ...formatAiAnalysisLines(state.aiSummary));
  return lines.join('\n') + '\n';
}

module.exports = { harmonyInspectionSteps, executeHarmonyInspectionStep, harmonyInspectionAnalysis, buildHarmonyInspectionReport };
