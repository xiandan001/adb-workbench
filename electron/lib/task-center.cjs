// Task center: replay scripts, multi-device task queue, and execution history.

const { app } = require('electron');
const { Worker } = require('worker_threads');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ctx = require('./app-context.cjs');
const vip = require('./vip.cjs');
const inspection = require('./inspection.cjs');
const performanceMonitor = require('./performance-monitor.cjs');
const aiAnalyze = require('./ai-analyze.cjs');
const { getAdbCommand, runAdb: runRuntimeAdb } = require('./adb-runtime.cjs');

const SCRIPTS_FILE = 'task-center-scripts.json';
const HISTORY_FILE = 'task-center-history.json';
const SETTINGS_FILE = 'settings.json';
const ARTIFACT_DIR = 'task-center-artifacts';
const DEFAULT_TIMEOUT_MS = 30000;
const LONG_TIMEOUT_MS = 120000;
const MAX_HISTORY = 100;
const MAX_OUTPUT_CHARS = 12000;
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
const MAX_STRESS_ROUNDS = 1000;
const MAX_STRESS_STEP_RECORDS = 600;
const MAX_STRESS_FAILURES = 120;
const DEVICE_TEMP_SCREEN = '/sdcard/task-center-screen.png';
const STRESS_REPORT_FILE = 'stress-report.md';
const STRESS_RESULT_FILE = 'stress-result.json';

const activeTasks = new Map();
const bridgeInspectionTasks = new Map();
let scriptsCache = null;
let historyCache = null;
let taskWorker = null;
let taskWorkerFailed = false;
let workerBroadcastTimer = null;

const DEFAULT_SCRIPT = {
  id: 'default-smoke-test',
  name: '基础复现脚本',
  description: '采集设备型号、截图和一次性能快照，用于快速验证设备链路。',
  continueOnError: true,
  steps: [
    { id: 'model', type: 'shell', label: '读取设备型号', command: 'getprop ro.product.model', timeoutMs: 15000 },
    { id: 'screenshot', type: 'screenshot', label: '保存当前截图', timeoutMs: 30000 },
    { id: 'perf', type: 'perfSnapshot', label: '采集性能快照', timeoutMs: 30000 }
  ],
  createdAt: 'builtin',
  updatedAt: 'builtin'
};

