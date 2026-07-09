// 设备巡检报告与证据包导出：独立主进程模块，避免扩大现有 ADB/日志模块职责

const { app, shell } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const ctx = require('./app-context.cjs');
const vip = require('./vip.cjs');
const aiAnalyze = require('./ai-analyze.cjs');
const { getAppVersion } = require('./version.cjs');
const { runAdb: runRuntimeAdb } = require('./adb-runtime.cjs');

const STANDARD_TIMEOUT_MS = 15000;
const LONG_TIMEOUT_MS = 45000;
const LOG_TIMEOUT_MS = 30000;
const BUGREPORT_TIMEOUT_MS = 5 * 60 * 1000;
const DEVICE_TEMP_SCREEN = '/sdcard/inspection-screen.png';

let currentTask = null;
let lastTaskState = null;

const STANDARD_STEPS = [
  { id: 'adb-devices', label: '检查 ADB 设备列表', kind: 'adb', args: ['devices', '-l'], file: 'adb-devices.txt', timeout: STANDARD_TIMEOUT_MS },
  { id: 'getprop', label: '采集系统属性', kind: 'shell', command: 'getprop', file: 'getprop.txt', timeout: STANDARD_TIMEOUT_MS },
  { id: 'identity', label: '检查 Root 身份', kind: 'shell', command: 'id', file: 'id.txt', timeout: STANDARD_TIMEOUT_MS },
  { id: 'display', label: '采集屏幕参数', kind: 'shell', command: 'wm size; wm density', file: 'display.txt', timeout: STANDARD_TIMEOUT_MS },
  { id: 'uptime', label: '采集运行时间', kind: 'shell', command: 'uptime', file: 'uptime.txt', timeout: STANDARD_TIMEOUT_MS },
  { id: 'disk', label: '采集磁盘空间', kind: 'shell', command: 'df -h', file: 'df.txt', timeout: STANDARD_TIMEOUT_MS },
  { id: 'meminfo', label: '采集内存信息', kind: 'shell', command: 'cat /proc/meminfo', file: 'meminfo.txt', timeout: STANDARD_TIMEOUT_MS },
  { id: 'top', label: '采集进程快照', kind: 'shell', command: 'top -b -n 1', file: 'top.txt', timeout: LONG_TIMEOUT_MS },
  { id: 'battery', label: '采集电池信息', kind: 'shell', command: 'dumpsys battery', file: 'battery.txt', timeout: STANDARD_TIMEOUT_MS },
  { id: 'thermal', label: '采集温度信息', kind: 'shell', command: 'dumpsys thermalservice', file: 'thermalservice.txt', timeout: STANDARD_TIMEOUT_MS },
  { id: 'activity', label: '采集 Activity 状态', kind: 'shell', command: 'dumpsys activity activities', file: 'activity.txt', timeout: LONG_TIMEOUT_MS },
  { id: 'window', label: '采集窗口状态', kind: 'shell', command: 'dumpsys window', file: 'window.txt', timeout: LONG_TIMEOUT_MS },
  { id: 'package-list', label: '采集应用列表', kind: 'shell', command: 'cmd package list packages -f', file: 'package-list.txt', timeout: LONG_TIMEOUT_MS },
  { id: 'package-dumpsys', label: '采集包管理快照', kind: 'shell', command: 'dumpsys package', file: 'package-dumpsys.txt', timeout: LONG_TIMEOUT_MS },
  { id: 'logcat-main', label: '导出 main 日志', kind: 'logcat', args: ['logcat', '-d', '-v', 'threadtime'], file: 'logcat-main.txt', timeout: LOG_TIMEOUT_MS },
  { id: 'logcat-crash', label: '导出 crash 日志', kind: 'logcat', args: ['logcat', '-b', 'crash', '-d', '-v', 'threadtime'], file: 'logcat-crash.txt', timeout: LOG_TIMEOUT_MS },
  { id: 'logcat-events', label: '导出 events 日志', kind: 'logcat', args: ['logcat', '-b', 'events', '-d', '-v', 'threadtime'], file: 'logcat-events.txt', timeout: LOG_TIMEOUT_MS },
  { id: 'screenshot', label: '采集屏幕截图', kind: 'screenshot', file: 'screen.png', timeout: LOG_TIMEOUT_MS }
];

