const { tr } = require('./localization.cjs');

const APP_CHECKS = Object.freeze(['app_package', 'app_process', 'app_memory', 'app_activity']);
const CHECK_IDS = Object.freeze(['device_info', 'logcat_snapshot', 'performance_snapshot', ...APP_CHECKS]);
const PACKAGE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
function normalizeDiagnostic(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['packageName', 'symptom'].includes(key))
    || typeof value.packageName !== 'string' || value.packageName.length > 200
    || (value.packageName && !PACKAGE.test(value.packageName)) || !['', 'crash', 'launch', 'slow'].includes(value.symptom || '')) {
    throw Object.assign(new Error(tr('请填写有效的应用包名并选择受支持的问题类型。')), { code: 'AI_DIAGNOSTIC', safe: true });
  }
  return { packageName: value.packageName, symptom: value.symptom || '' };
}
function diagnosticPresets() {
  return [
    { id: 'crash', label: tr('应用闪退'), checks: ['app_package', 'app_process', 'logcat_snapshot'], requiresPackage: true },
    { id: 'launch', label: tr('应用无法打开'), checks: ['app_package', 'app_activity', 'logcat_snapshot'], requiresPackage: true },
    { id: 'slow', label: tr('应用卡顿 / 内存'), checks: ['app_process', 'app_memory', 'performance_snapshot'], requiresPackage: true },
  ];
}
function diagnosticChecks() {
  return [
    { id: 'device_info', label: tr('设备基础信息'), description: tr('只读采集型号、Android 版本和启动时长。') },
    { id: 'logcat_snapshot', label: tr('近期设备日志'), description: tr('只读最近 2000 行日志，不清空或持续抓取。') },
    { id: 'performance_snapshot', label: tr('性能基础读数'), description: tr('只读内存、CPU 统计和存储空间。') },
    { id: 'app_package', label: tr('应用版本与安装状态'), description: tr('仅读取所选包的版本、安装与启用状态，不修改权限。') },
    { id: 'app_process', label: tr('应用进程状态'), description: tr('仅读取所选包的进程编号，不启动或结束进程。') },
    { id: 'app_memory', label: tr('应用内存快照'), description: tr('仅读取所选应用的内存统计，不执行清理。') },
    { id: 'app_activity', label: tr('应用页面状态'), description: tr('仅读取所选应用相关的 Activity 状态，不打开页面。') },
  ];
}
function diagnosticCommand(check, diagnostic) {
  if (!APP_CHECKS.includes(check)) return null;
  const normalized = normalizeDiagnostic(diagnostic);
  if (!normalized?.packageName) throw Object.assign(new Error(tr('专项检查需要明确选择应用包名。')), { code: 'AI_DIAGNOSTIC', safe: true });
  const name = normalized.packageName;
  return { app_package: ['shell', 'dumpsys', 'package', name], app_process: ['shell', 'pidof', name],
    app_memory: ['shell', 'dumpsys', 'meminfo', name], app_activity: ['shell', 'dumpsys', 'activity', 'activities'] }[check];
}
function shapeDiagnosticSource(source) {
  if (!APP_CHECKS.includes(source.checkId)) return source;
  const name = normalizeDiagnostic(source.diagnostic)?.packageName;
  const lines = String(source.text || '').split(/\r?\n/);
  let selected;
  if (source.checkId === 'app_package') selected = lines.filter(line => /versionCode=|versionName=|firstInstallTime=|lastUpdateTime=|User \d+:|enabled=|installed=/.test(line));
  else if (source.checkId === 'app_activity') {
    const exactPackage = new RegExp(`(?:^|[^A-Za-z0-9_.])${name.replace(/\./g, '\\.')}($|[^A-Za-z0-9_.])`);
    selected = lines.filter(line => exactPackage.test(line));
  } else if (source.checkId === 'app_process') selected = lines.filter(line => /^\s*\d+(?:\s+\d+)*\s*$/.test(line));
  else selected = lines.filter(line => !/No process found|Can't find service|not found|Permission Denial/i.test(line));
  const unavailable = source.unavailable || /No process found|Can't find service|not found|Permission Denial|No such service|Unknown command|^Error:/im.test(source.text || '') || !selected.some(line => line.trim());
  return { ...source, unavailable, text: unavailable
    ? tr('检查不可用或未发现目标状态；不能据此确认应用正常或故障原因。')
    : `${tr('目标应用：{0}', { 0: name })}\n${selected.slice(0, 2000).join('\n')}` };
}
module.exports = { APP_CHECKS, CHECK_IDS, normalizeDiagnostic, diagnosticChecks, diagnosticPresets, diagnosticCommand, shapeDiagnosticSource };
