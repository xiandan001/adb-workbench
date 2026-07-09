// One-click troubleshooting wizard backend.

const { app, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const packageManager = require('./package-manager.cjs');
const performanceMonitor = require('./performance-monitor.cjs');
const inspection = require('./inspection.cjs');
const vip = require('./vip.cjs');
const aiAnalyze = require('./ai-analyze.cjs');
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
    if (currentTask) return { ok: false, error: '已有问题排查任务正在执行，请先等待或取消当前任务' };

    const deviceId = normalizeDeviceId(args?.deviceId);
    if (!deviceId) return { ok: false, error: '请选择在线设备' };

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
        const result = { ok: false, error: error.message || '问题排查失败' };
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
    currentTask.status = 'cancelling';
    if (currentTask.currentProc) {
      try { currentTask.currentProc.kill(); } catch {}
    }
    lastTask = publicTask(currentTask);
    sendProgress(currentTask, 'cancel', 'running', '正在取消当前排查任务');
    return { ok: true, cancelled: true };
  });

  ipcMain.handle('troubleshooting:state', async () => {
    return { ok: true, task: currentTask ? publicTask(currentTask) : lastTask };
  });

  ipcMain.handle('troubleshooting:openFolder', async (event, folderPath) => {
    if (!folderPath || typeof folderPath !== 'string') return { ok: false, error: '目录路径不能为空' };
    const error = await shell.openPath(folderPath);
    return error ? { ok: false, error } : { ok: true };
  });
}

async function runTroubleshooting(task) {
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
    issueLabel: ISSUE_TYPES[task.issueType].label,
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

  await runStep(task, 'device', '检查设备连接', async () => {
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
      label: online ? '设备在线，可执行 ADB 命令' : '设备不可用',
      detail: online ? task.deviceId : state.error || state.stderr || 'ADB 未返回 device 状态'
    });
    if (!online) throw new Error(state.error || state.stderr || '设备不在线或未授权');
    return { detail: context.device.model || task.deviceId };
  });

  if (task.cancelled) return finishCancelled(task, context);

  if (task.packageName) {
    await runStep(task, 'package', '读取应用包信息', async () => {
      const detail = await packageManager.getPackageDetail(task.deviceId, task.packageName);
      context.packageDetail = detail;
      const detailPath = path.join(rawDir, 'package-detail.json');
      await writeJson(detailPath, detail);
      context.artifacts.push({ type: 'json', label: '应用详情', path: detailPath });
      context.checks.push({
        key: 'package',
        ok: true,
        label: '已找到目标应用',
        detail: `${detail.packageName || task.packageName} ${detail.versionName || ''}`.trim()
      });
      return { detail: detail.versionName || detail.apkPath || task.packageName };
    });
  } else {
    markStep(task, 'package', 'skipped', '未填写包名，已跳过应用定向检查');
    context.checks.push({ key: 'package', ok: true, skipped: true, label: '未填写包名', detail: '本次执行通用排查' });
  }

  if (task.cancelled) return finishCancelled(task, context);

  await runStep(task, 'performance', '采集性能快照', async () => {
    const snapshot = await performanceMonitor.collectSnapshot(task.deviceId, vipStatus.activated === true, {
      timeoutMs: 12000,
      fallbackToLegacy: true
    });
    context.performance = snapshot;
    const snapshotPath = path.join(rawDir, 'performance-snapshot.json');
    await writeJson(snapshotPath, snapshot);
    context.artifacts.push({ type: 'json', label: '性能快照', path: snapshotPath });
    const warnings = Array.isArray(snapshot.warnings) ? snapshot.warnings : [];
    context.checks.push({
      key: 'performance',
      ok: warnings.length === 0,
      label: warnings.length ? `发现 ${warnings.length} 项性能告警` : '性能快照未发现阈值告警',
      detail: summarizePerformance(snapshot)
    });
    return { detail: summarizePerformance(snapshot) };
  });

  if (task.cancelled) return finishCancelled(task, context);

  await runStep(task, 'logs', '抓取并筛选关键日志', async () => {
    const log = await runAdb(task, ['-s', task.deviceId, 'logcat', '-d', '-v', 'threadtime', '-t', '600'], LOG_TIMEOUT_MS);
    const logText = log.stdout || log.stderr || '';
    const logPath = path.join(rawDir, 'logcat-tail.txt');
    await writeText(logPath, logText);
    context.artifacts.push({ type: 'text', label: '最近日志', path: logPath });
    context.logSummary = analyzeLogs(logText, task.issueType, task.packageName);
    const excerptPath = path.join(rawDir, 'matched-log-excerpt.txt');
    await writeText(excerptPath, context.logSummary.matchedLines.join('\n'));
    context.artifacts.push({ type: 'text', label: '命中日志片段', path: excerptPath });
    context.checks.push({
      key: 'logs',
      ok: context.logSummary.matchedCount === 0,
      label: context.logSummary.matchedCount ? `命中 ${context.logSummary.matchedCount} 条可疑日志` : '最近日志未命中高风险关键词',
      detail: context.logSummary.topPatterns.join('、') || '无明显异常关键词'
    });
    return { detail: `${context.logSummary.matchedCount} 条命中` };
  });

  if (task.cancelled) return finishCancelled(task, context);

  if (task.includeInspection && vipStatus.activated === true) {
    await runStep(task, 'inspection', '生成巡检报告和证据包', async () => {
      const inspectionTask = createSilentInspectionTask(task);
      const result = await inspection.runInspection(inspectionTask, {
        deviceId: task.deviceId,
        deviceLabel: task.deviceLabel,
        includeBugreport: false,
        includeAiSummary: false,
        outputBaseDir: path.join(outputDir, 'inspection')
      });
      context.inspection = result;
      if (result.reportPath) context.artifacts.push({ type: 'report', label: '巡检报告', path: result.reportPath });
      if (result.zipPath) context.artifacts.push({ type: 'zip', label: '巡检证据包', path: result.zipPath });
      context.checks.push({
        key: 'inspection',
        ok: result.ok !== false && !result.cancelled,
        label: result.ok === false ? '巡检执行失败' : '巡检报告已生成',
        detail: result.reportPath || result.error || ''
      });
      return { detail: result.reportPath || '巡检完成' };
    });
  } else {
    const detail = vipStatus.activated === true ? '已按用户选择跳过巡检' : '当前为基础版，巡检证据包需会员版';
    markStep(task, 'inspection', 'skipped', detail);
    context.checks.push({ key: 'inspection', ok: true, skipped: true, label: '巡检已跳过', detail });
  }

  await prepareAiSummary(task, context);
  return finishTask(task, context);
}