function register(ipcMain) {
  ipcMain.handle('inspection:start', async (event, args) => {
    if (currentTask) {
      return { ok: false, error: '已有巡检任务正在执行，请先等待或取消当前任务' };
    }
    const status = await vip.getStatusAsync();
    if (!status.activated) {
      return { ok: false, code: 'vip_required', error: '设备巡检为会员专属功能，请先开通会员' };
    }
    const deviceId = String(args?.deviceId || '').trim();
    if (!deviceId) return { ok: false, error: '设备 ID 不能为空' };

    const task = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      deviceId,
      sender: event.sender,
      cancelled: false,
      currentProc: null,
      tracked: true,
      status: 'running',
      startedAt: new Date().toISOString(),
      progress: null,
      result: null
    };
    currentTask = task;
    lastTaskState = publicInspectionTask(task);

    runInspection(task, {
        deviceId,
        deviceLabel: args?.deviceLabel || deviceId,
        includeBugreport: !!args?.includeBugreport,
        includeAiSummary: args?.includeAiSummary === true,
        outputBaseDir: args?.outputBaseDir
      })
      .catch((error) => {
        const payload = { ok: false, error: error.message || '巡检异常', deviceId, outputDir: null, reportPath: null, zipPath: null };
        task.status = 'failed';
        task.result = payload;
        lastTaskState = publicInspectionTask(task);
        sendDone(task, payload);
      })
      .finally(() => {
        if (currentTask === task) currentTask = null;
      });

    return { ok: true, task: publicInspectionTask(task) };
  });

  ipcMain.handle('inspection:cancel', async () => {
    if (!currentTask) return { ok: true, cancelled: false };
    currentTask.cancelled = true;
    currentTask.status = 'cancelling';
    lastTaskState = publicInspectionTask(currentTask);
    if (currentTask.currentProc) {
      try { currentTask.currentProc.kill(); } catch {}
    }
    return { ok: true, cancelled: true };
  });

  ipcMain.handle('inspection:state', async (event, args) => {
    const deviceId = String(args?.deviceId || '').trim();
    const task = currentTask ? publicInspectionTask(currentTask) : lastTaskState;
    if (deviceId && task?.deviceId && task.deviceId !== deviceId) {
      return { ok: true, task: null };
    }
    return { ok: true, task: task || null };
  });

  ipcMain.handle('inspection:openFolder', async (event, folderPath) => {
    if (!folderPath || typeof folderPath !== 'string') {
      return { ok: false, error: '目录路径不能为空' };
    }
    const error = await shell.openPath(folderPath);
    return error ? { ok: false, error } : { ok: true };
  });
}

