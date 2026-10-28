const { tr } = require('./localization.cjs');
// One-click troubleshooting wizard backend.

const { app, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const packageManager = require('./package-manager.cjs');
const performanceMonitor = require('./performance-monitor.cjs');
const inspection = require('./inspection.cjs');
const vip = require('./vip.cjs');
const aiAnalyze = require('./ai-analyze.cjs');
const { bindSummaryLifetime } = require('./ai-source-lifecycle.cjs');
const { getAppVersion } = require('./version.cjs');
const { runAdb: runRuntimeAdb } = require('./adb-runtime.cjs');

const COMMAND_TIMEOUT_MS = 15000;
const LOG_TIMEOUT_MS = 30000;

const ISSUE_TYPES = {
  crash: {
    label: '应用闪退/崩溃',
    patterns: [/FATAL EXCEPTION/i, /AndroidRuntime/i, /Fatal signal/i, /SIGSEGV/i, /tombstone/i]
  },
  freeze: {
    label: '卡顿/无响应',
    patterns: [/ANR/i, /Application Not Responding/i, /Input dispatching timed out/i, /am_anr/i]
  },
  install: {
    label: '安装/启动失败',
    patterns: [/INSTALL_FAILED/i, /PackageManager/i, /ActivityTaskManager/i, /Unable to start/i, /ClassNotFoundException/i]
  },
  performance: {
    label: '发热/性能异常',
    patterns: [/lowmemorykiller/i, /OutOfMemory/i, /Skipped \d+ frames/i, /Janky/i, /GC_FOR_ALLOC/i]
  },
  connection: {
    label: '设备连接异常',
    patterns: [/adbd/i, /offline/i, /unauthorized/i, /device not found/i, /transport/i]
  },
  generic: {
    label: '通用问题排查',
    patterns: [/FATAL EXCEPTION/i, /ANR/i, /Fatal signal/i, /OutOfMemory/i, /INSTALL_FAILED/i]
  }
};

let currentTask = null;
let lastTask = null;

function register(ipcMain) {
  ipcMain.handle('troubleshooting:start', async (event, args) => {
    if (currentTask) return { ok: false, error: tr("已有问题排查任务正在执行，请先等待或取消当前任务") };

    const deviceId = normalizeDeviceId(args?.deviceId);
    if (!deviceId) return { ok: false, error: tr("请选择在线设备") };

    const task = {
      id: `trouble-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      sender: event.sender,
      deviceId,
      deviceLabel: String(args?.deviceLabel || deviceId).trim(),
      issueType: ISSUE_TYPES[args?.issueType] ? args.issueType : 'generic',
      packageName: normalizePackageName(args?.packageName),
      includeInspection: args?.includeInspection !== false,
      includeAiSummary: args?.includeAiSummary === true,
      cancelled: false,
      currentProc: null,
      status: 'running',
      startedAt: new Date().toISOString(),
      steps: createStepState({
        includeInspection: args?.includeInspection !== false,
        includeAiSummary: args?.includeAiSummary === true
      }),
      result: null
    };

    currentTask = task;
    lastTask = publicTask(task);
    runTroubleshooting(task)
      .then((result) => {
        task.status = task.cancelled ? 'cancelled' : result.ok ? 'success' : 'failed';
        task.result = result;
        lastTask = publicTask(task);
        sendDone(task, result);
      })
      .catch((error) => {
        const result = { ok: false, error: error.message || tr("问题排查失败") };
        task.status = 'failed';
        task.result = result;
        lastTask = publicTask(task);
        sendDone(task, result);
      })
      .finally(() => {
        if (currentTask === task) currentTask = null;
      });

    return { ok: true, task: publicTask(task) };
  });

  ipcMain.handle('troubleshooting:cancel', async () => {
    if (!currentTask) return { ok: true, cancelled: false };
    currentTask.cancelled = true;
    currentTask.aiSummaryController?.abort();
    currentTask.status = 'cancelling';
    if (currentTask.currentProc) {
      try { currentTask.currentProc.kill(); } catch {}
    }
    lastTask = publicTask(currentTask);
    sendProgress(currentTask, 'cancel', 'running', tr("正在取消当前排查任务"));
    return { ok: true, cancelled: true };
  });

  ipcMain.handle('troubleshooting:state', async () => {
    return { ok: true, task: currentTask ? publicTask(currentTask) : lastTask };
  });

  ipcMain.handle('troubleshooting:openFolder', async (event, folderPath) => {
    if (!folderPath || typeof folderPath !== 'string') return { ok: false, error: tr("目录路径不能为空") };
    const error = await shell.openPath(folderPath);
    return error ? { ok: false, error } : { ok: true };
  });
}

async function runTroubleshooting(task) {
  const lifetime = bindSummaryLifetime(task);
  try { return await runTroubleshootingBody(task); }
  finally { lifetime.dispose(); }
}

async function runTroubleshootingBody(task) {
  const vipStatus = await vip.getStatusAsync();
  const outputDir = await createOutputDir(task);
  const rawDir = path.join(outputDir, 'raw');
  await fs.promises.mkdir(rawDir, { recursive: true });

  const context = {
    taskId: task.id,
    appVersion: getAppVersion(),
    deviceId: task.deviceId,
    deviceLabel: task.deviceLabel,
    issueType: task.issueType,
    issueLabel: tr(ISSUE_TYPES[task.issueType].label),
    packageName: task.packageName,
    startedAt: task.startedAt,
    outputDir,
    rawDir,
    vip: vipStatus.activated === true,
    includeAiSummary: task.includeAiSummary,
    artifacts: [],
    checks: []
  };

  await writeJson(path.join(outputDir, 'metadata.json'), {
    taskId: task.id,
    appVersion: context.appVersion,
    deviceId: task.deviceId,
    issueType: task.issueType,
    packageName: task.packageName,
    includeAiSummary: task.includeAiSummary,
    startedAt: task.startedAt
  });

  await runStep(task, 'device', tr("检查设备连接"), async () => {
    const state = await runAdb(task, ['-s', task.deviceId, 'get-state'], COMMAND_TIMEOUT_MS);
    const devices = await runAdb(task, ['devices', '-l'], COMMAND_TIMEOUT_MS);
    const props = await runAdb(task, ['-s', task.deviceId, 'shell', 'getprop ro.product.model; getprop ro.build.version.release; getprop ro.build.display.id'], COMMAND_TIMEOUT_MS);
    await writeText(path.join(rawDir, 'adb-devices.txt'), devices.stdout || devices.stderr || '');
    await writeText(path.join(rawDir, 'device-props.txt'), props.stdout || props.stderr || '');
    const online = state.ok && String(state.stdout || '').trim() === 'device';
    context.device = parseDeviceProps(props.stdout);
    context.checks.push({
      key: 'device',
      ok: online,
      label: online ? tr("设备在线，可执行 ADB 命令") : tr("设备不可用"),
      detail: online ? task.deviceId : state.error || state.stderr || tr("ADB 未返回 device 状态")
    });
    if (!online) throw new Error(state.error || state.stderr || tr("设备不在线或未授权"));
    return { detail: context.device.model || task.deviceId };
  });

  if (task.cancelled) return finishCancelled(task, context);

  if (task.packageName) {
    await runStep(task, 'package', tr("读取应用包信息"), async () => {
      const detail = await packageManager.getPackageDetail(task.deviceId, task.packageName);
      context.packageDetail = detail;
      const detailPath = path.join(rawDir, 'package-detail.json');
      await writeJson(detailPath, detail);
      context.artifacts.push({ type: 'json', label: tr("应用详情"), path: detailPath });
      context.checks.push({
        key: 'package',
        ok: true,
        label: tr("已找到目标应用"),
        detail: `${detail.packageName || task.packageName} ${detail.versionName || ''}`.trim()
      });
      return { detail: detail.versionName || detail.apkPath || task.packageName };
    });
  } else {
    markStep(task, 'package', 'skipped', tr("未填写包名，已跳过应用定向检查"));
    context.checks.push({ key: 'package', ok: true, skipped: true, label: tr("未填写包名"), detail: tr("本次执行通用排查") });
  }

  if (task.cancelled) return finishCancelled(task, context);

  await runStep(task, 'performance', tr("采集性能快照"), async () => {
    const snapshot = await performanceMonitor.collectSnapshot(task.deviceId, vipStatus.activated === true, {
      timeoutMs: 12000,
      fallbackToLegacy: true
    });
    context.performance = snapshot;
    const snapshotPath = path.join(rawDir, 'performance-snapshot.json');
    await writeJson(snapshotPath, snapshot);
    context.artifacts.push({ type: 'json', label: tr("性能快照"), path: snapshotPath });
    const warnings = Array.isArray(snapshot.warnings) ? snapshot.warnings : [];
    context.checks.push({
      key: 'performance',
      ok: warnings.length === 0,
      label: warnings.length ? tr("发现 {0} 项性能告警", { 0: warnings.length }) : tr("性能快照未发现阈值告警"),
      detail: summarizePerformance(snapshot)
    });
    return { detail: summarizePerformance(snapshot) };
  });

  if (task.cancelled) return finishCancelled(task, context);

  await runStep(task, 'logs', tr("抓取并筛选关键日志"), async () => {
    const log = await runAdb(task, ['-s', task.deviceId, 'logcat', '-d', '-v', 'threadtime', '-t', '600'], LOG_TIMEOUT_MS);
    const logText = log.stdout || log.stderr || '';
    const logPath = path.join(rawDir, 'logcat-tail.txt');
    await writeText(logPath, logText);
    context.artifacts.push({ type: 'text', label: tr("最近日志"), path: logPath });
    context.logSummary = analyzeLogs(logText, task.issueType, task.packageName);
    const excerptPath = path.join(rawDir, 'matched-log-excerpt.txt');
    await writeText(excerptPath, context.logSummary.matchedLines.join('\n'));
    context.artifacts.push({ type: 'text', label: tr("命中日志片段"), path: excerptPath });
    context.checks.push({
      key: 'logs',
      ok: context.logSummary.matchedCount === 0,
      label: context.logSummary.matchedCount ? tr("命中 {0} 条可疑日志", { 0: context.logSummary.matchedCount }) : tr("最近日志未命中高风险关键词"),
      detail: context.logSummary.topPatterns.join('、') || tr("无明显异常关键词")
    });
    return { detail: tr("{0} 条命中", { 0: context.logSummary.matchedCount }) };
  });

  if (task.cancelled) return finishCancelled(task, context);

  if (task.includeInspection && vipStatus.activated === true) {
    await runStep(task, 'inspection', tr("生成巡检报告和证据包"), async () => {
      const inspectionTask = createSilentInspectionTask(task);
      const result = await inspection.runInspection(inspectionTask, {
        deviceId: task.deviceId,
        deviceLabel: task.deviceLabel,
        includeBugreport: false,
        includeAiSummary: false,
        outputBaseDir: path.join(outputDir, 'inspection')
      });
      context.inspection = result;
      if (result.reportPath) context.artifacts.push({ type: 'report', label: tr("巡检报告"), path: result.reportPath });
      if (result.zipPath) context.artifacts.push({ type: 'zip', label: tr("巡检证据包"), path: result.zipPath });
      context.checks.push({
        key: 'inspection',
        ok: result.ok !== false && !result.cancelled,
        label: result.ok === false ? tr("巡检执行失败") : tr("巡检报告已生成"),
        detail: result.reportPath || result.error || ''
      });
      return { detail: result.reportPath || tr("巡检完成") };
    });
  } else {
    const detail = vipStatus.activated === true ? tr("已按用户选择跳过巡检") : tr("当前为基础版，巡检证据包需会员版");
    markStep(task, 'inspection', 'skipped', detail);
    context.checks.push({ key: 'inspection', ok: true, skipped: true, label: tr("巡检已跳过"), detail });
  }

  await prepareAiSummary(task, context);
  if (task.cancelled) return finishCancelled(task, context);
  return finishTask(task, context);
}

async function runStep(task, stepId, label, action) {
  ensureNotCancelled(task);
  markStep(task, stepId, 'running', label);
  try {
    const result = await action();
    markStep(task, stepId, 'success', result?.detail || tr("{0}完成", { 0: label }));
    return result;
  } catch (error) {
    markStep(task, stepId, 'failed', error.message || tr("{0}失败", { 0: label }));
    throw error;
  }
}

async function prepareAiSummary(task, context) {
  if (!task.includeAiSummary) {
    context.aiSummary = { ok: false, skipped: true, summary: '' };
    markStep(task, 'aiSummary', 'skipped', tr("未勾选 AI 总结"));
    return;
  }

  markStep(task, 'aiSummary', 'running', tr("正在生成 AI 总结"));
  try {
    context.aiSummary = await buildTroubleshootingAiSummary(context, task.aiSummarySignal);
    if (context.aiSummary?.ok) {
      markStep(task, 'aiSummary', 'success', tr("AI 总结已写入报告"));
    } else {
      markStep(task, 'aiSummary', 'skipped', tr("AI 总结未生成：{0}", { 0: context.aiSummary?.error || tr("未知错误") }));
    }
  } catch (error) {
    context.aiSummary = { ok: false, error: error.message || tr("AI 总结异常"), summary: '' };
    markStep(task, 'aiSummary', 'skipped', tr("AI 总结未生成：{0}", { 0: context.aiSummary.error }));
  }
}

async function finishTask(task, context) {
  const endedAt = new Date().toISOString();
  const conclusion = buildConclusion(context);
  const summary = {
    ok: true,
    cancelled: false,
    taskId: task.id,
    status: conclusion.status,
    title: conclusion.title,
    message: conclusion.message,
    suggestions: conclusion.suggestions,
    outputDir: context.outputDir,
    reportPath: path.join(context.outputDir, 'troubleshooting-report.md'),
    summaryPath: path.join(context.outputDir, 'troubleshooting-summary.json'),
    checks: context.checks,
    artifacts: context.artifacts,
    aiSummary: context.aiSummary,
    startedAt: context.startedAt,
    endedAt
  };
  await writeJson(summary.summaryPath, summary);
  await writeText(summary.reportPath, buildReport(context, summary));
  return summary;
}

async function finishCancelled(task, context) {
  const summary = {
    ok: false,
    cancelled: true,
    taskId: task.id,
    status: 'cancelled',
    title: tr("排查已取消"),
    message: tr("已保留取消前采集到的结果。"),
    suggestions: [tr("可打开产物目录查看已生成文件。")],
    outputDir: context.outputDir,
    reportPath: path.join(context.outputDir, 'troubleshooting-report.md'),
    summaryPath: path.join(context.outputDir, 'troubleshooting-summary.json'),
    checks: context.checks,
    artifacts: context.artifacts,
    aiSummary: { ok: false, skipped: true, summary: '', error: tr("任务已取消，未生成 AI 总结") },
    startedAt: context.startedAt,
    endedAt: new Date().toISOString()
  };
  await writeJson(summary.summaryPath, summary);
  await writeText(summary.reportPath, buildReport(context, summary));
  return summary;
}

function buildConclusion(context) {
  const failed = context.checks.filter(item => item.ok === false && !item.skipped);
  const suggestions = [];
  if (failed.some(item => item.key === 'device')) {
    suggestions.push(tr("先确认设备授权弹窗已允许，并尝试重新插拔 USB 或执行 adb kill-server 后重试。"));
  }
  if (failed.some(item => item.key === 'package')) {
    suggestions.push(tr("确认包名是否正确，或先在 App 包管理中搜索应用后复制包名。"));
  }
  if (failed.some(item => item.key === 'logs')) {
    suggestions.push(tr("优先查看命中日志片段，结合 crash/ANR 关键词定位最近一次异常。"));
  }
  if (failed.some(item => item.key === 'performance')) {
    suggestions.push(tr("查看性能快照中的 CPU、内存、温度或存储告警，再按进程占用继续排查。"));
  }
  if (context.inspection?.reportPath) {
    suggestions.push(tr("打开巡检报告，核对系统属性、窗口状态、日志和截图证据。"));
  }
  if (suggestions.length === 0) {
    suggestions.push(tr("本次未发现明确高风险信号，建议复现问题后立即重新执行一键排查。"));
  }
  if (failed.length === 0) {
    return {
      status: 'healthy',
      title: tr("未发现明显高风险信号"),
      message: tr("设备、性能和最近日志未命中明确异常，可在复现后重新采集。"),
      suggestions
    };
  }
  return {
    status: failed.length >= 2 ? 'warning' : 'attention',
    title: tr("发现 {0} 项需要关注的问题", { 0: failed.length }),
    message: failed.map(item => item.label).join('；'),
    suggestions
  };
}

function buildReport(context, summary) {
  const lines = [
    tr("# 一键问题排查报告"),
    '',
    tr("- 设备：{0}", { 0: context.deviceLabel || context.deviceId }),
    tr("- 设备 ID：{0}", { 0: context.deviceId }),
    tr("- 问题类型：{0}", { 0: context.issueLabel }),
    tr("- 应用包名：{0}", { 0: context.packageName || tr("未填写") }),
    tr("- 应用版本：{0}", { 0: context.appVersion }),
    tr("- 开始时间：{0}", { 0: context.startedAt }),
    tr("- 结束时间：{0}", { 0: summary.endedAt }),
    '',
    tr("## 结论"),
    '',
    `${summary.title}。${summary.message}`,
    '',
    tr("## 建议"),
    '',
    ...summary.suggestions.map(item => `- ${item}`),
    '',
    tr("## 检查项"),
    ''
  ];

  for (const check of summary.checks) {
    const state = check.skipped ? tr("跳过") : check.ok ? tr("通过") : tr("关注");
    lines.push(`- ${state}：${check.label}${check.detail ? ` - ${check.detail}` : ''}`);
  }

  lines.push('', tr("## 设备信息"), '');
  if (context.device) {
    lines.push(tr("- 型号：{0}", { 0: context.device.model || '-' }));
    lines.push(`- Android：${context.device.android || '-'}`);
    lines.push(tr("- 构建：{0}", { 0: context.device.build || '-' }));
  } else {
    lines.push(tr("- 未采集到设备属性。"));
  }

  if (context.packageDetail) {
    lines.push('', tr("## 应用信息"), '');
    lines.push(tr("- 包名：{0}", { 0: context.packageDetail.packageName || context.packageName }));
    lines.push(tr("- 版本名：{0}", { 0: context.packageDetail.versionName || '-' }));
    lines.push(tr("- 版本号：{0}", { 0: context.packageDetail.versionCode || '-' }));
    lines.push(tr("- APK 路径：{0}", { 0: context.packageDetail.apkPath || context.packageDetail.path || '-' }));
  }

  if (context.performance) {
    lines.push('', tr("## 性能快照"), '');
    lines.push(`- ${summarizePerformance(context.performance)}`);
    const warnings = Array.isArray(context.performance.warnings) ? context.performance.warnings : [];
    for (const item of warnings) {
      lines.push(tr("- 告警：{0} {1}{2}", { 0: item.label || item.type || tr("性能指标"), 1: item.value ?? '', 2: item.limit ? ` > ${item.limit}` : '' }));
    }
  }

  if (context.logSummary) {
    lines.push('', tr("## 日志命中"), '');
    lines.push(tr("- 命中数量：{0}", { 0: context.logSummary.matchedCount }));
    for (const line of context.logSummary.matchedLines.slice(0, 20)) {
      lines.push(`- ${line}`);
    }
  }

  if (context.inspection?.reportPath) {
    lines.push('', tr("## 巡检产物"), '');
    lines.push(tr("- 巡检报告：{0}", { 0: context.inspection.reportPath }));
    if (context.inspection.zipPath) lines.push(tr("- 证据包：{0}", { 0: context.inspection.zipPath }));
  }

  lines.push('', tr("## 产物清单"), '');
  if (summary.artifacts.length === 0) {
    lines.push(tr("- 无额外产物。"));
  } else {
    for (const artifact of summary.artifacts) {
      lines.push(`- ${artifact.label}：${artifact.path}`);
    }
  }

  lines.push('', tr("## AI 总结"), '', ...formatAiSummaryLines(summary.aiSummary), '');

  return `${lines.join('\n')}\n`;
}

function formatAiSummaryLines(aiSummary) {
  if (!aiSummary) return [tr("- 未勾选 AI 总结")];
  if (aiSummary.skipped) return [`- ${aiSummary.error || tr("未勾选 AI 总结")}`];
  if (!aiSummary.ok) return [tr("- AI 总结未生成：{0}", { 0: aiSummary.error || tr("未知错误") })];
  const lines = String(aiSummary.summary || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trimEnd());
  return lines.some(Boolean) ? lines : [tr("- AI 总结为空")];
}

function buildTroubleshootingAiSummary(context, signal) {
  const checks = (context.checks || []).map(item => ({
    label: item.label,
    ok: item.ok,
    skipped: item.skipped,
    detail: item.detail
  }));
  const payload = {
    issueType: context.issueLabel,
    device: context.device || null,
    packageName: context.packageName || '',
    packageDetail: context.packageDetail ? {
      packageName: context.packageDetail.packageName,
      versionName: context.packageDetail.versionName,
      versionCode: context.packageDetail.versionCode,
      apkPath: context.packageDetail.apkPath || context.packageDetail.path
    } : null,
    checks,
    performance: context.performance ? {
      summary: summarizePerformance(context.performance),
      warnings: Array.isArray(context.performance.warnings) ? context.performance.warnings.slice(0, 20) : []
    } : null,
    logSummary: context.logSummary ? {
      matchedCount: context.logSummary.matchedCount,
      topPatterns: context.logSummary.topPatterns,
      matchedLines: context.logSummary.matchedLines.slice(0, 30)
    } : null,
    inspectionReport: context.inspection?.reportPath || '',
    artifacts: (context.artifacts || []).map(item => ({ label: item.label, path: item.path }))
  };
  return aiAnalyze.generateAiSummary({
    signal,
    timeoutMs: 60000,
    temperature: 0.2,
    systemPrompt: tr("你是 Android 问题排查助手。只能根据提供的结构化证据输出中文总结，不要编造未提供的数据。"),
    userContent: [
      tr("请为以下一键问题排查报告生成可直接追加到 Markdown 报告末尾的 AI 总结。"),
      tr("输出要求："),
      tr("1. 使用简体中文。"),
      tr("2. 包含：总体判断、关键证据、优先排查建议。"),
      tr("3. 不要输出 Markdown 一级/二级标题，报告中已有“AI 总结”标题。"),
      tr("4. 不要编造未提供的数据。"),
      '',
      JSON.stringify(payload, null, 2)
    ].join('\n')
  });
}

function analyzeLogs(text, issueType, packageName) {
  const issue = ISSUE_TYPES[issueType] || ISSUE_TYPES.generic;
  const lines = String(text || '').split(/\r?\n/).filter(Boolean);
  const patterns = issue.patterns.concat(ISSUE_TYPES.generic.patterns);
  const matched = [];
  const names = new Set();
  for (const line of lines) {
    const packageMatched = packageName ? line.includes(packageName) : true;
    const matchedPattern = patterns.find(pattern => pattern.test(line));
    if (matchedPattern && packageMatched) {
      matched.push(line.slice(0, 500));
      names.add(patternLabel(matchedPattern));
    }
    if (matched.length >= 80) break;
  }
  return {
    matchedCount: matched.length,
    matchedLines: matched,
    topPatterns: Array.from(names).slice(0, 8)
  };
}

function patternLabel(pattern) {
  return String(pattern).replace(/^\/|\/i?$/g, '').replace(/\\/g, '');
}

function summarizePerformance(snapshot) {
  const cpu = formatMetric(snapshot?.cpu?.usage, '%');
  const memory = formatMetric(snapshot?.memory?.usage, '%');
  const dataDisk = Array.isArray(snapshot?.disk) ? snapshot.disk.find(item => item.mount === '/data') || snapshot.disk[0] : null;
  const disk = formatMetric(dataDisk?.usage, '%');
  const temp = formatMetric(snapshot?.battery?.temperature ?? snapshot?.thermal?.hottest, '°C');
  return tr("CPU {0}，内存 {1}，存储 {2}，温度 {3}", { 0: cpu, 1: memory, 2: disk, 3: temp });
}

function formatMetric(value, unit) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)}${unit}` : '-';
}

function parseDeviceProps(text) {
  const lines = String(text || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  return {
    model: lines[0] || '',
    android: lines[1] || '',
    build: lines[2] || ''
  };
}

function createStepState(options = {}) {
  return [
    { id: 'device', label: tr("设备连接"), status: 'pending', detail: '' },
    { id: 'package', label: tr("应用信息"), status: 'pending', detail: '' },
    { id: 'performance', label: tr("性能快照"), status: 'pending', detail: '' },
    { id: 'logs', label: tr("关键日志"), status: 'pending', detail: '' },
    { id: 'inspection', label: tr("巡检证据"), status: 'pending', detail: '' },
    { id: 'aiSummary', label: tr("AI 总结"), status: 'pending', detail: '' }
  ].filter(step => {
    if (step.id === 'inspection') return options.includeInspection !== false;
    if (step.id === 'aiSummary') return options.includeAiSummary === true;
    return true;
  });
}

function markStep(task, stepId, status, detail) {
  task.steps = task.steps.map(step => (
    step.id === stepId ? { ...step, status, detail: detail || step.detail } : step
  ));
  task.status = task.cancelled ? 'cancelling' : 'running';
  lastTask = publicTask(task);
  sendProgress(task, stepId, status, detail);
}

function sendProgress(task, stepId, status, detail) {
  sendToSender(task, 'troubleshooting:progress', {
    taskId: task.id,
    deviceId: task.deviceId,
    status: task.status,
    includeInspection: task.includeInspection,
    includeAiSummary: task.includeAiSummary,
    stepId,
    stepStatus: status,
    detail: detail || '',
    steps: task.steps
  });
}

function sendDone(task, result) {
  sendToSender(task, 'troubleshooting:done', {
    taskId: task.id,
    deviceId: task.deviceId,
    status: task.status,
    includeInspection: task.includeInspection,
    includeAiSummary: task.includeAiSummary,
    steps: task.steps,
    result
  });
}

function sendToSender(task, channel, payload) {
  if (task.sender && !task.sender.isDestroyed()) {
    task.sender.send(channel, payload);
  }
}

function publicTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    taskId: task.id,
    deviceId: task.deviceId,
    deviceLabel: task.deviceLabel,
    issueType: task.issueType,
    packageName: task.packageName,
    includeInspection: task.includeInspection,
    includeAiSummary: task.includeAiSummary,
    status: task.status,
    startedAt: task.startedAt,
    steps: task.steps,
    result: task.result
  };
}

function createSilentInspectionTask(parentTask) {
  return {
    id: `${parentTask.id}-inspection`,
    deviceId: parentTask.deviceId,
    sender: null,
    silent: true,
    tracked: false,
    get signal() { return parentTask.aiSummarySignal || parentTask.signal; },
    get cancelled() { return parentTask.cancelled; },
    set cancelled(value) { parentTask.cancelled = value; },
    get currentProc() { return parentTask.currentProc; },
    set currentProc(value) { parentTask.currentProc = value; }
  };
}

async function createOutputDir(task) {
  const baseDir = path.join(app.getPath('userData'), 'troubleshooting');
  await fs.promises.mkdir(baseDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${stamp}-${sanitizeName(task.deviceLabel || task.deviceId)}-${sanitizeName(task.issueType)}`;
  const dir = path.join(baseDir, name);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

function runAdb(task, args, timeoutMs) {
  ensureNotCancelled(task);
  let currentProc = null;
  return runRuntimeAdb(args, {
    timeoutMs: timeoutMs || COMMAND_TIMEOUT_MS,
    isCancelled: () => task.cancelled,
    onProcess: (proc) => {
      currentProc = proc;
      task.currentProc = proc;
    }
  }).then((res) => {
    if (task.currentProc === currentProc) task.currentProc = null;
    if (!res.ok) {
      return {
        ok: false,
        error: task.cancelled
          ? tr("用户取消")
          : res.timedOut
            ? tr("命令超时（{0} 秒）", { 0: Math.round((timeoutMs || COMMAND_TIMEOUT_MS) / 1000) })
            : (res.error || 'ADB command failed'),
        stdout: res.stdout || '',
        stderr: res.stderr || ''
      };
    }
    return { ok: true, stdout: res.stdout || '', stderr: res.stderr || '' };
  });
}

function ensureNotCancelled(task) {
  if (task.cancelled) throw new Error(tr("用户取消"));
}

async function writeText(filePath, content) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, String(content || '').replace(/\r\n/g, '\n'), 'utf8');
}

async function writeJson(filePath, value) {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeDeviceId(value) {
  return String(value || '').trim();
}

function normalizePackageName(value) {
  const text = String(value || '').trim();
  return /^[A-Za-z0-9_.]+$/.test(text) ? text : '';
}

function sanitizeName(value) {
  return String(value || 'item').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 80) || 'item';
}

module.exports = { register };