async function runStep(task, stepId, label, action) {
  ensureNotCancelled(task);
  markStep(task, stepId, 'running', label);
  try {
    const result = await action();
    markStep(task, stepId, 'success', result?.detail || `${label}完成`);
    return result;
  } catch (error) {
    markStep(task, stepId, 'failed', error.message || `${label}失败`);
    throw error;
  }
}

async function prepareAiSummary(task, context) {
  if (!task.includeAiSummary) {
    context.aiSummary = { ok: false, skipped: true, summary: '' };
    markStep(task, 'aiSummary', 'skipped', '未勾选 AI 总结');
    return;
  }

  markStep(task, 'aiSummary', 'running', '正在生成 AI 总结');
  try {
    context.aiSummary = await buildTroubleshootingAiSummary(context);
    if (context.aiSummary?.ok) {
      markStep(task, 'aiSummary', 'success', 'AI 总结已写入报告');
    } else {
      markStep(task, 'aiSummary', 'skipped', `AI 总结未生成：${context.aiSummary?.error || '未知错误'}`);
    }
  } catch (error) {
    context.aiSummary = { ok: false, error: error.message || 'AI 总结异常', summary: '' };
    markStep(task, 'aiSummary', 'skipped', `AI 总结未生成：${context.aiSummary.error}`);
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
    title: '排查已取消',
    message: '已保留取消前采集到的结果。',
    suggestions: ['可打开产物目录查看已生成文件。'],
    outputDir: context.outputDir,
    reportPath: path.join(context.outputDir, 'troubleshooting-report.md'),
    summaryPath: path.join(context.outputDir, 'troubleshooting-summary.json'),
    checks: context.checks,
    artifacts: context.artifacts,
    aiSummary: { ok: false, skipped: true, summary: '', error: '任务已取消，未生成 AI 总结' },
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
    suggestions.push('先确认设备授权弹窗已允许，并尝试重新插拔 USB 或执行 adb kill-server 后重试。');
  }
  if (failed.some(item => item.key === 'package')) {
    suggestions.push('确认包名是否正确，或先在 App 包管理中搜索应用后复制包名。');
  }
  if (failed.some(item => item.key === 'logs')) {
    suggestions.push('优先查看命中日志片段，结合 crash/ANR 关键词定位最近一次异常。');
  }
  if (failed.some(item => item.key === 'performance')) {
    suggestions.push('查看性能快照中的 CPU、内存、温度或存储告警，再按进程占用继续排查。');
  }
  if (context.inspection?.reportPath) {
    suggestions.push('打开巡检报告，核对系统属性、窗口状态、日志和截图证据。');
  }
  if (suggestions.length === 0) {
    suggestions.push('本次未发现明确高风险信号，建议复现问题后立即重新执行一键排查。');
  }
  if (failed.length === 0) {
    return {
      status: 'healthy',
      title: '未发现明显高风险信号',
      message: '设备、性能和最近日志未命中明确异常，可在复现后重新采集。',
      suggestions
    };
  }
  return {
    status: failed.length >= 2 ? 'warning' : 'attention',
    title: `发现 ${failed.length} 项需要关注的问题`,
    message: failed.map(item => item.label).join('；'),
    suggestions
  };
}