async function runInspection(task, options) {
  const outputDir = await createOutputDir(options.deviceId, options.outputBaseDir);
  const dirs = {
    root: outputDir,
    raw: path.join(outputDir, 'raw'),
    media: path.join(outputDir, 'media'),
    bugreport: path.join(outputDir, 'bugreport')
  };
  await fs.promises.mkdir(dirs.raw, { recursive: true });
  await fs.promises.mkdir(dirs.media, { recursive: true });

  const startedAt = new Date();
  const steps = [
    ...STANDARD_STEPS,
    ...(options.includeBugreport ? [{ id: 'bugreport', label: '生成 bugreport', kind: 'bugreport', file: 'bugreport.zip', timeout: BUGREPORT_TIMEOUT_MS }] : [])
  ];
  const results = [];
  const errors = [];

  const state = {
    taskId: task.id,
    deviceId: options.deviceId,
    outputDir,
    outputBaseDir: getOutputBaseDir(options.outputBaseDir),
    startedAt: startedAt.toISOString(),
    appVersion: getAppVersion(),
    includeBugreport: options.includeBugreport,
    includeAiSummary: options.includeAiSummary === true
  };

  const statePath = path.join(outputDir, 'metadata.json');
  await writeJson(statePath, state);

  const deviceState = await runAdb(task, ['-s', options.deviceId, 'get-state'], STANDARD_TIMEOUT_MS);
  if (!deviceState.ok || !String(deviceState.stdout).trim().includes('device')) {
    return finishEarly(task, outputDir, state, errors, `设备 ${options.deviceId} 不在线或不可用`);
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (task.cancelled) break;
    sendProgress(task, step, i + 1, steps.length, 'running');
    try {
      const result = await executeStep(task, options.deviceId, step, dirs);
      results.push(result);
      if (!result.ok) errors.push(toErrorRecord(step, result));
      sendProgress(task, step, i + 1, steps.length, result.ok ? 'success' : 'failed', result);
    } catch (e) {
      const result = { id: step.id, label: step.label, ok: false, error: e.message };
      results.push(result);
      errors.push(toErrorRecord(step, result));
      sendProgress(task, step, i + 1, steps.length, 'failed', result);
    }
  }

  const cancelled = task.cancelled;
  if (cancelled) {
    errors.push({ id: 'cancelled', label: '用户取消', error: '巡检已取消，后续步骤未执行' });
  }

  const endedAt = new Date();
  const reportPath = path.join(outputDir, 'inspection-report.md');
  const errorsPath = path.join(outputDir, 'errors.json');
  const summaryPath = path.join(outputDir, 'summary.json');
  const analysis = buildAnalysis(results, errors);
  const aiSummary = options.includeAiSummary ? await buildInspectionAiSummary(state, results, errors, analysis) : { ok: false, skipped: true, summary: '' };
  const finalState = {
    ...state,
    endedAt: endedAt.toISOString(),
    cancelled,
    successCount: results.filter(r => r.ok).length,
    failedCount: errors.length,
    analysis,
    aiSummary,
    steps: results.map(r => ({ id: r.id, label: r.label, ok: r.ok, file: r.file || null, error: r.error || null }))
  };

  await writeJson(statePath, finalState);
  await writeJson(errorsPath, errors);
  await writeJson(summaryPath, buildSummary(finalState, results, errors));
  await fs.promises.writeFile(reportPath, buildReport(finalState, results, errors, dirs), 'utf8');

  let zipPath = null;
  let zipError = null;
  try {
    zipPath = path.join(outputDir, 'evidence-package.zip');
    await createZip(outputDir, zipPath);
  } catch (e) {
    zipError = e.message;
    errors.push({ id: 'zip', label: '证据包打包', error: zipError });
    await writeJson(errorsPath, errors);
    await writeJson(summaryPath, buildSummary({ ...finalState, failedCount: errors.length }, results, errors));
    await fs.promises.writeFile(reportPath, buildReport({ ...finalState, failedCount: errors.length }, results, errors, dirs), 'utf8');
  }

  const payload = {
    ok: true,
    cancelled,
    outputDir,
    reportPath,
    zipPath,
    zipError,
    successCount: finalState.successCount,
    failedCount: errors.length,
    analysis,
    aiSummary
  };
  sendDone(task, payload);
  return payload;
}

async function finishEarly(task, outputDir, state, errors, error) {
  errors.push({ id: 'preflight', label: '巡检预检查', error });
  const analysis = buildAnalysis([], errors);
  const aiSummary = state.includeAiSummary ? await buildInspectionAiSummary(state, [], errors, analysis) : { ok: false, skipped: true, summary: '' };
  const finalState = { ...state, endedAt: new Date().toISOString(), cancelled: false, successCount: 0, failedCount: errors.length, analysis, aiSummary, steps: [] };
  const reportPath = path.join(outputDir, 'inspection-report.md');
  const errorsPath = path.join(outputDir, 'errors.json');
  await writeJson(path.join(outputDir, 'metadata.json'), finalState);
  await writeJson(errorsPath, errors);
  await writeJson(path.join(outputDir, 'summary.json'), buildSummary(finalState, [], errors));
  await fs.promises.writeFile(reportPath, buildReport(finalState, [], errors, { root: outputDir, raw: path.join(outputDir, 'raw'), media: path.join(outputDir, 'media') }), 'utf8');
  const payload = { ok: false, error, outputDir, reportPath, zipPath: null, successCount: 0, failedCount: errors.length, analysis, aiSummary };
  sendDone(task, payload);
  return payload;
}

