const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { validateRecordingMp4 } = require('./screen-recording-mp4.cjs');

const ACTIVE = new Set(['starting', 'recording', 'stopping', 'saving']);
const RETAIN_HISTORY = 60;
const PID_MARKER = '__AW_SCREENRECORD_PID__=';
const GONE_MARKER = '__AW_PROCESS_GONE__';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function remotePathFor(id) { return `/sdcard/adb-workbench-screenrecord-${id}.mp4`; }
function localNameFor(session) { return `screenrecord_${new Date(session.startedAt).toISOString().replace(/[:.]/g, '-')}_${session.id}.mp4`; }
function errorText(result, fallback) { return String(result?.stderr || result?.error || fallback).trim(); }
function validDeviceId(value) { return typeof value === 'string' && value.trim() && value.length <= 512 && !value.includes('\0'); }
function publicSession(session) {
  const { pid, localPath, remoteStopped, ...visible } = session;
  return visible;
}

function createScreenRecordingService({
  directory, runAdb, spawnAdb, getOutputDirectory = async () => path.join(directory, 'screenrecord'),
  onSaved = async () => null, logCaptureFactory = args => require('./recording-log.cjs').startRecordingLog(args),
  broadcast = () => {}, now = Date.now,
  delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  startupTimeoutMs = 10000, stopTimeoutMs = 15000, pollMs = 150
}) {
  const statePath = path.join(directory, 'screen-recording-sessions.json');
  const sessions = new Map();
  const runtimes = new Map();
  let initializationError = '';

  function list({ deviceId } = {}) {
    return [...sessions.values()].filter(session => !deviceId || session.deviceId === deviceId)
      .sort((left, right) => right.startedAt - left.startedAt).map(publicSession);
  }

  function persist() {
    const history = [...sessions.values()].filter(session => !ACTIVE.has(session.status) && session.status !== 'needs-save')
      .sort((left, right) => right.startedAt - left.startedAt);
    for (const session of history.slice(RETAIN_HISTORY)) {
      sessions.delete(session.id);
      runtimes.delete(session.id);
    }
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${statePath}.${randomUUID()}.tmp`;
    try {
      const file = fs.openSync(temporary, 'wx');
      try {
        fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: [...sessions.values()] }), 'utf8');
        fs.fsyncSync(file);
      } finally { fs.closeSync(file); }
      fs.renameSync(temporary, statePath);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  function notify() {
    try { broadcast({ sessions: list() }); } catch { /* A closing window must not interrupt file recovery. */ }
  }

  function update(session, patch) {
    Object.assign(session, patch);
    persist();
    notify();
  }

  function failed(session, error) {
    Object.assign(session, { status: 'needs-save', error: error.message || String(error) });
    try { persist(); } catch (persistError) { session.error += `；恢复记录保存失败：${persistError.message}`; }
    notify();
    return { success: false, error: session.error, session: publicSession(session) };
  }

  function restore() {
    if (!fs.existsSync(statePath)) return;
    const stored = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (stored.version !== 1 || !Array.isArray(stored.sessions)) throw new Error('录屏恢复记录格式无效');
    const validated = [];
    for (const item of stored.sessions) {
      if (!UUID.test(item?.id) || !validDeviceId(item.deviceId) || !Number.isFinite(item.startedAt) || !Number.isFinite(new Date(item.startedAt).getTime())
        || item.remotePath !== remotePathFor(item.id) || ![...ACTIVE, 'needs-save', 'saved', 'error'].includes(item.status)) throw new Error('录屏恢复记录包含无效会话');
      if (item.pid !== undefined && (!Number.isSafeInteger(item.pid) || item.pid <= 1)) throw new Error('录屏恢复进程标识无效');
      if (item.localPath !== undefined && (typeof item.localPath !== 'string' || !path.isAbsolute(item.localPath) || path.normalize(item.localPath) !== item.localPath || path.basename(item.localPath) !== localNameFor(item))) throw new Error('录屏恢复路径无效');
      if (item.path !== undefined && item.path !== item.localPath || item.status === 'saved' && !item.localPath) throw new Error('录屏恢复文件无效');
      if (item.logPath !== undefined && (!item.localPath || item.logPath !== item.localPath.replace(/\.mp4$/i, '.log'))) throw new Error('录屏日志恢复路径无效');
      const session = {
        id: item.id, deviceId: item.deviceId, startedAt: item.startedAt, remotePath: item.remotePath,
        status: item.status, pid: item.pid, localPath: item.localPath, path: item.path,
        withLogs: item.withLogs === true, logPath: item.logPath, logTruncated: item.logTruncated === true,
        remoteStopped: item.status === 'saved'
      };
      for (const key of ['endedAt', 'durationMs', 'savedAt']) if (Number.isFinite(item[key])) session[key] = item[key];
      for (const key of ['error', 'logError', 'mediaId']) if (typeof item[key] === 'string') session[key] = item[key].slice(0, 4096);
      if (ACTIVE.has(session.status)) {
        session.status = 'needs-save';
        session.error = '上次录屏未完成保存，请连接原设备后重新保存';
      }
      validated.push(session);
    }
    for (const session of validated) sessions.set(session.id, session);
    persist();
  }
  try { restore(); } catch (error) { initializationError = `录屏恢复记录无法读取，已保留原文件：${error.message}`; }

  async function adb(session, args, timeoutMs = 5000) {
    return runAdb(['-s', session.deviceId, ...args], { timeoutMs, queue: false });
  }

  async function resolvePid(session) {
    if (Number.isInteger(session.pid) && session.pid > 1) return session.pid;
    const result = await adb(session, ['shell', `cat ${session.remotePath}.pid`]);
    if (!result.ok || !/^\d+\s*$/.test(String(result.stdout))) {
      throw new Error(errorText(result, '无法确认录屏进程，请连接原设备后重新保存'));
    }
    const pid = Number(String(result.stdout).trim());
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('录屏进程标识无效');
    update(session, { pid });
    return pid;
  }

  async function processState(session) {
    const pid = await resolvePid(session);
    const result = await adb(session, ['shell', `if [ -d /proc/${pid} ]; then cat /proc/${pid}/cmdline; else printf '${GONE_MARKER}'; fi`]);
    if (!result.ok) throw new Error(errorText(result, '无法确认录屏是否已停止'));
    const command = String(result.stdout || '').trim();
    if (command === GONE_MARKER || !command) return 'gone';
    const args = command.split('\0').filter(Boolean);
    if (path.posix.basename(args[0]) === 'screenrecord' && args.includes(session.remotePath)) return 'owned';
    // PID reuse means our process has ended; never signal its new owner.
    if ((args[0] === 'sh' || args[0] === '/system/bin/sh') && command.includes(session.remotePath)) return 'starting';
    return 'gone';
  }

  async function stopRemote(session) {
    if (session.remoteStopped) return;
    let state = await processState(session);
    const startupDeadline = now() + startupTimeoutMs;
    while (state === 'starting' && now() < startupDeadline) {
      await delay(pollMs);
      state = await processState(session);
    }
    if (state === 'starting') throw new Error('录屏进程尚未就绪，请稍后重试');
    if (state === 'owned') {
      const command = `cmdline=$(tr '\\000' ' ' < /proc/${session.pid}/cmdline 2>/dev/null); case "$cmdline" in 'screenrecord --verbose ${session.remotePath} '|'/system/bin/screenrecord --verbose ${session.remotePath} ') kill -2 ${session.pid} ;; *) printf 'recording_process_changed'; exit 3 ;; esac`;
      const signal = await adb(session, ['shell', command]);
      if (!signal.ok) {
        state = await processState(session);
        if (state !== 'gone') throw new Error(errorText(signal, '停止录屏失败，请重试'));
      }
      const deadline = now() + stopTimeoutMs;
      while (state !== 'gone' && now() < deadline) {
        await delay(pollMs);
        state = await processState(session);
      }
      if (state !== 'gone') throw new Error('录屏尚未完成封装，未强制终止；请稍后重新保存');
    }
    update(session, { remoteStopped: true, endedAt: session.endedAt || now(), durationMs: Math.max(0, (session.endedAt || now()) - session.startedAt) });
  }

  async function stopLogger(session) {
    await runtimes.get(session.id)?.loggerPromise;
    const logger = runtimes.get(session.id)?.logger;
    if (logger) {
      const log = await logger.stop().catch(error => ({ error: error.message }));
      update(session, { logPath: log.path || session.logPath, logTruncated: Boolean(log.truncated), logError: log.error || undefined });
      runtimes.get(session.id).logger = null;
    }
  }

  async function save(session) {
    await stopRemote(session);
    await stopLogger(session);
    update(session, { status: 'saving', error: undefined });
    if (!session.localPath) {
      const outputDirectory = path.resolve(await getOutputDirectory());
      await fs.promises.mkdir(outputDirectory, { recursive: true });
      update(session, { localPath: path.join(outputDirectory, localNameFor(session)) });
    }
    const temporary = `${session.localPath}.${randomUUID()}.partial`;
    try {
      // A prior attempt may have published the local video before metadata failed.
      if (fs.existsSync(session.localPath)) {
        await validateRecordingMp4(session.localPath);
      } else {
        await fs.promises.mkdir(path.dirname(session.localPath), { recursive: true });
        const pulled = await adb(session, ['pull', session.remotePath, temporary], 120000);
        if (!pulled.ok) throw new Error(errorText(pulled, '录屏保存失败，设备上的原文件已保留'));
        await validateRecordingMp4(temporary);
        await fs.promises.rename(temporary, session.localPath);
      }
      const media = await onSaved({ type: 'video', deviceId: session.deviceId, path: session.localPath, createdAt: session.startedAt, durationMs: session.durationMs, logPath: session.logPath, logTruncated: session.logTruncated, logError: session.logError });
      update(session, { status: 'saved', path: session.localPath, mediaId: media?.id, savedAt: now(), error: undefined });
      // Only clean our exact generated files after durable saved state and MP4 validation.
      await adb(session, ['shell', `rm -f ${session.remotePath} ${session.remotePath}.pid`]).catch(() => {});
      return { success: true, path: session.path, session: publicSession(session) };
    } finally {
      if (fs.existsSync(temporary)) await fs.promises.unlink(temporary).catch(() => {});
    }
  }

  function finish(session) {
    let runtime = runtimes.get(session.id);
    if (!runtime) { runtime = {}; runtimes.set(session.id, runtime); }
    if (runtime.finishing) return runtime.finishing;
    if (session.status === 'saved') return Promise.resolve({ success: true, path: session.path, session: publicSession(session) });
    runtime.finishing = Promise.resolve().then(async () => {
      try {
        update(session, { status: 'stopping' });
        await runtime.launched;
        const pidDeadline = now() + startupTimeoutMs;
        while (runtime.proc && !runtime.closed && !session.pid && now() < pidDeadline) await delay(pollMs);
        return await save(session);
      } catch (error) {
        await stopLogger(session).catch(() => {});
        return failed(session, error);
      }
    }).finally(() => { runtime.finishing = null; });
    return runtime.finishing;
  }

  async function onProcessClose(session, runtime) {
    runtime.closed = true;
    if (session.status === 'error' || session.status === 'saved') return;
    if (!runtime.ready && !runtime.finishing) {
      // Early startup failure without a video is not an unsaved recording.
      const exists = await adb(session, ['shell', `if [ -f ${session.remotePath} ]; then printf exists; else printf absent; fi`]).catch(() => null);
      if (exists?.ok && String(exists.stdout).trim() === 'absent') {
        try { update(session, { status: 'error', endedAt: now(), error: runtime.output.replace(/__AW_SCREENRECORD_PID__=\d+/g, '').trim() || '设备无法启动录屏' }); } catch (error) { failed(session, error); }
        return;
      }
    }
    await finish(session);
  }

  async function start({ deviceId, withLogs = false } = {}) {
    if (initializationError) return { success: false, error: initializationError };
    if (!validDeviceId(deviceId)) return { success: false, error: '请选择有效设备' };
    const pending = [...sessions.values()].find(session => session.deviceId === deviceId && (ACTIVE.has(session.status) || session.status === 'needs-save' && !session.remoteStopped));
    if (pending) return { success: false, error: '当前设备仍有正在进行或尚未确认停止的录屏，请先停止并保存', session: publicSession(pending) };
    const id = randomUUID();
    const session = { id, deviceId, status: 'starting', startedAt: now(), remotePath: remotePathFor(id), withLogs: withLogs === true };
    const runtime = { output: '', pidOutput: '', closed: false, ready: false, finishing: null };
    runtime.launched = new Promise(resolve => { runtime.resolveLaunched = resolve; });
    sessions.set(id, session);
    runtimes.set(id, runtime);
    try {
      update(session, {});
      const outputDirectory = path.resolve(await getOutputDirectory());
      await fs.promises.mkdir(outputDirectory, { recursive: true });
      update(session, { localPath: path.join(outputDirectory, localNameFor(session)) });
      const command = `echo $$ > ${session.remotePath}.pid; echo ${PID_MARKER}$$; exec screenrecord --verbose ${session.remotePath}`;
      const proc = spawnAdb(['-s', deviceId, 'shell', command], { detached: false });
      runtime.proc = proc;
      const output = (chunk, stdout = false) => {
        runtime.output = (runtime.output + chunk.toString()).slice(-8192);
        if (stdout) runtime.pidOutput = (runtime.pidOutput + chunk.toString()).slice(-1024);
        const marker = runtime.pidOutput.match(/__AW_SCREENRECORD_PID__=(\d+)\r?\n/);
        if (marker && !session.pid) {
          try { update(session, { pid: Number(marker[1]) }); } catch (error) { failed(session, error); }
        }
      };
      proc.stdout?.on('data', chunk => output(chunk, true));
      proc.stderr?.on('data', output);
      proc.once('error', error => {
        runtime.closed = true;
        if (!session.pid) {
          try { update(session, { status: 'error', endedAt: now(), error: error.message }); } catch (persistError) { failed(session, persistError); }
        } else {
          void finish(session);
        }
      });
      proc.once('close', () => { runtime.closePromise = onProcessClose(session, runtime).catch(error => failed(session, error)); });
      runtime.resolveLaunched();
      const deadline = now() + startupTimeoutMs;
      while (!runtime.closed && now() < deadline && session.status === 'starting') {
        if (session.pid && await processState(session) === 'owned') {
          const ready = await adb(session, ['shell', `test -f ${session.remotePath} && printf ready`]);
          if (ready.ok && String(ready.stdout).trim() === 'ready' && !runtime.closed && session.status === 'starting') {
            runtime.ready = true;
            update(session, { status: 'recording' });
            if (session.withLogs) {
              runtime.loggerPromise = Promise.resolve().then(() => logCaptureFactory({ deviceId, videoPath: session.localPath,
                onState: log => {
                  try { update(session, { logPath: log.path || session.logPath, logTruncated: Boolean(log.truncated), logError: log.error || undefined }); }
                  catch (error) { failed(session, error); }
                }
              }))
                .then(logger => {
                  runtime.logger = logger;
                  const log = logger.info();
                  update(session, { logPath: log.path, logTruncated: Boolean(log.truncated), logError: log.error || undefined });
                }).catch(error => { update(session, { logError: `视频已开始，但日志抓取失败：${error.message}` }); });
              await runtime.loggerPromise;
              if (runtime.closed) await finish(session);
            }
            return { success: true, session: publicSession(session) };
          }
        }
        await delay(pollMs);
      }
      if (runtime.closePromise) await runtime.closePromise;
      if (ACTIVE.has(session.status)) {
        await finish(session);
      }
      return { success: false, session: publicSession(session), error: session.error || '录屏未能正常启动，请检查设备是否支持录屏' };
    } catch (error) {
      runtime.resolveLaunched();
      if (!runtime.proc) {
        try { update(session, { status: 'error', error: error.message, endedAt: now() }); } catch { /* Preserve the original startup failure. */ }
        return { success: false, error: error.message, session: publicSession(session) };
      }
      return failed(session, error);
    }
  }

  async function stop({ deviceId } = {}) {
    if (initializationError) return { success: false, error: initializationError };
    const session = [...sessions.values()].filter(item => item.deviceId === deviceId && (ACTIVE.has(item.status) || item.status === 'needs-save'))
      .sort((left, right) => right.startedAt - left.startedAt)[0];
    if (!session) return { success: false, error: '当前设备没有待保存的录屏' };
    return finish(session);
  }

  async function retry({ id } = {}) {
    if (initializationError) return { success: false, error: initializationError };
    const session = sessions.get(id);
    if (!session || session.status !== 'needs-save' && !runtimes.get(id)?.finishing) return { success: false, error: '没有找到待重新保存的录屏' };
    return finish(session);
  }

  function mightBeActive(session) { return ACTIVE.has(session.status) || session.status === 'needs-save' && !session.remoteStopped; }
  function hasActiveRecordings() { return [...sessions.values()].some(mightBeActive); }
  function listUnresolved() { return list().filter(session => ACTIVE.has(session.status) || session.status === 'needs-save'); }
  async function stopAllRecordings() {
    const active = [...sessions.values()].filter(session => ACTIVE.has(session.status) || session.status === 'needs-save');
    const results = await Promise.all(active.map(finish));
    return { success: results.every(result => result.success), failed: results.filter(result => !result.success).map(result => result.session) };
  }

  return { start, stop, retry, list, hasActiveRecordings, listUnresolved, stopAllRecordings };
}

let singleton;
function getService() {
  if (singleton) return singleton;
  const { app, BrowserWindow } = require('electron');
  const { runAdb, spawnAdb } = require('./adb-runtime.cjs');
  const directory = app.getPath('userData');
  singleton = createScreenRecordingService({
    directory, runAdb, spawnAdb,
    getOutputDirectory: async () => {
      let settings = {};
      try { settings = JSON.parse(await fs.promises.readFile(path.join(directory, 'settings.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return typeof settings.screenRecordPath === 'string' && settings.screenRecordPath.trim() ? settings.screenRecordPath : path.join(directory, 'screenrecord');
    },
    onSaved: item => require('./device-media.cjs').recordMedia(item),
    broadcast: payload => { for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('screenrecord:state', payload); }
  });
  return singleton;
}

function register(ipcMain) {
  const service = getService();
  ipcMain.handle('adb:screenrecord:start', (_event, args) => service.start(args));
  ipcMain.handle('adb:screenrecord:stop', (_event, args) => service.stop(args));
  ipcMain.handle('adb:screenrecord:status', (_event, args) => ({ success: true, recording: service.list(args).some(session => ACTIVE.has(session.status)), sessions: service.list(args) }));
  ipcMain.handle('screenrecord:list', (_event, args) => ({ success: true, sessions: service.list(args) }));
  ipcMain.handle('screenrecord:retry', (_event, args) => service.retry(args));
}

module.exports = {
  createScreenRecordingService, register,
  hasActiveRecordings: () => getService().hasActiveRecordings(),
  listUnresolved: () => getService().listUnresolved(),
  stopAllRecordings: () => getService().stopAllRecordings()
};