function register(ipcMain) {
  ipcMain.handle('task-center:scripts:list', async () => {
    return { ok: true, scripts: readScripts() };
  });

  ipcMain.handle('task-center:scripts:save', async (event, args) => {
    try {
      const script = normalizeScript(args?.script);
      const scripts = readScripts();
      const now = new Date().toISOString();
      const existing = scripts.find(item => item.id === script.id);
      const nextScript = {
        ...script,
        createdAt: existing?.createdAt || now,
        updatedAt: now
      };
      const next = existing
        ? scripts.map(item => item.id === nextScript.id ? nextScript : item)
        : [nextScript, ...scripts];
      writeScripts(next);
      return { ok: true, script: nextScript, scripts: next };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('task-center:scripts:delete', async (event, args) => {
    const id = String(args?.id || '').trim();
    if (!id) return { ok: false, error: 'script_id_required' };
    const next = readScripts().filter(item => item.id !== id);
    writeScripts(next);
    return { ok: true, scripts: next };
  });

  ipcMain.handle('task-center:stress:import', async (event, args) => {
    try {
      const script = importStressScript(args?.filePath, args?.scriptArgs);
      const scripts = readScripts();
      const now = new Date().toISOString();
      const nextScript = {
        ...script,
        id: `stress-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        createdAt: now,
        updatedAt: now
      };
      const next = [nextScript, ...scripts];
      writeScripts(next);
      return { ok: true, script: nextScript, scripts: next };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('task-center:stress:export', async (event, args) => {
    try {
      const filePath = String(args?.filePath || '').trim();
      if (!filePath) return { ok: false, error: 'file_required' };
      const script = normalizeScript({ ...(args?.script || {}), mode: 'stress' });
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, JSON.stringify(toStressExportScript(script), null, 2), 'utf8');
      return { ok: true, filePath };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('task-center:stress:uiSnapshot', async (event, args) => {
    try {
      const deviceId = normalizeDeviceId(args?.deviceId);
      if (!deviceId) return { ok: false, error: 'device_required' };
      const snapshot = await captureUiSnapshot(createRecorderTask(event.sender), deviceId, args?.timeoutMs || DEFAULT_TIMEOUT_MS);
      if (snapshot.error) return { ok: false, error: snapshot.error, nodes: snapshot.nodes || [] };
      return { ok: true, ...snapshot };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('task-center:stress:recordAction', async (event, args) => {
    try {
      const deviceId = normalizeDeviceId(args?.deviceId);
      if (!deviceId) return { ok: false, error: 'device_required' };
      const result = await recordStressAction(createRecorderTask(event.sender), deviceId, args || {});
      return { ok: result.ok, ...result };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('task-center:run', async (event, args) => {
    return runInlineScript(args?.script, args?.deviceIds, event.sender, args || {});
  });

  ipcMain.handle('task-center:cancel', async (event, args) => {
    const taskId = String(args?.taskId || '').trim();
    const task = activeTasks.get(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    task.cancelled = true;
    task.status = 'cancelled';
    cancelBridgeInspectionTasks(taskId);
    postTaskWorker({ action: 'cancel', taskId });
    killCurrentProcess(task);
    broadcastTask(task);
    return { ok: true, task: publicTask(task) };
  });

  ipcMain.handle('task-center:history', async () => {
    return { ok: true, history: readHistory() };
  });

  ipcMain.handle('task-center:history:clear', async () => {
    writeHistory([]);
    broadcastState();
    return { ok: true, history: [] };
  });

  ipcMain.handle('task-center:state', async () => {
    return {
      ok: true,
      activeTasks: Array.from(activeTasks.values()).map(publicTask),
      history: readHistory()
    };
  });
}

async function runInlineScript(script, deviceIds, sender, args = {}) {
  try {
    const devices = normalizeDeviceIds(deviceIds);
    if (devices.length === 0) return { ok: false, error: '请至少选择一台在线设备' };
    const nextScript = args?.scriptId ? readScripts().find(item => item.id === args.scriptId) : normalizeScript(script);
    if (!nextScript) return { ok: false, error: 'script_not_found' };
    const task = createTask(nextScript, devices, sender, args || {});
    activeTasks.set(task.id, task);
    broadcastState();
    const started = startWorkerTask(task);
    if (!started.ok) {
      task.status = 'failed';
      task.error = started.error || '任务 Worker 启动失败';
      task.endedAt = new Date().toISOString();
      await finishWorkerTask(publicTask(task));
    }
    return { ok: true, task: publicTask(task) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function startWorkerTask(task) {
  const worker = ensureTaskWorker();
  if (!worker) return { ok: false, error: 'worker_unavailable' };
  postTaskWorker({
    action: 'run',
    adbPath: getAdbCommand(),
    task: toWorkerTask(task)
  });
  return { ok: true };
}

function ensureTaskWorker() {
  if (taskWorker && !taskWorkerFailed) return taskWorker;
  taskWorkerFailed = false;
  try {
    taskWorker = new Worker(getTaskCenterWorkerPath(), {
      workerData: {
        adbPath: getAdbCommand(),
        defaultArtifactBaseDir: resolveTaskArtifactBaseDir('')
      }
    });
  } catch (error) {
    taskWorker = null;
    taskWorkerFailed = true;
    return null;
  }
  taskWorker.on('message', handleTaskWorkerMessage);
  taskWorker.on('error', handleTaskWorkerFailure);
  taskWorker.on('exit', (code) => {
    const hadActiveTasks = activeTasks.size > 0;
    taskWorker = null;
    if (code !== 0 && hadActiveTasks) {
      handleTaskWorkerFailure(new Error(`任务 Worker 已退出：${code}`));
    }
  });
  return taskWorker;
}

function getTaskCenterWorkerPath() {
  const workerPath = path.join(__dirname, 'task-center-worker.cjs');
  if (!app.isPackaged) return workerPath;
  const unpackedPath = workerPath.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  return fs.existsSync(unpackedPath) ? unpackedPath : workerPath;
}

function postTaskWorker(message) {
  try {
    const worker = message?.action === 'run' ? ensureTaskWorker() : taskWorker;
    worker?.postMessage({ adbPath: getAdbCommand(), ...message });
  } catch (error) {
    handleTaskWorkerFailure(error);
  }
}

function handleTaskWorkerMessage(message) {
  if (message?.type === 'progress' && message.task) {
    applyWorkerTaskUpdate(message.task);
    scheduleWorkerBroadcast();
    return;
  }
  if (message?.type === 'state') {
    scheduleWorkerBroadcast();
    return;
  }
  if (message?.type === 'done' && message.task) {
    finishWorkerTask(message.task).catch(error => {
      console.error('Failed to finish task worker record:', error);
    });
    return;
  }
  if (message?.type === 'bridge:request') {
    handleTaskWorkerBridge(message).catch(error => {
      respondTaskWorkerBridge(message.id, false, null, error.message || 'bridge_failed');
    });
    return;
  }
  if (message?.type === 'workerError') {
    handleTaskWorkerFailure(new Error(message.error || '任务 Worker 异常'));
  }
}

function applyWorkerTaskUpdate(snapshot) {
  const taskId = String(snapshot?.id || '').trim();
  if (!taskId) return null;
  const task = activeTasks.get(taskId);
  if (!task) {
    activeTasks.set(taskId, { publicSnapshot: sanitizePublicTask(snapshot) });
    return activeTasks.get(taskId);
  }
  task.publicSnapshot = sanitizePublicTask(snapshot);
  task.status = snapshot.status || task.status;
  task.error = snapshot.error || task.error;
  task.startedAt = snapshot.startedAt || task.startedAt;
  task.endedAt = snapshot.endedAt || task.endedAt;
  return task;
}

async function finishWorkerTask(snapshot) {
  const taskId = String(snapshot?.id || '').trim();
  if (!taskId) return;
  const task = applyWorkerTaskUpdate(snapshot);
  const record = sanitizePublicTask(task?.publicSnapshot || snapshot);
  activeTasks.delete(taskId);
  cancelBridgeInspectionTasks(taskId);
  const history = [record, ...readHistory().filter(item => item.id !== taskId)].slice(0, MAX_HISTORY);
  writeHistory(history);
  flushWorkerBroadcast();
  ctx.broadcastToAllWindows('task-center:update', {
    task: record,
    activeTasks: Array.from(activeTasks.values()).map(publicTask),
    history: readHistory()
  });
}

function scheduleWorkerBroadcast() {
  if (workerBroadcastTimer) return;
  workerBroadcastTimer = setTimeout(() => {
    workerBroadcastTimer = null;
    broadcastState();
  }, 250);
  workerBroadcastTimer.unref?.();
}

function flushWorkerBroadcast() {
  if (!workerBroadcastTimer) return;
  clearTimeout(workerBroadcastTimer);
  workerBroadcastTimer = null;
}

function handleTaskWorkerFailure(error) {
  taskWorkerFailed = true;
  if (taskWorker) {
    try { taskWorker.terminate(); } catch {}
    taskWorker = null;
  }
  const now = new Date().toISOString();
  const failedRecords = [];
  for (const [taskId, task] of activeTasks.entries()) {
    const record = publicTask(task);
    if (record.status === 'running' || record.status === 'queued') {
      record.status = 'failed';
      record.error = error.message || '任务 Worker 异常';
      record.endedAt = now;
    }
    failedRecords.push(record);
    cancelBridgeInspectionTasks(taskId);
  }
  activeTasks.clear();
  if (failedRecords.length > 0) {
    const existing = readHistory();
    const next = [
      ...failedRecords,
      ...existing.filter(item => !failedRecords.some(record => record.id === item.id))
    ].slice(0, MAX_HISTORY);
    writeHistory(next);
  }
  flushWorkerBroadcast();
  broadcastState();
}

async function handleTaskWorkerBridge(message) {
  const action = String(message.action || '').trim();
  const payload = message.payload || {};
  let result;
  if (action === 'perfSnapshot') {
    result = await bridgePerformanceSnapshot(payload);
  } else if (action === 'inspection') {
    result = await bridgeInspection(payload);
  } else if (action === 'aiSummary') {
    result = await bridgeAiSummary(payload);
  } else {
    result = { ok: false, error: `unsupported_bridge_action:${action}` };
  }
  respondTaskWorkerBridge(message.id, true, result, '');
}

function respondTaskWorkerBridge(id, ok, result, error) {
  if (!id || !taskWorker) return;
  try {
    taskWorker.postMessage({ type: 'bridge:response', id, ok, result, error });
  } catch {}
}

async function bridgePerformanceSnapshot(payload) {
  const deviceId = normalizeDeviceId(payload?.deviceId);
  if (!deviceId) return { ok: false, error: 'device_required' };
  const status = await vip.getStatusAsync();
  try {
    const snapshot = await performanceMonitor.collectSnapshot(deviceId, status.activated === true, { timeoutMs: payload?.timeoutMs || 12000 });
    return { ok: true, snapshot };
  } catch (error) {
    return { ok: false, error: error.message || 'snapshot_failed' };
  }
}

async function bridgeInspection(payload) {
  const taskId = String(payload?.taskId || '').trim();
  const deviceId = normalizeDeviceId(payload?.deviceId);
  if (!taskId || !deviceId) return { ok: false, error: 'task_or_device_required' };
  const status = await vip.getStatusAsync();
  if (!status.activated) {
    return { ok: false, error: '设备巡检为会员专属功能，请先开通会员', code: 'vip_required' };
  }
  const bridgeTask = createBridgeInspectionTask(taskId, deviceId);
  addBridgeInspectionTask(taskId, bridgeTask);
  try {
    const step = payload?.step || {};
    const result = await inspection.runInspection(bridgeTask, {
      deviceId,
      deviceLabel: deviceId,
      includeBugreport: step.includeBugreport === true,
      includeAiSummary: step.includeAiSummary === true,
      outputBaseDir: payload?.outputBaseDir
    });
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: error.message || 'inspection_failed' };
  } finally {
    removeBridgeInspectionTask(taskId, bridgeTask);
  }
}

async function bridgeAiSummary(payload) {
  try {
    const summary = await aiAnalyze.generateAiSummary(payload?.options || {});
    return { ok: true, summary };
  } catch (error) {
    return { ok: false, error: error.message || 'ai_summary_failed' };
  }
}

function createBridgeInspectionTask(parentTaskId, deviceId) {
  return {
    id: `${parentTaskId}-${sanitizeName(deviceId)}`,
    parentTaskId,
    deviceId,
    sender: null,
    cancelled: false,
    currentProc: null
  };
}

function addBridgeInspectionTask(taskId, bridgeTask) {
  const tasks = bridgeInspectionTasks.get(taskId) || new Set();
  tasks.add(bridgeTask);
  bridgeInspectionTasks.set(taskId, tasks);
}

function removeBridgeInspectionTask(taskId, bridgeTask) {
  const tasks = bridgeInspectionTasks.get(taskId);
  if (!tasks) return;
  tasks.delete(bridgeTask);
  if (tasks.size === 0) bridgeInspectionTasks.delete(taskId);
}

function cancelBridgeInspectionTasks(taskId) {
  const tasks = bridgeInspectionTasks.get(taskId);
  if (!tasks) return;
  for (const task of tasks) {
    task.cancelled = true;
    try { task.currentProc?.kill?.(); } catch {}
    task.currentProc = null;
  }
}

function toWorkerTask(task) {
  return JSON.parse(JSON.stringify({
    ...task,
    sender: null,
    currentProc: null,
    publicSnapshot: undefined
  }));
}

function sanitizePublicTask(task) {
  return JSON.parse(JSON.stringify(task || {}));
}

async function runTask(task) {
  task.status = 'running';
  task.startedAt = new Date().toISOString();
  await ensureTaskRootDir(task);
  appendTaskLog(task, task.script.mode === 'stress' ? '自动化压测开始' : '任务开始');
  broadcastTask(task);

  if (task.script.mode === 'stress') {
    await runStressTask(task);
    return;
  }

  const concurrency = Math.max(1, Math.min(Number(task.concurrency) || 1, 4));
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, task.deviceRuns.length) }, async () => {
    while (!task.cancelled) {
      const run = task.deviceRuns[nextIndex];
      nextIndex += 1;
      if (!run) return;
      await runDevice(task, run);
    }
  });

  await Promise.all(workers);

  if (task.cancelled) {
    task.status = 'cancelled';
  } else if (task.deviceRuns.some(run => run.status === 'failed')) {
    task.status = 'failed';
  } else {
    task.status = 'success';
  }
  task.endedAt = new Date().toISOString();
  appendTaskLog(task, task.status === 'success' ? '任务完成' : task.status === 'cancelled' ? '任务已取消' : '任务存在失败项');
  await finishTask(task);
}

async function runDevice(task, run) {
  run.status = 'running';
  run.startedAt = new Date().toISOString();
  broadcastTask(task);

  for (let i = 0; i < task.script.steps.length; i += 1) {
    if (task.cancelled) break;
    const step = task.script.steps[i];
    const stepRun = createStepRun(step, i);
    run.steps.push(stepRun);
    stepRun.status = 'running';
    stepRun.startedAt = new Date().toISOString();
    appendTaskLog(task, `[${run.deviceId}] ${stepRun.label} 开始`);
    broadcastTask(task);

    try {
      const result = await executeStep(task, run.deviceId, step);
      stepRun.status = result.ok ? 'success' : 'failed';
      stepRun.output = trimOutput(result.output || result.stdout || '');
      stepRun.error = result.error || '';
      stepRun.artifact = result.artifact || '';
      stepRun.endedAt = new Date().toISOString();
      if (result.ok) {
        task.completedSteps += 1;
        appendTaskLog(task, `[${run.deviceId}] ${stepRun.label} 完成`);
      } else {
        task.failedSteps += 1;
        appendTaskLog(task, `[${run.deviceId}] ${stepRun.label} 失败：${stepRun.error || '未知错误'}`);
        if (!task.continueOnError && !step.continueOnError) {
          run.status = 'failed';
          break;
        }
      }
    } catch (error) {
      stepRun.status = task.cancelled ? 'cancelled' : 'failed';
      stepRun.error = error.message;
      stepRun.endedAt = new Date().toISOString();
      task.failedSteps += 1;
      appendTaskLog(task, `[${run.deviceId}] ${stepRun.label} 异常：${error.message}`);
      if (!task.continueOnError && !step.continueOnError) {
        run.status = 'failed';
        break;
      }
    } finally {
      broadcastTask(task);
    }
  }

  if (task.cancelled) {
    run.status = 'cancelled';
  } else if (run.status !== 'failed') {
    run.status = run.steps.some(step => step.status === 'failed') ? 'failed' : 'success';
  }
  run.endedAt = new Date().toISOString();
  broadcastTask(task);
}

async function runStressTask(task) {
  const concurrency = Math.max(1, Math.min(Number(task.concurrency) || 1, 2));
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, task.deviceRuns.length) }, async () => {
    while (!task.cancelled) {
      const run = task.deviceRuns[nextIndex];
      nextIndex += 1;
      if (!run) return;
      await runStressDevice(task, run);
    }
  });

  await Promise.all(workers);

  const summary = buildStressSummary(task);
  task.stressSummary = summary;

  if (task.cancelled) {
    task.status = 'cancelled';
  } else if (summary.passed) {
    task.status = 'success';
  } else {
    task.status = 'failed';
    task.error = summary.reason || '压测验收未通过';
  }

  task.endedAt = new Date().toISOString();
  appendTaskLog(task, task.status === 'success' ? '自动化压测通过' : task.status === 'cancelled' ? '自动化压测已取消' : `自动化压测失败：${task.error || '验收未通过'}`);
  await writeStressArtifacts(task, summary);
  await finishTask(task);
}

async function runStressDevice(task, run) {
  run.status = 'running';
  run.startedAt = new Date().toISOString();
  run.stressRounds = [];
  run.completedRounds = 0;
  run.failedRounds = 0;
  broadcastTask(task);

  const loop = task.script.loop || {};
  const maxCount = loop.count > 0 ? loop.count : (loop.durationMs > 0 ? Number.MAX_SAFE_INTEGER : 1);
  const deadline = loop.durationMs > 0 ? Date.now() + loop.durationMs : Number.POSITIVE_INFINITY;
  let roundIndex = 0;

  while (!task.cancelled && roundIndex < maxCount && Date.now() < deadline) {
    roundIndex += 1;
    const round = {
      index: roundIndex,
      status: 'running',
      startedAt: new Date().toISOString(),
      endedAt: '',
      steps: [],
      warnings: []
    };
    appendStressRound(run, round);
    appendTaskLog(task, `[${run.deviceId}] 第 ${roundIndex} 轮开始`);
    broadcastTask(task);

    let stopRound = false;
    for (let i = 0; i < task.script.steps.length; i += 1) {
      if (task.cancelled || stopRound) break;
      const step = task.script.steps[i];
      const stepRun = createStepRun(step, i);
      stepRun.roundIndex = roundIndex;
      stepRun.status = 'running';
      stepRun.startedAt = new Date().toISOString();
      appendStressStep(run, round, stepRun);
      appendTaskLog(task, `[${run.deviceId}] 第 ${roundIndex} 轮 ${stepRun.label} 开始`);
      broadcastTask(task);

      try {
        const result = await executeStep(task, run.deviceId, step);
        finishStressStep(task, stepRun, result);
        if (!result.ok && shouldStopStressOnFailure(task, step)) stopRound = true;
      } catch (error) {
        finishStressStep(task, stepRun, { ok: false, error: error.message });
        if (shouldStopStressOnFailure(task, step)) stopRound = true;
      } finally {
        broadcastTask(task);
      }
    }

    if (!task.cancelled && task.script.report?.includePerformance === true) {
      const perfStep = createStepRun({ id: `perf-${roundIndex}`, type: 'perfSnapshot', label: '轮次性能快照' }, task.script.steps.length);
      perfStep.roundIndex = roundIndex;
      perfStep.status = 'running';
      perfStep.startedAt = new Date().toISOString();
      appendStressStep(run, round, perfStep);
      try {
        const result = await capturePerformance(task, run.deviceId, { timeoutMs: DEFAULT_TIMEOUT_MS });
        finishStressStep(task, perfStep, result);
        const warnings = evaluatePerformanceSnapshot(result.snapshot, task.script.acceptance?.thresholds);
        round.warnings.push(...warnings);
      } catch (error) {
        finishStressStep(task, perfStep, { ok: false, error: error.message });
      }
    }

    if (!task.cancelled && (task.script.acceptance?.failOnCrash || task.script.acceptance?.failOnAnr)) {
      const crashResult = await detectCrashAnr(task, run.deviceId, task.script.acceptance);
      if (crashResult.warnings.length > 0) round.warnings.push(...crashResult.warnings);
    }

    const failed = round.steps.some(step => step.status === 'failed') || round.warnings.some(warning => warning.fail === true);
    round.status = task.cancelled ? 'cancelled' : failed ? 'failed' : 'success';
    round.endedAt = new Date().toISOString();
    if (round.status === 'success') {
      run.completedRounds += 1;
      appendTaskLog(task, `[${run.deviceId}] 第 ${roundIndex} 轮完成`);
    } else if (round.status === 'failed') {
      run.failedRounds += 1;
      appendTaskLog(task, `[${run.deviceId}] 第 ${roundIndex} 轮失败`);
      if (loop.continueOnError === false) break;
    }
    broadcastTask(task);

    if (!task.cancelled && loop.intervalMs > 0 && roundIndex < maxCount && Date.now() < deadline) {
      await sleepWithCancel(task, loop.intervalMs);
    }
  }

  if (task.cancelled) {
    run.status = 'cancelled';
  } else {
    run.status = run.failedRounds > 0 ? 'failed' : 'success';
  }
  run.endedAt = new Date().toISOString();
  broadcastTask(task);
}

async function executeStep(task, deviceId, step) {
  const type = step.type;
  if (type === 'shell') {
    const command = String(step.command || '').trim();
    if (!command) return { ok: false, error: 'shell_command_required' };
    return runAdb(task, ['-s', deviceId, 'shell', command], step.timeoutMs || DEFAULT_TIMEOUT_MS);
  }
  if (type === 'installApk') {
    const localPath = String(step.localPath || '').trim();
    if (!localPath) return { ok: false, error: 'apk_path_required' };
    const res = await runAdb(task, ['-s', deviceId, 'install', '-r', '-d', localPath], step.timeoutMs || LONG_TIMEOUT_MS);
    return { ...res, ok: res.ok && /Success/i.test(res.stdout || res.output || '') };
  }
  if (type === 'pushFile') {
    const localPath = String(step.localPath || '').trim();
    const remotePath = String(step.remotePath || '').trim();
    if (!localPath || !remotePath) return { ok: false, error: 'local_or_remote_path_required' };
    return runAdb(task, ['-s', deviceId, 'push', localPath, remotePath], step.timeoutMs || LONG_TIMEOUT_MS);
  }
  if (type === 'screenshot') {
    return captureScreenshot(task, deviceId, step);
  }
  if (type === 'imageCompare') {
    return compareScreenshot(task, deviceId, step);
  }
  if (type === 'perfSnapshot') {
    return capturePerformance(task, deviceId, step);
  }
  if (type === 'tap') {
    return tapUiTarget(task, deviceId, step);
  }
  if (type === 'longPress') {
    return longPressUiTarget(task, deviceId, step);
  }
  if (type === 'swipe') {
    return swipeUiTarget(task, deviceId, step);
  }
  if (type === 'input') {
    return inputText(task, deviceId, step);
  }
  if (type === 'keyevent') {
    return pressKeyevent(task, deviceId, step);
  }
  if (type === 'waitText') {
    return waitForText(task, deviceId, step);
  }
  if (type === 'assertText') {
    return assertText(task, deviceId, step);
  }
  if (type === 'inspection') {
    return captureInspectionSummary(task, deviceId, step);
  }
  if (type === 'waitLog') {
    return waitForLog(task, deviceId, step);
  }
  if (type === 'delay') {
    await sleepWithCancel(task, Math.max(100, Math.min(Number(step.durationMs) || 1000, 600000)));
    return { ok: true, output: '等待完成' };
  }
  if (type === 'externalScript') {
    return runExternalScriptStep(task, deviceId, step);
  }
  return { ok: false, error: `unsupported_step_type:${type}` };
}

async function captureScreenshot(task, deviceId, step) {
  const artifactDir = await ensureTaskArtifactDir(task, 'screenshots');
  const filePath = step.localPath
    ? path.resolve(String(step.localPath))
    : path.join(artifactDir, `${sanitizeName(deviceId)}-${formatStamp(new Date())}.png`);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const cap = await runAdb(task, ['-s', deviceId, 'shell', 'screencap', '-p', DEVICE_TEMP_SCREEN], step.timeoutMs || DEFAULT_TIMEOUT_MS);
  if (!cap.ok) return { ok: false, error: cap.error || cap.stderr || 'screencap_failed' };
  const pull = await runAdb(task, ['-s', deviceId, 'pull', DEVICE_TEMP_SCREEN, filePath], step.timeoutMs || DEFAULT_TIMEOUT_MS);
  await runAdb(task, ['-s', deviceId, 'shell', 'rm', '-f', DEVICE_TEMP_SCREEN], DEFAULT_TIMEOUT_MS).catch(() => {});
  return {
    ok: pull.ok && fs.existsSync(filePath),
    output: pull.output || pull.stdout || '',
    error: pull.ok ? '' : pull.error,
    artifact: filePath
  };
}

async function compareScreenshot(task, deviceId, step) {
  const baselinePath = String(step.baselinePath || step.localPath || '').trim();
  if (!baselinePath) return { ok: false, error: 'baseline_image_required' };
  const resolvedBaseline = path.resolve(baselinePath);
  if (!fs.existsSync(resolvedBaseline)) return { ok: false, error: `baseline_not_found:${resolvedBaseline}` };

  const artifactDir = await ensureTaskArtifactDir(task, 'image-compare');
  const currentPath = path.join(artifactDir, `compare-${sanitizeName(deviceId)}-${formatStamp(new Date())}.png`);
  const capture = await captureScreenshot(task, deviceId, { ...step, localPath: currentPath });
  if (!capture.ok) return capture;

  const baselineBuffer = await fs.promises.readFile(resolvedBaseline);
  const currentBuffer = await fs.promises.readFile(currentPath);
  const result = compareImageBuffers(baselineBuffer, currentBuffer);
  const threshold = clampNumber(step.threshold, 0, 100, 98);
  const passed = result.similarity >= threshold;
  const resultPath = path.join(artifactDir, `compare-${sanitizeName(deviceId)}-${formatStamp(new Date())}.json`);
  await fs.promises.writeFile(resultPath, JSON.stringify({
    deviceId,
    baselinePath: resolvedBaseline,
    currentPath,
    threshold,
    ...result,
    passed
  }, null, 2), 'utf8');

  return {
    ok: passed,
    output: `截图相似度 ${result.similarity.toFixed(2)}%，阈值 ${threshold}%`,
    error: passed ? '' : `截图相似度低于阈值：${result.similarity.toFixed(2)}% < ${threshold}%`,
    artifact: resultPath,
    imageCompare: { ...result, threshold, baselinePath: resolvedBaseline, currentPath, resultPath }
  };
}

async function capturePerformance(task, deviceId, step) {
  const artifactDir = await ensureTaskArtifactDir(task, 'performance');
  const status = await vip.getStatusAsync();
  const snapshot = await performanceMonitor.collectSnapshot(deviceId, status.activated === true);
  const filePath = path.join(artifactDir, `performance-${sanitizeName(deviceId)}-${formatStamp(new Date())}.json`);
  await fs.promises.writeFile(filePath, JSON.stringify({ deviceId, capturedAt: new Date().toISOString(), snapshot }, null, 2), 'utf8');
  const summary = [
    `CPU: ${snapshot.cpu?.usage ?? '-'}`,
    `Memory: ${snapshot.memory?.usage ?? '-'}`,
    `Warnings: ${(snapshot.warnings || []).map(item => item.label).join(', ') || '-'}`
  ].join('\n');
  return { ok: true, output: summary, artifact: filePath, snapshot };
}

async function tapUiTarget(task, deviceId, step) {
  const fallbackPoint = getExplicitPoint(step);
  const point = await findUiPoint(task, deviceId, step, step.timeoutMs || DEFAULT_TIMEOUT_MS) || fallbackPoint;
  if (!point) return { ok: false, error: 'ui_target_not_found' };
  const res = await runAdb(task, ['-s', deviceId, 'shell', `input tap ${point.x} ${point.y}`], step.timeoutMs || DEFAULT_TIMEOUT_MS);
  return { ...res, output: res.output || `点击 ${point.x},${point.y}` };
}

async function longPressUiTarget(task, deviceId, step) {
  const fallbackPoint = getExplicitPoint(step);
  const point = await findUiPoint(task, deviceId, step, step.timeoutMs || DEFAULT_TIMEOUT_MS) || fallbackPoint;
  if (!point) return { ok: false, error: 'ui_target_not_found' };
  const duration = clampNumber(step.durationMs, 300, 10000, 800);
  const command = `input swipe ${point.x} ${point.y} ${point.x} ${point.y} ${duration}`;
  const res = await runAdb(task, ['-s', deviceId, 'shell', command], step.timeoutMs || DEFAULT_TIMEOUT_MS);
  return { ...res, output: res.output || `长按 ${point.x},${point.y} ${duration}ms` };
}

async function swipeUiTarget(task, deviceId, step) {
  const points = getSwipeGesturePoints(step);
  if (points.length >= 3) return curveSwipeUiTarget(task, deviceId, step, points);
  const start = getExplicitPoint(step);
  const end = getExplicitEndPoint(step);
  if (!start || !end) return { ok: false, error: 'swipe_points_required' };
  const duration = clampNumber(step.durationMs, 50, 10000, 300);
  const command = `input swipe ${start.x} ${start.y} ${end.x} ${end.y} ${duration}`;
  const res = await runAdb(task, ['-s', deviceId, 'shell', command], step.timeoutMs || DEFAULT_TIMEOUT_MS);
  return { ...res, output: res.output || `滑动 ${start.x},${start.y} -> ${end.x},${end.y}` };
}

async function curveSwipeUiTarget(task, deviceId, step, points) {
  const duration = clampNumber(step.durationMs, 50, 10000, 300);
  const gesturePoints = limitGesturePoints(points, 80);
  const motionCommand = buildMotionEventSwipeCommand(gesturePoints, duration);
  const motionResult = await runAdb(task, ['-s', deviceId, 'shell', motionCommand], step.timeoutMs || DEFAULT_TIMEOUT_MS);
  if (motionResult.ok) {
    return { ...motionResult, output: motionResult.output || `曲线滑动 ${gesturePoints.length} 点` };
  }
  const fallbackCommand = buildSegmentedSwipeCommand(gesturePoints, duration);
  const fallbackResult = await runAdb(task, ['-s', deviceId, 'shell', fallbackCommand], step.timeoutMs || DEFAULT_TIMEOUT_MS);
  return {
    ...fallbackResult,
    output: fallbackResult.output || `曲线滑动 ${gesturePoints.length} 点（分段模式）`,
    error: fallbackResult.ok ? '' : fallbackResult.error || motionResult.error
  };
}

async function inputText(task, deviceId, step) {
  const text = String(step.text || '');
  if (!text) return { ok: false, error: 'input_text_required' };
  const res = await runAdb(task, ['-s', deviceId, 'shell', `input text ${shellQuoteForAndroidInput(text)}`], step.timeoutMs || DEFAULT_TIMEOUT_MS);
  return { ...res, output: res.output || '文本输入完成' };
}

async function pressKeyevent(task, deviceId, step) {
  const keyCode = String(step.keyCode || '').trim();
  if (!keyCode) return { ok: false, error: 'keycode_required' };
  const res = await runAdb(task, ['-s', deviceId, 'shell', `input keyevent ${keyCode}`], step.timeoutMs || DEFAULT_TIMEOUT_MS);
  return { ...res, output: res.output || `按键 ${keyCode}` };
}

async function waitForText(task, deviceId, step) {
  const selector = normalizeSelector(step);
  if (!hasSelector(selector)) return { ok: false, error: 'selector_required' };
  const node = await waitForUiNode(task, deviceId, { ...step, selector }, step.timeoutMs || DEFAULT_TIMEOUT_MS);
  const label = describeSelector(selector);
  return node ? { ok: true, output: `已找到控件：${label}` } : { ok: false, error: `等待控件超时：${label}` };
}

async function assertText(task, deviceId, step) {
  const selector = normalizeSelector(step);
  if (!hasSelector(selector)) return { ok: false, error: 'selector_required' };
  const node = await findUiNode(task, deviceId, { ...step, selector }, step.timeoutMs || DEFAULT_TIMEOUT_MS);
  const label = describeSelector(selector);
  return node ? { ok: true, output: `断言控件存在：${label}` } : { ok: false, error: `控件不存在：${label}` };
}

async function captureInspectionSummary(task, deviceId, step) {
  const status = await vip.getStatusAsync();
  if (!status.activated) {
    return { ok: false, error: '设备巡检为会员专属功能，请先开通会员', code: 'vip_required' };
  }
  const outputBaseDir = await ensureTaskArtifactDir(task, 'inspection');
  const inspectionTask = createLinkedInspectionTask(task, deviceId);
  const result = await inspection.runInspection(inspectionTask, {
    deviceId,
    deviceLabel: deviceId,
    includeBugreport: step.includeBugreport === true,
    includeAiSummary: step.includeAiSummary === true,
    outputBaseDir
  });
  const findings = result.analysis?.findings || [];
  const output = [
    result.cancelled ? '巡检已取消，已生成部分结果' : result.ok ? '完整巡检已完成' : '巡检未完整完成',
    `报告：${result.reportPath || '-'}`,
    `证据包：${result.zipPath || result.zipError || '-'}`,
    `健康结论：${result.analysis?.summary || '-'}`,
    findings.length > 0 ? `风险项：${findings.map(item => `${item.label}(${item.severity})`).join(', ')}` : '风险项：无'
  ].join('\n');
  return {
    ok: result.ok === true || result.cancelled === true,
    output,
    artifact: result.zipPath || result.reportPath || ''
  };
}

function createLinkedInspectionTask(task, deviceId) {
  const linked = {
    id: `${task.id}-${sanitizeName(deviceId)}`,
    deviceId,
    sender: task.sender
  };
  Object.defineProperties(linked, {
    cancelled: {
      get() { return task.cancelled; },
      set(value) { task.cancelled = value; }
    },
    currentProc: {
      get() { return task.currentProc; },
      set(value) { task.currentProc = value; }
    }
  });
  return linked;
}

async function waitForLog(task, deviceId, step) {
  const keyword = String(step.keyword || '').trim();
  const regexText = String(step.regex || '').trim();
  if (!keyword && !regexText) return { ok: false, error: 'keyword_or_regex_required' };
  const regex = regexText ? new RegExp(regexText) : null;
  const timeoutMs = Math.max(1000, Math.min(Number(step.timeoutMs) || DEFAULT_TIMEOUT_MS, 300000));
  const intervalMs = Math.max(1000, Math.min(Number(step.intervalMs) || 2000, 10000));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (task.cancelled) return { ok: false, error: '用户取消' };
    const res = await runAdb(task, ['-s', deviceId, 'logcat', '-d', '-v', 'threadtime'], Math.min(15000, timeoutMs));
    const text = res.output || res.stdout || '';
    const matched = regex ? regex.test(text) : text.includes(keyword);
    if (matched) {
      const line = text.split(/\r?\n/).find(item => regex ? regex.test(item) : item.includes(keyword)) || '';
      return { ok: true, output: line || '已匹配日志' };
    }
    await sleepWithCancel(task, intervalMs);
  }
  return { ok: false, error: `等待日志超时：${keyword || regexText}` };
}

function createRecorderTask(sender) {
  return {
    id: `recorder-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sender,
    cancelled: false,
    currentProc: null,
    logs: []
  };
}

async function captureUiSnapshot(task, deviceId, timeoutMs) {
  const res = await runAdb(task, ['-s', deviceId, 'shell', 'uiautomator dump /sdcard/window.xml >/dev/null 2>&1 && cat /sdcard/window.xml'], timeoutMs || DEFAULT_TIMEOUT_MS);
  if (!res.ok) return { nodes: [], rawLength: 0, error: res.error || 'uiautomator_dump_failed' };
  const raw = res.stdout || res.output || '';
  const nodes = parseUiNodes(raw)
    .map((node, index) => toPublicUiNode(node, index))
    .filter(node => node.label || node.resourceId || node.contentDesc)
    .slice(0, 300);
  const screenshot = await captureRecorderScreenshot(task, deviceId, timeoutMs || DEFAULT_TIMEOUT_MS);
  return { nodes, rawLength: raw.length, ...screenshot };
}

async function captureRecorderScreenshot(task, deviceId, timeoutMs) {
  const res = await runAdbBuffer(task, ['-s', deviceId, 'exec-out', 'screencap', '-p'], timeoutMs || DEFAULT_TIMEOUT_MS);
  if (!res.ok || !res.stdout?.length) {
    return { screenshotDataUrl: '', screenshotWidth: 0, screenshotHeight: 0, screenshotError: res.error || 'screenshot_failed' };
  }
  const size = getPngSize(res.stdout);
  if (!size) {
    return { screenshotDataUrl: '', screenshotWidth: 0, screenshotHeight: 0, screenshotError: 'invalid_screenshot_png' };
  }
  return {
    screenshotDataUrl: `data:image/png;base64,${res.stdout.toString('base64')}`,
    screenshotWidth: size.width,
    screenshotHeight: size.height,
    screenshotError: ''
  };
}

async function recordStressAction(task, deviceId, args) {
  const action = String(args.action || '').trim();
  const step = buildRecordedStep(action, args);
  if (!step) return { ok: false, error: 'unsupported_record_action' };

  let result = { ok: true, output: '已记录' };
  if (['tap', 'longPress', 'swipe', 'input', 'keyevent', 'waitText', 'assertText'].includes(step.type)) {
    result = await executeStep(task, deviceId, step);
  }
  if (!result.ok) return { ok: false, error: result.error || 'record_action_failed', output: result.output || '', step };
  return { ok: true, output: result.output || '', step };
}

function buildRecordedStep(action, args) {
  const node = args.node && typeof args.node === 'object' ? args.node : null;
  if (action === 'tap') {
    const selector = selectorFromRecordedNode(node);
    const point = pointFromRecordedNodeOrArgs(node, args);
    return normalizeStep({
      type: 'tap',
      label: `点击 ${node?.label || formatPointLabel(point)}`,
      ...selector,
      ...point
    });
  }
  if (action === 'longPress') {
    const selector = selectorFromRecordedNode(node);
    const point = pointFromRecordedNodeOrArgs(node, args);
    return normalizeStep({
      type: 'longPress',
      label: `长按 ${node?.label || formatPointLabel(point)}`,
      ...selector,
      ...point,
      durationMs: args.durationMs || 800
    });
  }
  if (action === 'waitText' || action === 'assertText') {
    const selector = selectorFromRecordedNode(node);
    const text = String(args.text || node?.text || '').trim();
    const label = text || node?.label || describeSelector(selector);
    return normalizeStep({
      type: action,
      label: action === 'waitText' ? `等待 ${label || '控件'}` : `断言 ${label || '控件'}`,
      ...(text ? { text } : {}),
      ...selector,
      timeoutMs: args.timeoutMs || DEFAULT_TIMEOUT_MS
    });
  }
  if (action === 'input') {
    return normalizeStep({
      type: 'input',
      label: '输入文本',
      text: String(args.text || '')
    });
  }
  if (action === 'keyevent') {
    return normalizeStep({
      type: 'keyevent',
      label: `按键 ${args.keyCode || ''}`,
      keyCode: String(args.keyCode || '')
    });
  }
  if (action === 'swipe') {
    const points = normalizeGesturePoints(args.points || args.curvePoints || args.pathPoints);
    return normalizeStep({
      type: 'swipe',
      label: points.length > 2 ? '曲线滑动' : '滑动',
      x: args.x,
      y: args.y,
      endX: args.endX,
      endY: args.endY,
      points,
      durationMs: args.durationMs || 300
    });
  }
  if (action === 'delay') {
    return normalizeStep({
      type: 'delay',
      label: `等待 ${args.durationMs || 1000}ms`,
      durationMs: args.durationMs || 1000
    });
  }
  return null;
}

function toPublicUiNode(node, index) {
  const attrs = node.attrs || {};
  const center = getNodeCenter(node);
  const label = attrs.text || attrs['content-desc'] || attrs['resource-id'] || attrs.class || `控件 ${index + 1}`;
  return {
    index,
    label,
    text: attrs.text || '',
    resourceId: attrs['resource-id'] || '',
    contentDesc: attrs['content-desc'] || '',
    className: attrs.class || '',
    xpath: node.xpath || '',
    packageName: attrs.package || '',
    bounds: attrs.bounds || '',
    rect: {
      left: node.bounds.left,
      top: node.bounds.top,
      right: node.bounds.right,
      bottom: node.bounds.bottom
    },
    x: center.x,
    y: center.y
  };
}

function selectorFromRecordedNode(node) {
  if (!node) return {};
  return compactObject({
    text: String(node.text || '').trim(),
    resourceId: String(node.resourceId || '').trim(),
    contentDesc: String(node.contentDesc || '').trim(),
    className: String(node.className || '').trim(),
    xpath: String(node.xpath || node.path || '').trim()
  });
}

function pointFromRecordedNodeOrArgs(node, args) {
  const x = Number(node?.x ?? args.x);
  const y = Number(node?.y ?? args.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return {};
  return { x: Math.round(x), y: Math.round(y) };
}

function formatPointLabel(point) {
  return Number.isFinite(point?.x) && Number.isFinite(point?.y) ? `${point.x},${point.y}` : '目标';
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item !== '' && item != null));
}

async function waitForUiNode(task, deviceId, step, timeoutMs) {
  if (!hasSelector(normalizeSelector(step))) return null;
  const deadline = Date.now() + Math.max(1000, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 300000));
  const intervalMs = Math.max(500, Math.min(Number(step.intervalMs) || 1000, 10000));
  while (Date.now() <= deadline) {
    if (task.cancelled) return null;
    const node = await findUiNode(task, deviceId, step, Math.min(8000, deadline - Date.now()));
    if (node) return node;
    await sleepWithCancel(task, intervalMs);
  }
  return null;
}

async function findUiPoint(task, deviceId, step, timeoutMs) {
  if (!hasSelector(normalizeSelector(step))) return null;
  const node = await waitForUiNode(task, deviceId, step, timeoutMs);
  return node ? getNodeCenter(node) : null;
}

async function findUiNode(task, deviceId, step, timeoutMs) {
  const selector = normalizeSelector(step);
  if (!hasSelector(selector)) return null;
  const res = await runAdb(task, ['-s', deviceId, 'shell', 'uiautomator dump /sdcard/window.xml >/dev/null 2>&1 && cat /sdcard/window.xml'], timeoutMs || DEFAULT_TIMEOUT_MS);
  if (!res.ok) return null;
  const nodes = parseUiNodes(res.stdout || res.output || '');
  return nodes.find(node => matchUiNode(node, selector)) || null;
}

function parseUiNodes(xml) {
  const nodes = [];
  const tokenRe = /<\/node>|<node\b[^>]*\/?>/g;
  const stack = [];
  const siblingCounters = [new Map()];
  let match;
  while ((match = tokenRe.exec(String(xml || '')))) {
    const token = match[0];
    if (token === '</node>') {
      stack.pop();
      siblingCounters.pop();
      continue;
    }
    const attrs = {};
    const attrRe = /([\w:-]+)="([^"]*)"/g;
    let attrMatch;
    while ((attrMatch = attrRe.exec(token))) {
      attrs[attrMatch[1]] = decodeXml(attrMatch[2]);
    }
    const className = sanitizeSelectorPathSegment(attrs.class || 'node');
    const depth = stack.length;
    const counter = siblingCounters[depth] || new Map();
    siblingCounters[depth] = counter;
    const count = (counter.get(className) || 0) + 1;
    counter.set(className, count);
    const segment = `${className}[${count}]`;
    const xpath = [...stack.map(item => item.segment), segment].join('/');
    const bounds = parseBounds(attrs.bounds);
    if (bounds) nodes.push({ attrs, bounds, xpath });
    if (!token.endsWith('/>')) {
      stack.push({ segment });
      siblingCounters[stack.length] = new Map();
    }
  }
  return nodes;
}

function matchUiNode(node, selector) {
  const attrs = node.attrs || {};
  if (selector.text && attrs.text !== selector.text) return false;
  if (selector.textContains && !String(attrs.text || '').includes(selector.textContains)) return false;
  if (selector.resourceId && attrs['resource-id'] !== selector.resourceId) return false;
  if (selector.contentDesc && attrs['content-desc'] !== selector.contentDesc) return false;
  if (selector.className && attrs.class !== selector.className) return false;
  if (selector.xpath && !selector.text && !selector.textContains && !selector.resourceId && !selector.contentDesc && node.xpath !== selector.xpath) return false;
  return true;
}

function normalizeSelector(step) {
  const selector = step.selector && typeof step.selector === 'object' ? step.selector : {};
  return {
    text: String(selector.text || step.text || '').trim(),
    textContains: String(selector.textContains || step.textContains || '').trim(),
    resourceId: String(selector.resourceId || step.resourceId || '').trim(),
    contentDesc: String(selector.contentDesc || step.contentDesc || '').trim(),
    className: String(selector.className || step.className || '').trim(),
    xpath: String(selector.xpath || selector.path || step.xpath || step.path || '').trim()
  };
}

function hasSelector(selector) {
  return Boolean(selector.text || selector.textContains || selector.resourceId || selector.contentDesc || selector.className || selector.xpath);
}

function describeSelector(selector) {
  if (!selector) return '控件';
  return selector.text || selector.textContains || selector.resourceId || selector.contentDesc || selector.className || selector.xpath || '控件';
}

function getExplicitPoint(step) {
  const x = Number(step.x);
  const y = Number(step.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

function getExplicitEndPoint(step) {
  const x = Number(step.endX);
  const y = Number(step.endY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

function getSwipeGesturePoints(step) {
  const points = normalizeGesturePoints(step.points || step.curvePoints || step.pathPoints);
  if (points.length >= 2) return points;
  const start = getExplicitPoint(step);
  const end = getExplicitEndPoint(step);
  return start && end ? [start, end] : [];
}

function normalizeGesturePoints(value) {
  let source = value;
  if (typeof source === 'string') {
    const text = source.trim();
    if (!text) return [];
    try {
      source = JSON.parse(text);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(source)) return [];
  const points = [];
  for (const item of source) {
    const x = Array.isArray(item) ? Number(item[0]) : Number(item?.x);
    const y = Array.isArray(item) ? Number(item[1]) : Number(item?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const point = { x: Math.round(x), y: Math.round(y) };
    const last = points[points.length - 1];
    if (!last || last.x !== point.x || last.y !== point.y) points.push(point);
  }
  return points.slice(0, 120);
}

function limitGesturePoints(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const result = [points[0]];
  const step = (points.length - 1) / (maxPoints - 1);
  for (let i = 1; i < maxPoints - 1; i += 1) {
    result.push(points[Math.round(i * step)]);
  }
  result.push(points[points.length - 1]);
  return result;
}

function buildMotionEventSwipeCommand(points, durationMs) {
  const interval = Math.max(8, Math.floor(durationMs / Math.max(points.length - 1, 1)));
  const commands = [`input touchscreen motionevent DOWN ${points[0].x} ${points[0].y}`];
  for (const point of points.slice(1, -1)) {
    commands.push(`sleep ${formatShellSleep(interval)}`);
    commands.push(`input touchscreen motionevent MOVE ${point.x} ${point.y}`);
  }
  const last = points[points.length - 1];
  commands.push(`sleep ${formatShellSleep(interval)}`);
  commands.push(`input touchscreen motionevent UP ${last.x} ${last.y}`);
  return commands.join('; ');
}

function buildSegmentedSwipeCommand(points, durationMs) {
  const segmentDuration = Math.max(16, Math.floor(durationMs / Math.max(points.length - 1, 1)));
  const commands = [];
  for (let i = 1; i < points.length; i += 1) {
    const start = points[i - 1];
    const end = points[i];
    commands.push(`input swipe ${start.x} ${start.y} ${end.x} ${end.y} ${segmentDuration}`);
  }
  return commands.join('; ');
}

function formatShellSleep(durationMs) {
  return (Math.max(1, durationMs) / 1000).toFixed(3);
}

function getNodeCenter(node) {
  const bounds = node.bounds;
  return {
    x: Math.round((bounds.left + bounds.right) / 2),
    y: Math.round((bounds.top + bounds.bottom) / 2)
  };
}

function parseBounds(value) {
  const match = String(value || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) return null;
  return {
    left: Number(match[1]),
    top: Number(match[2]),
    right: Number(match[3]),
    bottom: Number(match[4])
  };
}

function sanitizeSelectorPathSegment(value) {
  return String(value || 'node').trim().replace(/[^\w.$-]/g, '_') || 'node';
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function shellQuoteForAndroidInput(value) {
  const text = String(value || '').replace(/\s/g, '%s').replace(/'/g, "'\\''");
  return `'${text}'`;
}

function getPngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  const pngSignature = '89504e470d0a1a0a';
  if (buffer.subarray(0, 8).toString('hex') !== pngSignature) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function compareImageBuffers(baselineBuffer, currentBuffer) {
  const baselineHash = sha256(baselineBuffer);
  const currentHash = sha256(currentBuffer);
  const baselineSize = getPngSize(baselineBuffer);
  const currentSize = getPngSize(currentBuffer);
  if (baselineHash === currentHash) {
    return { similarity: 100, method: 'sha256', baselineHash, currentHash, baselineSize, currentSize };
  }
  try {
    const baseline = decodePngPixels(baselineBuffer);
    const current = decodePngPixels(currentBuffer);
    if (baseline.width !== current.width || baseline.height !== current.height || baseline.channels !== current.channels) {
      return { similarity: 0, method: 'png-dimensions', baselineHash, currentHash, baselineSize, currentSize };
    }
    let totalDelta = 0;
    for (let i = 0; i < baseline.pixels.length; i += 1) {
      totalDelta += Math.abs(baseline.pixels[i] - current.pixels[i]);
    }
    const maxDelta = baseline.pixels.length * 255;
    const similarity = Math.max(0, Math.min(100, (1 - totalDelta / maxDelta) * 100));
    return { similarity, method: 'png-pixels', baselineHash, currentHash, baselineSize, currentSize };
  } catch (error) {
    const maxLength = Math.max(baselineBuffer.length, currentBuffer.length, 1);
    const similarity = Math.max(0, Math.min(99.99, (1 - Math.abs(baselineBuffer.length - currentBuffer.length) / maxLength) * 100));
    return { similarity, method: `metadata:${error.message}`, baselineHash, currentHash, baselineSize, currentSize };
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function decodePngPixels(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not_png');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error('invalid_png_chunk');
    if (type === 'IHDR') {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
      interlace = buffer[dataStart + 12];
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!width || !height || bitDepth !== 8 || interlace !== 0 || !channels) throw new Error('unsupported_png');
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const rowBytes = width * channels;
  const pixels = Buffer.alloc(rowBytes * height);
  let sourceOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    const rowStart = row * rowBytes;
    const prevRowStart = rowStart - rowBytes;
    for (let col = 0; col < rowBytes; col += 1) {
      const raw = inflated[sourceOffset + col];
      const left = col >= channels ? pixels[rowStart + col - channels] : 0;
      const up = row > 0 ? pixels[prevRowStart + col] : 0;
      const upLeft = row > 0 && col >= channels ? pixels[prevRowStart + col - channels] : 0;
      pixels[rowStart + col] = (raw + pngFilterValue(filter, left, up, upLeft)) & 0xff;
    }
    sourceOffset += rowBytes;
  }
  return { width, height, channels, pixels };
}

function pngFilterValue(filter, left, up, upLeft) {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return Math.floor((left + up) / 2);
  if (filter === 4) return paethPredictor(left, up, upLeft);
  throw new Error('unsupported_png_filter');
}

function paethPredictor(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  return pb <= pc ? up : upLeft;
}

function bufferToText(buffer) {
  return Buffer.isBuffer(buffer) ? buffer.toString('utf8').trim() : String(buffer || '').trim();
}

async function runAdb(task, args, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (task.cancelled) return { ok: false, error: '用户取消', output: '' };
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
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  if (!res.ok) {
    return {
      ok: false,
      stdout,
      stderr,
      output: trimOutput(`${stdout}${stderr}`),
      error: task.cancelled ? '用户取消' : (res.error || stderr || 'ADB command failed')
    };
  }
  return { ok: true, stdout, stderr, output: trimOutput(stdout || stderr || '') };
}

async function runAdbBuffer(task, args, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (task.cancelled) {
    return { ok: false, error: '用户取消', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
  let currentProc = null;
  const res = await runRuntimeAdb(args, {
    timeoutMs,
    maxBuffer: MAX_SCREENSHOT_BYTES,
    encoding: 'buffer',
    isCancelled: () => task.cancelled,
    onProcess: (proc) => {
      currentProc = proc;
      task.currentProc = proc;
    }
  });
  if (task.currentProc === currentProc) task.currentProc = null;
  const stdout = res.stdout || Buffer.alloc(0);
  const stderr = res.stderr || Buffer.alloc(0);
  if (!res.ok) {
    return {
      ok: false,
      stdout,
      stderr,
      error: task.cancelled ? '用户取消' : (bufferToText(stderr) || res.error || 'ADB command failed')
    };
  }
  return { ok: true, stdout, stderr };
}

function runProcess(task, command, args, timeoutMs, cwd = undefined) {
  return new Promise((resolve) => {
    if (task.cancelled) {
      resolve({ ok: false, error: '用户取消', output: '' });
      return;
    }
    const proc = execFile(command, args, { windowsHide: true, timeout: timeoutMs, cwd }, (error, stdout, stderr) => {
      if (task.currentProc === proc) task.currentProc = null;
      if (error) {
        resolve({ ok: false, stdout: stdout || '', stderr: stderr || '', output: trimOutput(`${stdout || ''}${stderr || ''}`), error: stderr || error.message });
      } else {
        resolve({ ok: true, stdout: stdout || '', stderr: stderr || '', output: trimOutput(stdout || stderr || '') });
      }
    });
    task.currentProc = proc;
    proc.stdin?.end?.();
  });
}

async function runExternalScriptStep(task, deviceId, step) {
  const artifactDir = await ensureTaskArtifactDir(task, 'external-scripts');
  const context = {
    adb: getAdbCommand(),
    artifactDir,
    deviceId,
    scriptPath: String(step.scriptPath || '').trim()
  };
  const scriptPath = context.scriptPath ? path.resolve(replaceStepPlaceholders(context.scriptPath, context)) : '';
  const adapter = String(step.adapter || 'custom').trim();
  let command = String(step.command || '').trim();
  let args = parseCommandArgs(step.args);

  if (!command) {
    if (adapter === 'maestro') {
      command = 'maestro';
      args = args.length > 0 ? args : ['test', scriptPath];
    } else if (scriptPath) {
      const inferred = inferScriptCommand(scriptPath);
      command = inferred.command;
      args = [...(inferred.prefixArgs || []), ...(inferred.includeScriptPath ? [scriptPath] : []), ...args];
    }
  }

  if (!command) return { ok: false, error: 'external_command_required' };
  const workingDir = String(step.workingDir || '').trim()
    ? path.resolve(replaceStepPlaceholders(step.workingDir, { ...context, scriptPath }))
    : (scriptPath ? path.dirname(scriptPath) : undefined);
  const finalCommand = replaceStepPlaceholders(command, { ...context, scriptPath });
  const finalArgs = args.map(arg => replaceStepPlaceholders(arg, { ...context, scriptPath }));
  const timeoutMs = hasUnlimitedExternalScriptTimeout(scriptPath) ? 0 : (step.timeoutMs || LONG_TIMEOUT_MS);
  const result = await runProcess(task, finalCommand, finalArgs, timeoutMs, workingDir);
  const logPath = path.join(artifactDir, `external-${sanitizeName(deviceId)}-${formatStamp(new Date())}.log`);
  await fs.promises.writeFile(logPath, [
    `adapter=${adapter || 'custom'}`,
    `command=${finalCommand}`,
    `args=${finalArgs.join(' ')}`,
    `cwd=${workingDir || process.cwd()}`,
    '',
    result.output || result.stdout || result.stderr || ''
  ].join('\n'), 'utf8');
  return {
    ...result,
    output: result.output || `外部脚本执行完成：${finalCommand}`,
    artifact: logPath
  };
}

function hasUnlimitedExternalScriptTimeout(scriptPath) {
  const ext = path.extname(String(scriptPath || '')).toLowerCase();
  return ext === '.py' || ext === '.sh';
}

function inferScriptCommand(scriptPath) {
  const ext = path.extname(String(scriptPath || '')).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return { command: 'node', includeScriptPath: true };
  if (ext === '.py') return { command: 'python', includeScriptPath: true };
  if (ext === '.sh') return { command: 'sh', includeScriptPath: true };
  if (ext === '.bat' || ext === '.cmd') return { command: 'cmd.exe', includeScriptPath: false, prefixArgs: ['/c', scriptPath] };
  if (ext === '.ps1') return { command: 'powershell.exe', includeScriptPath: false, prefixArgs: ['-ExecutionPolicy', 'Bypass', '-File', scriptPath] };
  return { command: scriptPath, includeScriptPath: false };
}

function parseCommandArgs(value) {
  if (Array.isArray(value)) return value.map(item => String(item || '')).filter(Boolean);
  return splitCommandLine(String(value || ''));
}

function splitCommandLine(value) {
  const result = [];
  const text = String(value || '');
  let current = '';
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === quote) {
        quote = '';
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        result.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) result.push(current);
  return result;
}

function replaceStepPlaceholders(value, context) {
  return String(value || '')
    .replace(/\{deviceId\}/g, context.deviceId || '')
    .replace(/\{artifactDir\}/g, context.artifactDir || '')
    .replace(/\{scriptPath\}/g, context.scriptPath || '')
    .replace(/\{adb\}/g, context.adb || '');
}

function createTask(script, deviceIds, sender, args) {
  const id = `task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const normalizedScript = normalizeScript(script);
  return {
    id,
    script: normalizedScript,
    scriptName: normalizedScript.name,
    sender,
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: '',
    endedAt: '',
    cancelled: false,
    error: '',
    currentProc: null,
    artifactBaseDir: resolveTaskArtifactBaseDir(args.outputBaseDir),
    artifactDir: '',
    artifactWorkDir: '',
    continueOnError: args.continueOnError ?? normalizedScript.continueOnError ?? true,
    concurrency: args.concurrency || 1,
    completedSteps: 0,
    failedSteps: 0,
    totalSteps: estimateTotalSteps(normalizedScript, deviceIds.length),
    stressSummary: null,
    stressReportPath: '',
    stressResultPath: '',
    logs: [],
    deviceRuns: deviceIds.map(deviceId => ({
      deviceId,
      status: 'queued',
      startedAt: '',
      endedAt: '',
      steps: [],
      stressRounds: [],
      completedRounds: 0,
      failedRounds: 0
    }))
  };
}

async function finishTask(task) {
  killCurrentProcess(task);
  try {
    await finalizeTaskArtifactDir(task);
  } catch (error) {
    task.error = task.error || error.message;
    appendTaskLog(task, `产物目录整理失败：${error.message}`);
  }
  activeTasks.delete(task.id);
  const record = publicTask(task);
  const history = [record, ...readHistory().filter(item => item.id !== task.id)].slice(0, MAX_HISTORY);
  writeHistory(history);
  broadcastTask(task);
  broadcastState();
}

function publicTask(task) {
  if (task?.publicSnapshot) return sanitizePublicTask(task.publicSnapshot);
  if (task && !task.script && task.scriptName) return sanitizePublicTask(task);
  return {
    id: task.id,
    mode: task.script?.mode || 'replay',
    scriptName: task.scriptName,
    status: task.status,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    error: task.error || '',
    continueOnError: task.continueOnError,
    concurrency: task.concurrency,
    artifactDir: task.artifactDir || '',
    artifactBaseDir: task.artifactBaseDir || '',
    completedSteps: task.completedSteps,
    failedSteps: task.failedSteps,
    totalSteps: task.totalSteps,
    stressSummary: task.stressSummary || null,
    stressReportPath: task.stressReportPath || '',
    stressResultPath: task.stressResultPath || '',
    logs: (task.logs || []).slice(-80),
    deviceRuns: (task.deviceRuns || []).map(run => ({
      deviceId: run.deviceId,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      completedRounds: run.completedRounds || 0,
      failedRounds: run.failedRounds || 0,
      stressRounds: (run.stressRounds || []).slice(-20).map(round => ({
        ...round,
        steps: (round.steps || []).slice(-20).map(step => ({ ...step }))
      })),
      steps: (run.steps || []).map(step => ({ ...step }))
    }))
  };
}

function createStepRun(step, index) {
  return {
    id: step.id || `step-${index}`,
    index,
    type: step.type,
    label: step.label || getStepTypeLabel(step.type),
    status: 'queued',
    startedAt: '',
    endedAt: '',
    output: '',
    error: '',
    artifact: ''
  };
}

function normalizeScript(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const steps = Array.isArray(source.steps) ? source.steps.map(normalizeStep).filter(Boolean) : [];
  if (steps.length === 0) throw new Error('脚本至少需要一个步骤');
  const mode = source.mode === 'stress' || source.type === 'stress' ? 'stress' : 'replay';
  return {
    id: String(source.id || `script-${Date.now()}-${Math.random().toString(16).slice(2)}`).trim(),
    name: String(source.name || '未命名脚本').trim().slice(0, 80),
    description: String(source.description || '').trim().slice(0, 500),
    mode,
    continueOnError: source.continueOnError !== false,
    loop: normalizeStressLoop(source.loop || source.stress || {}),
    acceptance: normalizeStressAcceptance(source.acceptance || {}),
    report: normalizeStressReport(source.report || {}),
    steps
  };
}

function normalizeStep(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || 'shell').trim();
  return {
    id: String(raw.id || `step-${Date.now()}-${index ?? 0}-${Math.random().toString(16).slice(2)}`),
    type,
    label: String(raw.label || getStepTypeLabel(type)).trim().slice(0, 80),
    command: String(raw.command || ''),
    localPath: String(raw.localPath || ''),
    remotePath: String(raw.remotePath || ''),
    keyword: String(raw.keyword || ''),
    regex: String(raw.regex || ''),
    text: String(raw.text || ''),
    textContains: String(raw.textContains || ''),
    resourceId: String(raw.resourceId || ''),
    contentDesc: String(raw.contentDesc || ''),
    className: String(raw.className || ''),
    xpath: String(raw.xpath || raw.path || ''),
    selector: normalizeStepSelector(raw.selector || {}),
    x: nullableNumber(raw.x),
    y: nullableNumber(raw.y),
    endX: nullableNumber(raw.endX),
    endY: nullableNumber(raw.endY),
    points: normalizeGesturePoints(raw.points || raw.curvePoints || raw.pathPoints),
    keyCode: String(raw.keyCode || ''),
    baselinePath: String(raw.baselinePath || ''),
    threshold: clampNumber(raw.threshold, 0, 100, 98),
    adapter: String(raw.adapter || 'custom'),
    scriptPath: String(raw.scriptPath || ''),
    args: Array.isArray(raw.args) ? raw.args.map(item => String(item || '')) : String(raw.args || ''),
    workingDir: String(raw.workingDir || ''),
    critical: raw.critical === true,
    outputBaseDir: String(raw.outputBaseDir || ''),
    includeBugreport: raw.includeBugreport === true,
    includeAiSummary: raw.includeAiSummary !== false,
    timeoutMs: clampNumber(raw.timeoutMs, 1000, 600000, DEFAULT_TIMEOUT_MS),
    intervalMs: clampNumber(raw.intervalMs, 500, 60000, 2000),
    durationMs: clampNumber(raw.durationMs, 100, 600000, 1000),
    continueOnError: raw.continueOnError === true
  };
}

function normalizeStressLoop(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const count = clampNumber(source.count ?? source.times, 0, 10000, 1);
  const durationMs = clampNumber(source.durationMs, 0, 24 * 60 * 60 * 1000, 0);
  return {
    count: count > 0 || durationMs <= 0 ? count || 1 : 0,
    durationMs,
    intervalMs: clampNumber(source.intervalMs, 0, 600000, 1000),
    continueOnError: source.continueOnError !== false
  };
}

function normalizeStressAcceptance(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const thresholds = source.thresholds && typeof source.thresholds === 'object' ? source.thresholds : {};
  return {
    minSuccessRate: clampNumber(source.minSuccessRate, 0, 100, 100),
    failOnCrash: source.failOnCrash !== false,
    failOnAnr: source.failOnAnr !== false,
    thresholds: {
      cpu: clampOptionalNumber(thresholds.cpu, 1, 100),
      memory: clampOptionalNumber(thresholds.memory, 1, 100),
      batteryTemp: clampOptionalNumber(thresholds.batteryTemp, 1, 120),
      dataUsed: clampOptionalNumber(thresholds.dataUsed, 1, 100)
    }
  };
}

function normalizeStressReport(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    includeAiSummary: source.includeAiSummary === true,
    includePerformance: source.includePerformance === true
  };
}

function normalizeStepSelector(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    text: String(source.text || '').trim(),
    textContains: String(source.textContains || '').trim(),
    resourceId: String(source.resourceId || '').trim(),
    contentDesc: String(source.contentDesc || '').trim(),
    className: String(source.className || '').trim(),
    xpath: String(source.xpath || source.path || '').trim()
  };
}

function appendStressRound(run, round) {
  run.stressRounds.push(round);
  if (run.stressRounds.length > MAX_STRESS_ROUNDS) {
    run.stressRounds.splice(0, run.stressRounds.length - MAX_STRESS_ROUNDS);
  }
}

function appendStressStep(run, round, stepRun) {
  run.steps.push(stepRun);
  if (run.steps.length > MAX_STRESS_STEP_RECORDS) {
    run.steps.splice(0, run.steps.length - MAX_STRESS_STEP_RECORDS);
  }
  round.steps.push(stepRun);
}

function finishStressStep(task, stepRun, result) {
  stepRun.status = result.ok ? 'success' : task.cancelled ? 'cancelled' : 'failed';
  stepRun.output = trimOutput(result.output || result.stdout || '');
  stepRun.error = result.error || '';
  stepRun.artifact = result.artifact || '';
  stepRun.endedAt = new Date().toISOString();
  if (result.ok) {
    task.completedSteps += 1;
    appendTaskLog(task, `${stepRun.label} 完成`);
  } else {
    task.failedSteps += 1;
    appendTaskLog(task, `${stepRun.label} 失败：${stepRun.error || '未知错误'}`);
  }
}

function shouldStopStressOnFailure(task, step) {
  return task.script.loop?.continueOnError === false || step.critical === true;
}

function evaluatePerformanceSnapshot(snapshot, thresholds = {}) {
  if (!snapshot) return [];
  const warnings = [];
  const push = (type, label, value, limit) => {
    if (limit && Number.isFinite(value) && value > limit) {
      warnings.push({ type, label, value, limit, fail: true });
    }
  };
  push('cpu', 'CPU 使用率超限', Number(snapshot.cpu?.usage), thresholds.cpu);
  push('memory', '内存使用率超限', Number(snapshot.memory?.usage), thresholds.memory);
  push('batteryTemp', '电池温度超限', getSnapshotTemperature(snapshot), thresholds.batteryTemp);
  push('dataUsed', '存储空间使用率超限', getSnapshotDataUsage(snapshot), thresholds.dataUsed);
  return warnings;
}

function getSnapshotTemperature(snapshot) {
  const candidates = [
    snapshot.temperature?.battery,
    snapshot.battery?.temperature,
    snapshot.temperature?.max
  ].map(Number).filter(Number.isFinite);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function getSnapshotDataUsage(snapshot) {
  const disks = Array.isArray(snapshot.disks) ? snapshot.disks : [];
  const dataDisk = disks.find(item => item.mount === '/data' || item.filesystem === '/data') || disks.find(item => String(item.mount || '').includes('/data'));
  return Number(dataDisk?.usage);
}

async function detectCrashAnr(task, deviceId, acceptance) {
  const warnings = [];
  const res = await runAdb(task, ['-s', deviceId, 'shell', 'logcat -d -v time -t 300'], 10000);
  const text = res.output || res.stdout || '';
  if (acceptance.failOnCrash && /FATAL EXCEPTION|AndroidRuntime|CRASH:/i.test(text)) {
    warnings.push({ type: 'crash', label: '检测到崩溃日志', fail: true });
  }
  if (acceptance.failOnAnr && /\bANR\b|Application Not Responding|am_anr/i.test(text)) {
    warnings.push({ type: 'anr', label: '检测到 ANR 日志', fail: true });
  }
  return { ok: warnings.length === 0, warnings };
}

function buildStressSummary(task) {
  const runs = task.deviceRuns || [];
  const rounds = runs.flatMap(run => run.stressRounds || []);
  const totalRounds = rounds.length;
  const failedRounds = rounds.filter(round => round.status === 'failed').length;
  const successRounds = rounds.filter(round => round.status === 'success').length;
  const successRate = totalRounds > 0 ? Math.round(successRounds / totalRounds * 10000) / 100 : 0;
  const acceptance = task.script.acceptance || {};
  const failures = collectStressFailures(runs);
  let passed = failedRounds === 0 && successRate >= acceptance.minSuccessRate;
  let reason = '';
  if (successRate < acceptance.minSuccessRate) {
    passed = false;
    reason = `成功率 ${successRate}% 低于 ${acceptance.minSuccessRate}%`;
  } else if (failedRounds > 0) {
    reason = `存在 ${failedRounds} 个失败轮次`;
  }
  return {
    passed,
    reason,
    totalRounds,
    successRounds,
    failedRounds,
    successRate,
    failures: failures.slice(0, MAX_STRESS_FAILURES)
  };
}

function collectStressFailures(runs) {
  const failures = [];
  for (const run of runs) {
    for (const round of run.stressRounds || []) {
      for (const step of round.steps || []) {
        if (step.status === 'failed') {
          failures.push({
            deviceId: run.deviceId,
            round: round.index,
            step: step.label,
            error: step.error || '未知错误'
          });
        }
      }
      for (const warning of round.warnings || []) {
        if (warning.fail) {
          failures.push({
            deviceId: run.deviceId,
            round: round.index,
            step: warning.label,
            error: warning.limit ? `${warning.value} > ${warning.limit}` : warning.label
          });
        }
      }
    }
  }
  return failures;
}

async function writeStressArtifacts(task, summary) {
  const rootDir = await ensureTaskRootDir(task);
  const resultPath = path.join(rootDir, STRESS_RESULT_FILE);
  const reportPath = path.join(rootDir, STRESS_REPORT_FILE);
  const result = {
    id: task.id,
    scriptName: task.scriptName,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    status: task.status,
    summary,
    loop: task.script.loop,
    acceptance: task.script.acceptance,
    devices: (task.deviceRuns || []).map(run => ({
      deviceId: run.deviceId,
      status: run.status,
      completedRounds: run.completedRounds || 0,
      failedRounds: run.failedRounds || 0,
      rounds: (run.stressRounds || []).map(round => ({
        index: round.index,
        status: round.status,
        startedAt: round.startedAt,
        endedAt: round.endedAt,
        warnings: round.warnings || [],
        steps: (round.steps || []).map(step => ({
          label: step.label,
          type: step.type,
          status: step.status,
          error: step.error || '',
          artifact: step.artifact || ''
        }))
      }))
    }))
  };
  await fs.promises.writeFile(resultPath, JSON.stringify(result, null, 2), 'utf8');
  const aiSummary = task.script.report?.includeAiSummary ? await buildStressAiSummary(result) : { ok: false, skipped: true, summary: '' };
  await fs.promises.writeFile(reportPath, buildStressReport(result, aiSummary), 'utf8');
  task.stressResultPath = resultPath;
  task.stressReportPath = reportPath;
  appendTaskLog(task, `压测报告：${reportPath}`);
}

function buildStressReport(result, aiSummary) {
  const lines = [
    `# ${result.scriptName} 自动化压测报告`,
    '',
    `- 状态：${result.status}`,
    `- 开始时间：${result.startedAt || '-'}`,
    `- 结束时间：${result.endedAt || '-'}`,
    `- 总轮次：${result.summary.totalRounds}`,
    `- 成功轮次：${result.summary.successRounds}`,
    `- 失败轮次：${result.summary.failedRounds}`,
    `- 成功率：${result.summary.successRate}%`,
    `- 结论：${result.summary.passed ? '通过' : '失败'}`,
    result.summary.reason ? `- 原因：${result.summary.reason}` : '',
    '',
    '## 设备结果',
    ''
  ].filter(line => line !== '');

  for (const device of result.devices || []) {
    lines.push(`### ${device.deviceId}`, '');
    lines.push(`- 状态：${device.status}`);
    lines.push(`- 成功轮次：${device.completedRounds}`);
    lines.push(`- 失败轮次：${device.failedRounds}`, '');
  }

  lines.push('## 失败明细', '');
  if ((result.summary.failures || []).length === 0) {
    lines.push('无', '');
  } else {
    lines.push('| 设备 | 轮次 | 步骤 | 错误 |');
    lines.push('| --- | --- | --- | --- |');
    for (const failure of result.summary.failures || []) {
      lines.push(`| ${escapeTable(failure.deviceId)} | ${failure.round} | ${escapeTable(failure.step)} | ${escapeTable(failure.error)} |`);
    }
    lines.push('');
  }

  lines.push('## AI 分析', '');
  if (aiSummary?.ok && aiSummary.summary) {
    lines.push(aiSummary.summary.trim(), '');
  } else if (aiSummary?.skipped) {
    lines.push('未启用 AI 分析。', '');
  } else {
    lines.push(`AI 分析失败：${aiSummary?.error || '未知错误'}`, '');
  }
  return lines.join('\n');
}

async function buildStressAiSummary(result) {
  const prompt = [
    '你是 Android 自动化压测报告分析助手。',
    '只能基于用户提供的结构化压测结果总结，不要臆测未出现的信息。',
    '输出应包含：整体结论、主要失败原因、性能/稳定性风险、下一步建议。'
  ].join('\n');
  const content = JSON.stringify({
    scriptName: result.scriptName,
    status: result.status,
    summary: result.summary,
    devices: result.devices?.map(device => ({
      deviceId: device.deviceId,
      status: device.status,
      completedRounds: device.completedRounds,
      failedRounds: device.failedRounds
    }))
  }, null, 2);
  return aiAnalyze.generateAiSummary({
    systemPrompt: prompt,
    userContent: content,
    timeoutMs: 60000,
    temperature: 0.2
  });
}

function importStressScript(filePath, scriptArgs = '') {
  const target = String(filePath || '').trim();
  if (!target) throw new Error('file_required');
  if (!fs.existsSync(target)) throw new Error('脚本文件不存在');
  const ext = path.extname(target).toLowerCase();
  if (ext === '.py' || ext === '.sh') {
    const fileName = path.basename(target);
    return normalizeScript({
      mode: 'stress',
      name: path.basename(target, ext),
      description: `导入自 ${fileName}`,
      steps: [{
        type: 'externalScript',
        label: `执行 ${fileName}`,
        adapter: 'custom',
        scriptPath: path.resolve(target),
        args: String(scriptArgs ?? '')
      }]
    });
  }
  if (!['.json', '.yaml', '.yml'].includes(ext)) {
    throw new Error(`不支持的脚本格式：${ext || '无扩展名'}`);
  }
  const content = fs.readFileSync(target, 'utf8');
  const parsed = ext === '.yaml' || ext === '.yml' ? parseSimpleYaml(content) : JSON.parse(content);
  return normalizeScript({
    ...parsed,
    mode: 'stress',
    name: parsed.name || path.basename(target, ext),
    description: parsed.description || `导入自 ${path.basename(target)}`
  });
}

function toStressExportScript(script) {
  return {
    version: 1,
    name: script.name,
    description: script.description,
    mode: 'stress',
    loop: script.loop,
    acceptance: script.acceptance,
    report: script.report,
    steps: script.steps
  };
}

function parseSimpleYaml(content) {
  const lines = String(content || '').split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, value: root }];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '  ');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.match(/^\s*/)[0].length;
    const text = line.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].value;
    if (text.startsWith('- ')) {
      if (!Array.isArray(parent)) throw new Error('YAML 列表必须位于数组字段下');
      const itemText = text.slice(2).trim();
      const item = {};
      parent.push(item);
      if (itemText) assignYamlPair(item, itemText);
      stack.push({ indent, value: item });
      continue;
    }
    const { key, value, hasValue } = splitYamlPair(text);
    if (!key) continue;
    if (hasValue) {
      parent[key] = parseYamlScalar(value);
    } else {
      const child = key === 'steps' ? [] : {};
      parent[key] = child;
      stack.push({ indent, value: child });
    }
  }
  return root;
}

function assignYamlPair(target, text) {
  const { key, value, hasValue } = splitYamlPair(text);
  if (!key || !hasValue) return;
  target[key] = parseYamlScalar(value);
}

function splitYamlPair(text) {
  const index = text.indexOf(':');
  if (index < 0) return { key: '', value: '', hasValue: false };
  const key = text.slice(0, index).trim();
  const value = text.slice(index + 1).trim();
  return { key, value, hasValue: value.length > 0 };
}

function parseYamlScalar(value) {
  const text = String(value || '').trim();
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return text.replace(/^['"]|['"]$/g, '');
}

function readScripts() {
  if (scriptsCache) return scriptsCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(getDataPath(SCRIPTS_FILE), 'utf8'));
    const scripts = Array.isArray(parsed?.scripts) ? parsed.scripts : [];
    scriptsCache = scripts.length > 0 ? scripts : [DEFAULT_SCRIPT];
  } catch {
    scriptsCache = [DEFAULT_SCRIPT];
  }
  return scriptsCache;
}

function writeScripts(scripts) {
  scriptsCache = scripts;
  writeJson(getDataPath(SCRIPTS_FILE), { version: 1, scripts });
}

function readHistory() {
  if (historyCache) return historyCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(getDataPath(HISTORY_FILE), 'utf8'));
    historyCache = Array.isArray(parsed?.history) ? parsed.history.slice(0, MAX_HISTORY) : [];
  } catch {
    historyCache = [];
  }
  return historyCache;
}

function writeHistory(history) {
  historyCache = history.slice(0, MAX_HISTORY);
  writeJson(getDataPath(HISTORY_FILE), { version: 1, history: historyCache });
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

async function ensureTaskArtifactDir(task, subDir) {
  const rootDir = await ensureTaskRootDir(task);
  const dir = path.join(rootDir, subDir);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

async function ensureTaskRootDir(task) {
  if (!task.artifactWorkDir) {
    const baseDir = task.artifactBaseDir || resolveTaskArtifactBaseDir('');
    task.artifactBaseDir = baseDir;
    task.artifactWorkDir = path.join(baseDir, `_running-${task.id}`);
    task.artifactDir = task.artifactWorkDir;
  }
  await fs.promises.mkdir(task.artifactWorkDir, { recursive: true });
  return task.artifactWorkDir;
}

async function finalizeTaskArtifactDir(task) {
  const workDir = task.artifactWorkDir;
  if (!workDir) return;
  await fs.promises.mkdir(task.artifactBaseDir || resolveTaskArtifactBaseDir(''), { recursive: true });
  const endedAt = task.endedAt ? new Date(task.endedAt) : new Date();
  const finalName = `${sanitizeName(task.scriptName || 'task')}-${formatStamp(endedAt)}`;
  const finalDir = await uniqueDirPath(task.artifactBaseDir || resolveTaskArtifactBaseDir(''), finalName);
  try {
    await fs.promises.rename(workDir, finalDir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.promises.mkdir(finalDir, { recursive: true });
  }
  rebaseTaskArtifactPaths(task, workDir, finalDir);
  task.artifactDir = finalDir;
  task.artifactWorkDir = '';
}

async function uniqueDirPath(baseDir, name) {
  let candidate = path.join(baseDir, name);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(baseDir, `${name}-${index}`);
    index += 1;
  }
  return candidate;
}

function rebaseTaskArtifactPaths(task, fromDir, toDir) {
  const from = path.resolve(fromDir);
  const replacePath = (value) => {
    const text = String(value || '');
    return text ? text.split(from).join(toDir) : text;
  };
  for (const run of task.deviceRuns || []) {
    for (const step of run.steps || []) {
      step.artifact = replacePath(step.artifact);
      step.output = replacePath(step.output);
    }
    for (const round of run.stressRounds || []) {
      for (const step of round.steps || []) {
        step.artifact = replacePath(step.artifact);
        step.output = replacePath(step.output);
      }
    }
  }
  task.stressReportPath = replacePath(task.stressReportPath);
  task.stressResultPath = replacePath(task.stressResultPath);
}

function resolveTaskArtifactBaseDir(outputBaseDir) {
  const explicit = String(outputBaseDir || '').trim();
  if (explicit) return path.resolve(explicit);
  const configured = readTaskCenterPath();
  return configured || path.join(app.getPath('userData'), ARTIFACT_DIR);
}

function readTaskCenterPath() {
  try {
    const settingsFilePath = getDataPath(SETTINGS_FILE);
    if (!fs.existsSync(settingsFilePath)) return '';
    const settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    return String(settings.taskCenterPath || '').trim();
  } catch {
    return '';
  }
}

function getDataPath(fileName) {
  return path.join(app.getPath('userData'), fileName);
}

function killCurrentProcess(task) {
  if (!task.currentProc) return;
  try { task.currentProc.kill(); } catch {}
  task.currentProc = null;
}

function appendTaskLog(task, message) {
  task.logs.push({ at: new Date().toISOString(), message });
  if (task.logs.length > 120) task.logs.splice(0, task.logs.length - 120);
}

function broadcastTask(task) {
  ctx.broadcastToAllWindows('task-center:update', {
    task: publicTask(task),
    activeTasks: Array.from(activeTasks.values()).map(publicTask),
    history: readHistory()
  });
}

function broadcastState() {
  ctx.broadcastToAllWindows('task-center:update', {
    activeTasks: Array.from(activeTasks.values()).map(publicTask),
    history: readHistory()
  });
}

function normalizeDeviceIds(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(item => String(item || '').trim()).filter(Boolean)));
}

function normalizeDeviceId(value) {
  return String(value || '').trim();
}

function getStepTypeLabel(type) {
  return {
    shell: '执行 Shell',
    installApk: '安装 APK',
    pushFile: '推送文件',
    screenshot: '截图',
    imageCompare: '截图比对',
    perfSnapshot: '性能采样',
    tap: '点击',
    longPress: '长按',
    swipe: '滑动',
    input: '输入文本',
    keyevent: '按键',
    waitText: '等待文本',
    assertText: '断言文本',
    inspection: '设备巡检',
    waitLog: '等待日志',
    externalScript: '外部脚本',
    delay: '等待'
  }[type] || '执行步骤';
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampOptionalNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(min, Math.min(max, n));
}

function nullableNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function estimateTotalSteps(script, deviceCount) {
  const stepCount = script.steps?.length || 0;
  if (script.mode !== 'stress') return deviceCount * stepCount;
  const loopCount = script.loop?.count > 0 ? script.loop.count : 1;
  const perfExtra = script.report?.includePerformance === true ? 1 : 0;
  return deviceCount * loopCount * (stepCount + perfExtra);
}

function trimOutput(value) {
  const text = String(value || '');
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n...输出已截断` : text;
}

function sanitizeName(value) {
  return String(value || 'device').replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_').slice(0, 80) || 'device';
}

function formatStamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function sleepWithCancel(task, durationMs) {
  return new Promise((resolve, reject) => {
    if (task.cancelled) {
      reject(new Error('用户取消'));
      return;
    }
    const timer = setTimeout(() => {
      clearInterval(check);
      resolve();
    }, durationMs);
    const check = setInterval(() => {
      if (!task.cancelled) return;
      clearTimeout(timer);
      clearInterval(check);
      reject(new Error('用户取消'));
    }, 200);
    check.unref?.();
  });
}

function cleanup() {
  if (workerBroadcastTimer) {
    clearTimeout(workerBroadcastTimer);
    workerBroadcastTimer = null;
  }
  for (const task of activeTasks.values()) {
    task.cancelled = true;
    task.status = 'cancelled';
    cancelBridgeInspectionTasks(task.id);
    killCurrentProcess(task);
  }
  activeTasks.clear();
  bridgeInspectionTasks.clear();
  if (taskWorker) {
    try { taskWorker.postMessage({ action: 'shutdown' }); } catch {}
    try { taskWorker.terminate(); } catch {}
    taskWorker = null;
  }
}

module.exports = { register, cleanup, runInlineScript };