async function executeStep(task, deviceId, step, dirs) {
  if (step.kind === 'adb') {
    const res = await runAdb(task, step.args, step.timeout);
    return saveTextResult(step, res, dirs.raw);
  }
  if (step.kind === 'shell') {
    const res = await runAdb(task, ['-s', deviceId, 'shell', step.command], step.timeout);
    return saveTextResult(step, res, dirs.raw);
  }
  if (step.kind === 'logcat') {
    const res = await runAdb(task, ['-s', deviceId, ...step.args], step.timeout);
    return saveTextResult(step, res, dirs.raw);
  }
  if (step.kind === 'screenshot') {
    return captureScreenshot(task, deviceId, step, dirs.media);
  }
  if (step.kind === 'bugreport') {
    return captureBugreport(task, deviceId, step, dirs.bugreport);
  }
  return { id: step.id, label: step.label, ok: false, error: '未知巡检步骤类型' };
}

async function saveTextResult(step, res, rawDir) {
  const filePath = path.join(rawDir, step.file);
  const content = [res.stdout || '', res.stderr ? `\n\n[stderr]\n${res.stderr}` : ''].join('');
  await fs.promises.writeFile(filePath, content || '', 'utf8');
  return {
    id: step.id,
    label: step.label,
    ok: res.ok,
    file: filePath,
    bytes: Buffer.byteLength(content || '', 'utf8'),
    error: res.ok ? null : (res.error || res.stderr || `命令退出码 ${res.code}`)
  };
}

async function captureScreenshot(task, deviceId, step, mediaDir) {
  const localPath = path.join(mediaDir, step.file);
  const cap = await runAdb(task, ['-s', deviceId, 'shell', 'screencap', '-p', DEVICE_TEMP_SCREEN], step.timeout);
  if (!cap.ok) return { id: step.id, label: step.label, ok: false, file: localPath, error: cap.error || cap.stderr };
  const pull = await runAdb(task, ['-s', deviceId, 'pull', DEVICE_TEMP_SCREEN, localPath], step.timeout);
  await runAdb(task, ['-s', deviceId, 'shell', 'rm', '-f', DEVICE_TEMP_SCREEN], STANDARD_TIMEOUT_MS).catch(() => {});
  return {
    id: step.id,
    label: step.label,
    ok: pull.ok && fs.existsSync(localPath),
    file: localPath,
    bytes: fs.existsSync(localPath) ? fs.statSync(localPath).size : 0,
    error: pull.ok ? null : (pull.error || pull.stderr)
  };
}

async function captureBugreport(task, deviceId, step, bugreportDir) {
  await fs.promises.mkdir(bugreportDir, { recursive: true });
  const res = await runAdb(task, ['-s', deviceId, 'bugreport', bugreportDir], step.timeout);
  const files = await fs.promises.readdir(bugreportDir).catch(() => []);
  const zip = files.find(name => name.toLowerCase().endsWith('.zip'));
  return {
    id: step.id,
    label: step.label,
    ok: res.ok && !!zip,
    file: zip ? path.join(bugreportDir, zip) : bugreportDir,
    bytes: zip ? fs.statSync(path.join(bugreportDir, zip)).size : 0,
    error: res.ok ? null : (res.error || res.stderr)
  };
}

async function runAdb(task, args, timeoutMs) {
  if (task.cancelled) return { ok: false, error: '用户取消' };
  let currentProc = null;
  const res = await runRuntimeAdb(args, {
    timeoutMs,
    isCancelled: () => task.cancelled,
    onProcess: (proc) => {
      currentProc = proc;
      task.currentProc = proc;
    }
  });
  if (task.currentProc === currentProc) task.currentProc = null;
  const error = task.cancelled
    ? '用户取消'
    : res.timedOut
      ? `命令超时（${Math.round(timeoutMs / 1000)} 秒）`
      : (res.ok ? null : (res.error || res.stderr || 'ADB command failed'));
  return {
    ok: res.ok && !error,
    code: res.code,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error
  };
}