function buildReport(context, summary) {
  const lines = [
    '# 一键问题排查报告',
    '',
    `- 设备：${context.deviceLabel || context.deviceId}`,
    `- 设备 ID：${context.deviceId}`,
    `- 问题类型：${context.issueLabel}`,
    `- 应用包名：${context.packageName || '未填写'}`,
    `- 应用版本：${context.appVersion}`,
    `- 开始时间：${context.startedAt}`,
    `- 结束时间：${summary.endedAt}`,
    '',
    '## 结论',
    '',
    `${summary.title}。${summary.message}`,
    '',
    '## 建议',
    '',
    ...summary.suggestions.map(item => `- ${item}`),
    '',
    '## 检查项',
    ''
  ];

  for (const check of summary.checks) {
    const state = check.skipped ? '跳过' : check.ok ? '通过' : '关注';
    lines.push(`- ${state}：${check.label}${check.detail ? ` - ${check.detail}` : ''}`);
  }

  lines.push('', '## 设备信息', '');
  if (context.device) {
    lines.push(`- 型号：${context.device.model || '-'}`);
    lines.push(`- Android：${context.device.android || '-'}`);
    lines.push(`- 构建：${context.device.build || '-'}`);
  } else {
    lines.push('- 未采集到设备属性。');
  }

  if (context.packageDetail) {
    lines.push('', '## 应用信息', '');
    lines.push(`- 包名：${context.packageDetail.packageName || context.packageName}`);
    lines.push(`- 版本名：${context.packageDetail.versionName || '-'}`);
    lines.push(`- 版本号：${context.packageDetail.versionCode || '-'}`);
    lines.push(`- APK 路径：${context.packageDetail.apkPath || context.packageDetail.path || '-'}`);
  }

  if (context.performance) {
    lines.push('', '## 性能快照', '');
    lines.push(`- ${summarizePerformance(context.performance)}`);
    const warnings = Array.isArray(context.performance.warnings) ? context.performance.warnings : [];
    for (const item of warnings) {
      lines.push(`- 告警：${item.label || item.type || '性能指标'} ${item.value ?? ''}${item.limit ? ` > ${item.limit}` : ''}`);
    }
  }

  if (context.logSummary) {
    lines.push('', '## 日志命中', '');
    lines.push(`- 命中数量：${context.logSummary.matchedCount}`);
    for (const line of context.logSummary.matchedLines.slice(0, 20)) {
      lines.push(`- ${line}`);
    }
  }

  if (context.inspection?.reportPath) {
    lines.push('', '## 巡检产物', '');
    lines.push(`- 巡检报告：${context.inspection.reportPath}`);
    if (context.inspection.zipPath) lines.push(`- 证据包：${context.inspection.zipPath}`);
  }

  lines.push('', '## 产物清单', '');
  if (summary.artifacts.length === 0) {
    lines.push('- 无额外产物。');
  } else {
    for (const artifact of summary.artifacts) {
      lines.push(`- ${artifact.label}：${artifact.path}`);
    }
  }

  lines.push('', '## AI 总结', '', ...formatAiSummaryLines(summary.aiSummary), '');

  return `${lines.join('\n')}\n`;
}

function formatAiSummaryLines(aiSummary) {
  if (!aiSummary) return ['- 未勾选 AI 总结'];
  if (aiSummary.skipped) return [`- ${aiSummary.error || '未勾选 AI 总结'}`];
  if (!aiSummary.ok) return [`- AI 总结未生成：${aiSummary.error || '未知错误'}`];
  const lines = String(aiSummary.summary || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trimEnd());
  return lines.some(Boolean) ? lines : ['- AI 总结为空'];
}

function buildTroubleshootingAiSummary(context) {
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
    timeoutMs: 60000,
    temperature: 0.2,
    systemPrompt: '你是 Android 问题排查助手。只能根据提供的结构化证据输出中文总结，不要编造未提供的数据。',
    userContent: [
      '请为以下一键问题排查报告生成可直接追加到 Markdown 报告末尾的 AI 总结。',
      '输出要求：',
      '1. 使用简体中文。',
      '2. 包含：总体判断、关键证据、优先排查建议。',
      '3. 不要输出 Markdown 一级/二级标题，报告中已有“AI 总结”标题。',
      '4. 不要编造未提供的数据。',
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
  return `CPU ${cpu}，内存 ${memory}，存储 ${disk}，温度 ${temp}`;
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
    { id: 'device', label: '设备连接', status: 'pending', detail: '' },
    { id: 'package', label: '应用信息', status: 'pending', detail: '' },
    { id: 'performance', label: '性能快照', status: 'pending', detail: '' },
    { id: 'logs', label: '关键日志', status: 'pending', detail: '' },
    { id: 'inspection', label: '巡检证据', status: 'pending', detail: '' },
    { id: 'aiSummary', label: 'AI 总结', status: 'pending', detail: '' }
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
          ? '用户取消'
          : res.timedOut
            ? `命令超时（${Math.round((timeoutMs || COMMAND_TIMEOUT_MS) / 1000)} 秒）`
            : (res.error || 'ADB command failed'),
        stdout: res.stdout || '',
        stderr: res.stderr || ''
      };
    }
    return { ok: true, stdout: res.stdout || '', stderr: res.stderr || '' };
  });
}

function ensureNotCancelled(task) {
  if (task.cancelled) throw new Error('用户取消');
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
