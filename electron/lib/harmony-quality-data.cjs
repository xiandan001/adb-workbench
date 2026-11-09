const { tr } = require('./localization.cjs');

const measured = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
function harmonyMetricValues(snapshot = {}) {
  const temperatures = [snapshot.battery?.temperature, snapshot.thermal?.hottest].map(measured).filter(value => value !== null);
  const disks = Array.isArray(snapshot.disk) ? snapshot.disk : [];
  const data = disks.find(item => item.mount === '/data') || disks.find(item => String(item.mount || '').startsWith('/data/'));
  return { cpu: measured(snapshot.cpu?.usage), memory: measured(snapshot.memory?.usage),
    batteryTemp: temperatures.length ? Math.max(...temperatures) : null, dataUsed: measured(data?.usage) };
}

function evaluateHarmonyThresholds(snapshot, thresholds = {}) {
  const values = harmonyMetricValues(snapshot), warnings = [];
  const labels = { cpu: tr('CPU 使用率'), memory: tr('内存使用率'), batteryTemp: tr('温度'), dataUsed: tr('存储空间使用率') };
  for (const [metric, value] of Object.entries(values)) {
    const rawLimit = thresholds[metric], limit = Number(rawLimit);
    if (rawLimit === null || rawLimit === undefined || rawLimit === '' || !Number.isFinite(limit) || limit <= 0) continue;
    if (value === null) warnings.push({ type: metric, metric, unavailable: true, fail: true,
      label: tr('未取得可验证的 {0}，不能判定该阈值通过。', { 0: labels[metric] }) });
    else if (value > limit) warnings.push({ type: metric, metric, value, limit, fail: true,
      label: tr('{0} 超限', { 0: labels[metric] }) });
  }
  return warnings;
}

function compareHarmonyQuality(baseline, current, comparePackages, metricDelta) {
  const findings = [], propDiffs = [];
  const unverifiable = detail => findings.push({ severity: 'medium', label: tr('部分回归项目未验证'), detail });
  for (const key of ['const.product.model', 'const.product.software.version', 'const.ohos.apiversion']) {
    const before = baseline.props?.[key], after = current.props?.[key];
    if (!before || !after) unverifiable(key);
    else if (before !== after) {
      propDiffs.push({ key, before, after });
      findings.push({ severity: 'medium', label: tr('系统属性变化：{0}', { 0: key }), detail: `${before} -> ${after}` });
    }
  }
  const packageDiff = baseline.packageError || current.packageError ? { added: [], removed: [], changed: [] } : comparePackages(baseline.packages || [], current.packages || []);
  if (baseline.packageError || current.packageError) unverifiable([baseline.packageError, current.packageError].filter(Boolean).join('\n'));
  if (baseline.versionMetadataIncomplete || current.versionMetadataIncomplete) unverifiable(tr('仅取得部分应用名单，缺少版本信息的应用不判定版本变化。'));
  packageDiff.changed = packageDiff.changed.map(item => ({ ...item, changes: item.changes.filter(change => change.before !== '' && change.before != null && change.after !== '' && change.after != null) })).filter(item => item.changes.length);
  for (const item of packageDiff.added) findings.push({ severity: 'low', label: tr('应用新增：{0}', { 0: item.packageName }), detail: item.versionName || item.versionCode || '' });
  for (const item of packageDiff.removed) findings.push({ severity: item.system === true ? 'high' : 'medium', label: tr('应用减少：{0}', { 0: item.packageName }), detail: item.versionName || item.versionCode || '' });
  for (const item of packageDiff.changed) findings.push({ severity: 'medium', label: tr('应用变化：{0}', { 0: item.packageName }), detail: item.changes.map(change => `${change.key}: ${change.before} -> ${change.after}`).join('; ') });
  const performanceDiff = { warnings: [], metrics: [], skipped: current.performanceSkipped === true };
  if (!performanceDiff.skipped) {
    const before = harmonyMetricValues(baseline.performance || {}), after = harmonyMetricValues(current.performance || {});
    for (const [key, label, suffix, threshold] of [['cpu', 'CPU', '%', 30], ['memory', tr('内存'), '%', 20], ['dataUsed', tr('存储空间'), '%', 10], ['batteryTemp', tr('温度'), '°C', 8]]) {
      if (before[key] === null || after[key] === null) { unverifiable(tr('缺少 {0} 的成对有效样本。', { 0: tr(label) })); continue; }
      const metric = metricDelta(label, before[key], after[key], suffix, threshold);
      metric.severity = key === 'dataUsed' ? 'low' : 'medium';
      performanceDiff.metrics.push(metric);
      if (metric.regressed) performanceDiff.warnings.push({ severity: metric.severity, label: tr('性能回退：{0}', { 0: metric.label }), detail: `${metric.beforeText} -> ${metric.afterText}` });
    }
    for (const item of current.performance?.unavailable || []) if (item.metric === 'fps') unverifiable(item.reason || tr('帧率未验证'));
    if (current.performanceError || baseline.performanceError) unverifiable([baseline.performanceError, current.performanceError].filter(Boolean).join('\n'));
    findings.push(...performanceDiff.warnings);
  }
  if (current.logError) unverifiable(current.logError);
  const logIssues = current.logs?.issues || [];
  findings.push(...logIssues.map(item => ({ severity: item.severity, label: tr('日志异常：{0}', { 0: item.label }), detail: item.detail })));
  const highCount = findings.filter(item => item.severity === 'high').length, mediumCount = findings.filter(item => item.severity === 'medium').length;
  return { summary: findings.length ? tr('发现 {0} 项差异、风险或未验证项目', { 0: findings.length }) : tr('已验证项目未发现回归差异'),
    highCount, mediumCount, lowCount: findings.length - highCount - mediumCount, propDiffs, packageDiff, performanceDiff, logIssues, findings };
}

module.exports = { measured, harmonyMetricValues, evaluateHarmonyThresholds, compareHarmonyQuality };