async function createOutputDir(deviceId, outputBaseDir) {
  const baseDir = getOutputBaseDir(outputBaseDir);
  const stamp = formatStamp(new Date());
  const safeDevice = sanitizeName(deviceId);
  const dir = path.join(baseDir, `inspection-${stamp}-${safeDevice}`);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

function getOutputBaseDir(outputBaseDir) {
  const customDir = typeof outputBaseDir === 'string' ? outputBaseDir.trim() : '';
  return customDir ? path.resolve(customDir) : path.join(app.getPath('userData'), 'inspection');
}

function buildReport(state, results, errors, dirs) {
  const byId = Object.fromEntries(results.map(r => [r.id, r]));
  const raw = (id) => readFileSafe(byId[id]?.file);
  const getprop = raw('getprop');
  const display = raw('display');
  const idText = raw('identity');
  const battery = raw('battery');
  const meminfo = raw('meminfo');
  const activity = raw('activity');
  const windowInfo = raw('window');

  const lines = [
    '# 设备巡检报告',
    '',
    '## 巡检概要',
    '',
    `- 应用版本：${state.appVersion}`,
    `- 设备 ID：${state.deviceId}`,
    `- 开始时间：${state.startedAt}`,
    `- 结束时间：${state.endedAt || ''}`,
    `- 执行结果：${state.cancelled ? '用户取消' : errors.length > 0 ? '完成（存在失败项）' : '完成'}`,
    `- 成功项：${state.successCount}`,
    `- 失败项：${errors.length}`,
    `- 导出目录：${dirs.root}`,
    '',
    '## 健康结论',
    '',
    `- 结论：${state.analysis?.summary || '未生成'}`,
    `- 风险等级：${state.analysis?.severity || 'unknown'}`,
    '',
    ...((state.analysis?.findings || []).length === 0
      ? ['- 未发现明确风险项', '']
      : state.analysis.findings.map(item => `- [${item.severity}] ${item.label}：${item.detail}`).concat('')),
    '## 设备信息',
    '',
    `- 品牌：${prop(getprop, 'ro.product.brand') || '-'}`,
    `- 厂商：${prop(getprop, 'ro.product.manufacturer') || '-'}`,
    `- 型号：${prop(getprop, 'ro.product.model') || '-'}`,
    `- 设备：${prop(getprop, 'ro.product.device') || '-'}`,
    `- 产品名：${prop(getprop, 'ro.product.name') || '-'}`,
    `- Android：${prop(getprop, 'ro.build.version.release') || '-'} (SDK ${prop(getprop, 'ro.build.version.sdk') || '-'})`,
    `- 构建号：${prop(getprop, 'ro.build.display.id') || '-'}`,
    `- 指纹：${prop(getprop, 'ro.build.fingerprint') || '-'}`,
    `- ABI：${prop(getprop, 'ro.product.cpu.abi') || '-'}`,
    `- 序列号：${prop(getprop, 'ro.serialno') || '-'}`,
    `- 分辨率：${firstMatch(display, /Physical size:\s*(.+)/) || '-'}`,
    `- 密度：${firstMatch(display, /Physical density:\s*(.+)/) || '-'}`,
    '',
    '## 系统状态',
    '',
    `- Root 状态：${idText.includes('uid=0') ? 'root' : idText ? '非 root 或 shell 用户' : '-'}`,
    `- 内存总量：${firstMatch(meminfo, /^MemTotal:\s*(.+)$/m) || '-'}`,
    `- 可用内存：${firstMatch(meminfo, /^MemAvailable:\s*(.+)$/m) || '-'}`,
    `- 电量：${firstMatch(battery, /^\s*level:\s*(.+)$/m) || '-'}`,
    `- 电池温度：${formatBatteryTemp(firstMatch(battery, /^\s*temperature:\s*(.+)$/m))}`,
    '',
    '## 当前前台信息',
    '',
    `- Resumed Activity：${firstMatch(activity, /mResumedActivity:\s*(.+)/) || firstMatch(activity, /topResumedActivity=([^\n]+)/) || '-'}`,
    `- Focused Window：${firstMatch(windowInfo, /mCurrentFocus=([^\n]+)/) || firstMatch(windowInfo, /mFocusedApp=([^\n]+)/) || '-'}`,
    '',
    '## 日志与附件',
    '',
    ...results.map(r => `- ${r.ok ? '成功' : '失败'}：${r.label}${r.file ? `（${relative(dirs.root, r.file)}，${formatBytes(r.bytes || fileSize(r.file))}）` : ''}${r.error ? `：${r.error}` : ''}`),
    '',
    '## 失败项',
    ''
  ];

  if (errors.length === 0) {
    lines.push('- 无');
  } else {
    errors.forEach(e => lines.push(`- ${e.label || e.id}：${e.error || '未知错误'}`));
  }

  lines.push(
    '',
    '## 证据包说明',
    '',
    '- `raw/`：ADB 命令原始输出。',
    '- `media/`：屏幕截图等图片证据。',
    '- `bugreport/`：用户勾选后生成的 bugreport。',
    '- `metadata.json`：巡检元数据。',
    '- `errors.json`：失败项机器可读记录。',
    '',
    '## AI 分析',
    '',
    ...formatAiAnalysisLines(state.aiSummary),
    ''
  );
  return lines.join('\n');
}

function buildSummary(state, results, errors) {
  return {
    appVersion: state.appVersion,
    deviceId: state.deviceId,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    cancelled: state.cancelled,
    successCount: state.successCount,
    failedCount: errors.length,
    analysis: state.analysis,
    aiSummary: state.aiSummary,
    artifacts: results
      .filter(item => item.file)
      .map(item => ({ id: item.id, label: item.label, ok: item.ok, file: item.file, bytes: item.bytes || fileSize(item.file) }))
  };
}

function formatAiAnalysisLines(aiSummary) {
  if (!aiSummary || aiSummary.skipped) return ['- 未勾选 AI 分析'];
  if (!aiSummary.ok) return [`- AI 分析未生成：${aiSummary.error || '未知错误'}`];
  const lines = String(aiSummary.summary || '')
    .split(/\r?\n/)
    .map(line => line.trimEnd());
  return lines.some(Boolean) ? lines : ['- AI 分析为空'];
}

function buildAnalysis(results, errors) {
  const byId = Object.fromEntries(results.map(r => [r.id, r]));
  const raw = (id) => readFileSafe(byId[id]?.file);
  const findings = [];
  const batteryTemp = Number(firstMatch(raw('battery'), /^\s*temperature:\s*(\d+)$/m));
  const memAvailable = firstKb(raw('meminfo'), /^MemAvailable:\s*(\d+)\s+kB$/m);
  const memTotal = firstKb(raw('meminfo'), /^MemTotal:\s*(\d+)\s+kB$/m);
  const logcatCrash = raw('logcat-crash');
  const logcatMain = raw('logcat-main');
  const disk = raw('disk');

  if (Number.isFinite(batteryTemp) && batteryTemp >= 450) {
    findings.push({ severity: 'high', label: '设备温度偏高', detail: `${(batteryTemp / 10).toFixed(1)}°C` });
  }
  if (memTotal > 0 && memAvailable > 0) {
    const availableRatio = memAvailable / memTotal;
    if (availableRatio < 0.15) {
      findings.push({ severity: 'medium', label: '可用内存偏低', detail: `可用 ${formatKbValue(memAvailable)} / 总计 ${formatKbValue(memTotal)}` });
    }
  }
  if (/FATAL EXCEPTION|ANR in |native crash|Fatal signal/i.test(logcatCrash + '\n' + logcatMain)) {
    findings.push({ severity: 'high', label: '日志中存在崩溃或 ANR 线索', detail: '请查看 raw/logcat-crash.txt 与 raw/logcat-main.txt' });
  }
  if (/(?:\s|^)(9[0-9]|100)%\s+\/data\b/m.test(disk)) {
    findings.push({ severity: 'medium', label: '/data 分区使用率偏高', detail: '请查看 raw/df.txt' });
  }
  errors
    .filter(item => item.id !== 'cancelled')
    .slice(0, 5)
    .forEach(item => findings.push({ severity: 'low', label: `${item.label || item.id} 未完成`, detail: item.error || '未知错误' }));

  const severity = findings.some(item => item.severity === 'high')
    ? 'high'
    : findings.some(item => item.severity === 'medium')
      ? 'medium'
      : findings.length > 0 ? 'low' : 'normal';
  const summary = severity === 'normal'
    ? '标准巡检未发现明确风险项'
    : `发现 ${findings.length} 个需要关注的风险项`;
  return { severity, summary, findings };
}

async function buildInspectionAiSummary(state, results, errors, analysis) {
  const artifacts = results
    .filter(item => item.file)
    .slice(0, 20)
    .map(item => `- ${item.label}: ${item.ok ? '成功' : '失败'} ${item.file || ''} ${item.error || ''}`)
    .join('\n');
  const findings = (analysis.findings || [])
    .map(item => `- [${item.severity}] ${item.label}: ${item.detail}`)
    .join('\n') || '- 无';
  const failures = errors
    .slice(0, 12)
    .map(item => `- ${item.label || item.id}: ${item.error || '未知错误'}`)
    .join('\n') || '- 无';
  const prompt = [
    `设备 ID: ${state.deviceId}`,
    `应用版本: ${state.appVersion}`,
    `巡检结果: ${analysis.summary}`,
    `风险等级: ${analysis.severity}`,
    '',
    '风险项:',
    findings,
    '',
    '失败项:',
    failures,
    '',
    '附件摘要:',
    artifacts || '- 无',
    '',
    '请输出一段面向 Android 调试人员的巡检 AI 总结，包含：总体结论、优先关注项、下一步建议。不要编造未提供的证据。'
  ].join('\n');
  return aiAnalyze.generateAiSummary({
    systemPrompt: '你是 Android 设备巡检报告助手，只根据给定巡检摘要输出简洁、可执行的中文结论。',
    userContent: prompt,
    timeoutMs: 60000,
    temperature: 0.2
  });
}

async function createZip(rootDir, zipPath) {
  const script = [
    `$root = '${escapePs(rootDir)}'`,
    `$dest = '${escapePs(zipPath)}'`,
    `if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force }`,
    `$items = Get-ChildItem -LiteralPath $root -Force | Where-Object { $_.Name -ne 'evidence-package.zip' }`,
    `if (-not $items) { throw '没有可打包的证据文件' }`,
    `$items | Compress-Archive -DestinationPath $dest -Force`
  ].join('; ');
  await new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: LONG_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || stdout || err.message));
      else resolve();
    });
  });
}

