const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { tr, onLocaleChanged } = require('./localization.cjs');
const { mediaLabels } = require('./harmony-media-labels.cjs');
const { createHarmonyMediaSessions } = require('./harmony-media-session.cjs');
const { createHarmonyRecordingService } = require('./harmony-recording.cjs');
const { resolveDeviceRef } = require('./device-registry.cjs');
const { performHarmonyInput } = require('./harmony-task-ui.cjs');
const { createHarmonyMediaInput } = require('./harmony-media-input.cjs');
const { normalizeDecoderDiagnostic, normalizeDecoderEvent, firstFrameFailure } = require('./harmony-media-diagnostics.cjs');
const applicationLog = require('./application-log.cjs');
const { classifyApplicationError } = require('./application-log-policy.cjs');

const ACTIVE_RECORDINGS = new Set(['starting', 'recording', 'stopping', 'saving']);
let singleton;
function getManager() {
  if (singleton) return singleton;
  const { app, BrowserWindow } = require('electron');
  const views = new Map(), recordingListeners = new Set();
  let viewCounter = 0;
  const recordRequests = new Map();
  const currentRecordings = () => recordings.list().map(item => ({ ...item,
    error: item.error ? tr(item.error) : '', logError: item.logError ? tr(item.logError) : '' }));
  const send = (view, channel, data) => {
    if (!view.window.isDestroyed()) view.window.webContents.send('harmony-media:' + channel, data);
  };
  const forSession = id => [...views.values()].find(view => view.sessionId === id);
  const streams = createHarmonyMediaSessions({
    onFrame: (id, frame) => {
      const view = forSession(id);
      if (!view || view.window.isDestroyed() || !view.rendererReady) throw new Error(tr('投屏窗口已关闭。'));
      if (view.inFlight.size >= 12) throw new Error(tr('投屏窗口处理速度不足，已停止继续堆积视频帧。'));
      const sequence = view.sequence++;
      view.inFlight.add(sequence);
      const session = streams.get(id);
      send(view, 'frame', { sessionId: id, sequence, timestamp: frame.timestamp, flags: frame.flags,
        data: frame.data, width: session.width, height: session.height });
    },
    onState: state => {
      applicationLog.record({ source: 'media', event: 'state', stage: state.status,
        ...(state.error ? classifyApplicationError(state.error) : {}) });
      const view = views.get(state.deviceId);
      if (!view || view.sessionId && view.sessionId !== state.id) return;
      if (!view.sessionId && state.status !== 'starting') return;
      view.sessionId = state.id;
      send(view, 'state', { ...state, error: state.error ? tr(state.error) : '' });
      if (['stopped', 'failed'].includes(state.status)) {
        view.decodedReject?.(new Error(state.error || tr('投屏已停止')));
        const running = recordings.list({ deviceId: state.deviceId }).some(item => ACTIVE_RECORDINGS.has(item.status));
        if (running) void recordings.stop({ deviceId: state.deviceId });
      }
    }
  });
  const requestRecord = (input, action) => {
    const view = forSession(input.streamId);
    if (!view || view.window.isDestroyed()) return Promise.resolve({ success: false, error: tr('投屏窗口不可用，录像未完成。') });
    const commandId = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => { recordRequests.delete(commandId); resolve({ success: false, error: tr('等待主机录像编码器响应超时。') }); }, 20000);
      recordRequests.set(commandId, { view, resolve, timer, id: input.id });
      send(view, 'record-command', { commandId, action, id: input.id, streamId: input.streamId });
    });
  };
  const recordings = createHarmonyRecordingService({
    directory: app.getPath('userData'),
    getOutputDirectory: async () => {
      let settings = {};
      try { settings = JSON.parse(await fs.promises.readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return typeof settings.screenRecordPath === 'string' && settings.screenRecordPath.trim() ? settings.screenRecordPath : path.join(app.getPath('userData'), 'screenrecord');
    },
    ensureStream: deviceId => openWindow(deviceId),
    beginRendererRecording: request => requestRecord(request, 'start'),
    endRendererRecording: request => requestRecord(request, 'stop'),
    onSaved: input => require('./device-media.cjs').recordMedia(input),
    broadcast: () => {
      const value = { sessions: currentRecordings() };
      for (const view of views.values()) send(view, 'record-state', value);
      for (const listener of recordingListeners) listener(value);
    }
  });
  async function openWindow(deviceId) {
    applicationLog.record({ source: 'media', event: 'opening' });
    let ref;
    try { ref = resolveDeviceRef(deviceId); if (ref.transport !== 'hdc') throw new Error(); }
    catch { return { success: false, error: tr('请选择已连接且获授权的鸿蒙设备。') }; }
    const existing = views.get(deviceId);
    if (existing && !existing.window.isDestroyed()) {
      if (existing.ref.generation !== ref.generation || existing.ref.targetKey !== ref.targetKey) {
        return { success: false, error: tr('旧投屏窗口绑定的设备连接已变化，请关闭旧窗口后重新打开。') };
      }
      existing.window.show(); existing.window.focus();
      const state = streams.get(existing.sessionId);
      if (state && ['stopped', 'failed', 'stopping'].includes(state.status)) return { success: false, error: tr('请关闭已结束的投屏窗口后重新打开。') };
      return existing.opening;
    }
    const window = new BrowserWindow({ width: 980, height: 820, minWidth: 540, minHeight: 420,
      title: mediaLabels().title, backgroundColor: '#15191e', autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, '../harmony-media-preload.cjs'), nodeIntegration: false,
        contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    const view = { deviceId, ref, window, ordinal: ++viewCounter, sessionId: '', rendererReady: false, sequence: 0, inFlight: new Set(), inputBusy: false, allowClose: false };
    let readyResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    view.readyResolve = readyResolve;
    const decoded = new Promise((resolve, reject) => { view.decodedResolve = resolve; view.decodedReject = reject; });
    // An early close is expected; opening() also awaits the same rejection.
    decoded.catch(() => {});
    views.set(deviceId, view);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('render-process-gone', () => { if (view.sessionId) void streams.stop(view.sessionId); view.decodedReject(new Error(tr('投屏窗口进程已结束。'))); });
    window.on('close', event => {
      if (view.allowClose) return;
      event.preventDefault();
      if (view.closing) return;
      view.closing = (async () => {
        const hasRecording = recordings.list({ deviceId }).some(item => ACTIVE_RECORDINGS.has(item.status));
        if (hasRecording) {
          const result = await recordings.stop({ deviceId });
          if (!result.success && !window.isDestroyed()) {
            const response = await require('./app-message-dialog.cjs').ask({ type: 'warning', title: tr('录像尚未完整保存'),
              message: tr('可返回窗口重试，或保留已有文件并关闭投屏。'), buttons: [tr('返回'), tr('保留文件并关闭')], defaultId: 0, cancelId: 0 });
            if (response.response !== 1) return;
          }
        }
        if (view.sessionId) await streams.stop(view.sessionId);
        view.allowClose = true;
        if (!window.isDestroyed()) window.close();
      })().finally(() => { view.closing = null; });
    });
    window.on('closed', () => {
      if (views.get(deviceId) === view) views.delete(deviceId);
      view.decodedReject(new Error(tr('投屏窗口已关闭。')));
      if (view.sessionId) void streams.stop(view.sessionId);
      for (const [id, pending] of recordRequests) if (pending.view === view) {
        clearTimeout(pending.timer); pending.resolve({ success: false, error: tr('投屏窗口已关闭，录像片段已保留。') }); recordRequests.delete(id);
      }
    });
    view.opening = (async () => {
      let readyTimer, decodedTimer;
      try {
        await window.loadFile(path.join(__dirname, '../harmony-media.html'));
        await Promise.race([ready, new Promise((_, reject) => { readyTimer = setTimeout(() => reject(new Error(tr('投屏界面未能准备就绪。'))), 15000); })]);
        if (window.isDestroyed()) throw new Error(tr('投屏窗口已关闭。'));
        const current = resolveDeviceRef(deviceId);
        if (current.generation !== view.ref.generation || current.targetKey !== view.ref.targetKey) throw new Error(tr('窗口准备期间设备连接已变化，未部署媒体组件。'));
        const result = await streams.start(deviceId);
        if (!result.success) throw new Error(result.error);
        view.sessionId = result.session.id;
        await Promise.race([decoded, new Promise((_, reject) => { decodedTimer = setTimeout(() => {
          applicationLog.record({ ...view.decoderDiagnostic, source: 'media', event: 'first-frame-timeout', errorCode: 'TIMEOUT' });
          reject(new Error(firstFrameFailure(view.decoderDiagnostic)));
        }, 15000); })]);
        return { success: true, session: streams.get(view.sessionId) };
      } catch (error) {
        applicationLog.record({ source: 'media', event: 'transport-error', ...classifyApplicationError(error) });
        if (view.sessionId) await streams.stop(view.sessionId);
        send(view, 'state', { id: view.sessionId, deviceId, status: 'failed', error: error.message || tr('原生投屏未能启动。') });
        return { success: false, error: error.message || tr('原生投屏未能启动。') };
      } finally { clearTimeout(readyTimer); clearTimeout(decodedTimer); }
    })();
    return view.opening;
  }
  function authorized(event) {
    const view = [...views.values()].find(item => !item.window.isDestroyed() && item.window.webContents === event.sender);
    if (!view || !event.senderFrame || !event.sender.mainFrame || event.senderFrame !== event.sender.mainFrame) throw new Error(tr('请在所属投屏窗口执行此操作。'));
    return view;
  }
  function ownRecording(view, id) {
    const record = recordings.list().find(item => item.id === id);
    if (!record || record.deviceId !== view.deviceId || record.streamId !== view.sessionId) throw new Error(tr('录像不属于当前投屏窗口。'));
    return record;
  }
  const input = createHarmonyMediaInput({ getStream: id => streams.get(id), resolveDevice: resolveDeviceRef,
    performInput: performHarmonyInput, record: event => applicationLog.record(event) });
  const localeOff = onLocaleChanged(() => {
    const labels = mediaLabels();
    for (const view of views.values()) {
      if (view.window.isDestroyed()) continue;
      view.window.setTitle(labels.title + ' · ' + view.deviceId);
      send(view, 'locale', labels);
      const state = streams.get(view.sessionId);
      if (state) send(view, 'state', { ...state, error: state.error ? tr(state.error) : '' });
      send(view, 'record-state', { sessions: currentRecordings() });
    }
  });
  singleton = { streams, recordings, openWindow, authorized, ownRecording, input, recordRequests, recordingListeners, views, send,
    async shutdownAll() {
      const saved = await recordings.stopAllRecordings();
      const closed = await streams.shutdownAll();
      for (const view of views.values()) { view.allowClose = true; if (!view.window.isDestroyed()) view.window.close(); }
      return { success: saved.success && closed.success, failed: [...saved.failed, ...closed.failed] };
    },
    dispose: () => localeOff?.() };
  return singleton;
}
let registered = false;
function register(ipcMain) {
  if (registered) return; registered = true;
  const manager = getManager();
  const handle = (name, action) => ipcMain.handle('harmony-media:' + name, async (event, args) => {
    try { return await action(manager.authorized(event), args || {}); }
    catch (error) { return { success: false, error: error.message || tr('媒体窗口操作未完成。') }; }
  });
  handle('init', view => ({ success: true, labels: mediaLabels(), deviceId: view.deviceId, session: manager.streams.get(view.sessionId) }));
  handle('ready', view => { view.rendererReady = true; view.readyResolve(); return { success: true }; });
  handle('diagnostic', (view, args) => {
    if (!view.rendererReady || !view.sessionId) return { success: false };
    applicationLog.record({ ...normalizeDecoderEvent(args), source: 'media' });
    return { success: true };
  });
  handle('ack', (view, args) => {
    if (args.sessionId !== view.sessionId || !Number.isInteger(args.sequence) || args.sequence < 0 || args.sequence >= view.sequence) return { success: false };
    if (args.diagnostic !== undefined) {
      const diagnostic = normalizeDecoderDiagnostic(args.diagnostic);
      if (!view.decoderDiagnostic || diagnostic.received >= view.decoderDiagnostic.received) view.decoderDiagnostic = diagnostic;
      if (diagnostic.stage !== view.lastLogStage) {
        view.lastLogStage = diagnostic.stage;
        applicationLog.record({ ...diagnostic, source: 'media', event: 'decode-summary' });
      }
      if (diagnostic.stage === 'decoder-error' && !view.decoded) view.decodedReject(new Error(tr('当前主机无法解码此视频流。')));
    }
    view.inFlight.delete(args.sequence);
    if (args.decoded === true) { manager.streams.confirmDecoded?.(view.sessionId); view.decoded = true; view.decodedResolve(); }
    return { success: true };
  });
  handle('stop', async view => {
    const active = manager.recordings.list({ deviceId: view.deviceId }).some(item => ACTIVE_RECORDINGS.has(item.status));
    if (active) await manager.recordings.stop({ deviceId: view.deviceId });
    return manager.streams.stop(view.sessionId);
  });
  handle('close', view => { view.window.close(); return { success: true }; });
  handle('input', (view, args) => manager.input(view, args));
  handle('record-start', (view, args) => manager.recordings.start({ deviceId: view.deviceId, withLogs: args.withLogs === true }));
  handle('record-stop', view => manager.recordings.stop({ deviceId: view.deviceId }));
  handle('record-chunk', (view, args) => { manager.ownRecording(view, args.id); return manager.recordings.append(args); });
  handle('record-end', (view, args) => { manager.ownRecording(view, args.id); return manager.recordings.end(args); });
  handle('record-response', (view, args) => {
    const pending = manager.recordRequests.get(args.commandId);
    if (!pending || pending.view !== view) return { success: false };
    manager.recordRequests.delete(args.commandId); clearTimeout(pending.timer);
    pending.resolve({ success: args.success === true, error: args.success === true ? '' : tr('主机录像编码或收尾未完成，已有文件保留。') });
    return { success: true };
  });
}
module.exports = { register, openWindow: deviceId => getManager().openWindow(deviceId),
  getRecordingService: () => getManager().recordings,
  onRecordingState: listener => { getManager().recordingListeners.add(listener); return () => getManager().recordingListeners.delete(listener); },
  hasActiveStreams: () => Boolean(singleton?.streams.hasActiveStreams()),
  shutdownAll: () => singleton ? singleton.shutdownAll() : Promise.resolve({ success: true, failed: [] }) };