function sendProgress(task, step, index, total, status, result) {
  const payload = {
    taskId: task.id,
    deviceId: task.deviceId,
    stepId: step.id,
    stepLabel: step.label,
    index,
    total,
    status,
    result: result ? { ok: result.ok, error: result.error || null } : null
  };
  if (task.tracked) {
    task.status = 'running';
    task.progress = payload;
    lastTaskState = publicInspectionTask(task);
  }
  if (task.silent) return;
  sendToSender(task, 'inspection:progress', payload);
}

function sendDone(task, payload) {
  if (task.tracked) {
    task.status = payload.cancelled ? 'cancelled' : payload.ok ? 'success' : 'failed';
    task.result = payload;
    lastTaskState = publicInspectionTask(task);
  }
  if (task.silent) return;
  sendToSender(task, 'inspection:done', { taskId: task.id, deviceId: task.deviceId, ...payload });
}

function sendToSender(task, channel, payload) {
  if (task.sender && !task.sender.isDestroyed()) {
    task.sender.send(channel, payload);
    return;
  }
  ctx.broadcastToAllWindows(channel, payload);
}

function publicInspectionTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    taskId: task.id,
    deviceId: task.deviceId,
    status: task.status || (task.cancelled ? 'cancelled' : 'running'),
    startedAt: task.startedAt || null,
    progress: task.progress || null,
    result: task.result || null
  };
}

function toErrorRecord(step, result) {
  return { id: step.id, label: step.label, error: result.error || '未知错误', file: result.file || null };
}

function prop(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return firstMatch(text, new RegExp(`\\[${escaped}\\]:\\s*\\[(.*?)\\]`));
}

function firstMatch(text, regex) {
  if (!text) return '';
  const match = String(text).match(regex);
  return match ? String(match[1] || '').trim() : '';
}

function formatBatteryTemp(value) {
  if (!value) return '-';
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return `${(n / 10).toFixed(1)}°C`;
}

function readFileSafe(filePath) {
  try {
    return filePath ? fs.readFileSync(filePath, 'utf8') : '';
  } catch {
    return '';
  }
}

function fileSize(filePath) {
  try {
    return filePath ? fs.statSync(filePath).size : 0;
  } catch {
    return 0;
  }
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function firstKb(text, regex) {
  const value = Number(firstMatch(text, regex));
  return Number.isFinite(value) ? value : 0;
}

function formatKbValue(kb) {
  const n = Number(kb) || 0;
  if (n < 1024) return `${n} KB`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024).toFixed(1)} GB`;
}

function formatStamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function sanitizeName(value) {
  return String(value || 'device').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

function relative(root, filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function escapePs(value) {
  return String(value).replace(/'/g, "''");
}

async function writeJson(filePath, data) {
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = { register, runInspection };
