const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { tr } = require('./localization.cjs');
const { createReproductionStore } = require('./reproduction-store.cjs');

const ACTIVE = new Set(['starting', 'recording', 'stopping']);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const clean = (value, max) => String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max);
function normalizeSelection(value) {
  if (!plain(value) || Object.keys(value).some(key => !['video', 'logs', 'performance', 'serial', 'ssh'].includes(key))) throw new Error(tr('请选择有效的复现采集来源。'));
  const result = { video: value.video === true, logs: value.logs === true, performance: value.performance === true, serial: [], ssh: [] };
  for (const key of ['video', 'logs', 'performance']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error(tr('请选择有效的复现采集来源。'));
  for (const [kind, fields, max] of [['serial', ['workspace', 'sessionId'], 2], ['ssh', ['sessionId', 'terminalId'], 4]]) {
    if (!Array.isArray(value[kind] || []) || (value[kind] || []).length > max) throw new Error(tr('请选择有效的复现采集来源。'));
    for (const ref of value[kind] || []) {
      if (!plain(ref) || Object.keys(ref).length !== fields.length || fields.some(key => typeof ref[key] !== 'string' || !ref[key] || ref[key].length > 180)) throw new Error(tr('请选择有效的复现采集来源。'));
      if (kind === 'serial' && !['rs232', 'terminal'].includes(ref.workspace)) throw new Error(tr('请选择有效的复现采集来源。'));
      result[kind].push(Object.fromEntries(fields.map(key => [key, ref[key]])));
    }
    if (new Set(result[kind].map(ref => JSON.stringify(ref))).size !== result[kind].length) throw new Error(tr('请选择有效的复现采集来源。'));
  }
  if (!result.video && !result.logs && !result.performance && !result.serial.length && !result.ssh.length) throw new Error(tr('至少勾选一个采集来源。'));
  return result;
}

function createReproductionService({ directory, recording, startLog, samplePerformance, sourceSnapshots, verifyDevice,
  broadcast = () => {}, now = Date.now, monotonic = () => performance.now(), intervalMs = 1000,
  setTimer = setTimeout, clearTimer = clearTimeout, store = createReproductionStore(directory) }) {
  let active = null, initializing, starting = false, pendingStart = null, closed = false;
  const listeners = new Set();
  const unsaved = new Map();
  const visible = session => JSON.parse(JSON.stringify(session));
  async function initialize() {
    if (!initializing) initializing = (async () => {
      const existing = await store.list();
      for (const session of existing.sessions) if (ACTIVE.has(session.status)) {
        session.status = 'interrupted'; session.endedAt = now();
        session.warnings = [...session.warnings.slice(0, 29), tr('上次采集未正常结束，已保留已有证据，不会自动恢复采集。')];
        await store.save(session);
      }
    })().catch(error => { initializing = null; throw error; });
    return initializing;
  }
  async function notify(runtime) {
    await store.save(runtime.session);
    publish(runtime.session);
  }
  function publish(value) {
    const session = visible(value);
    try { broadcast({ session }); } catch { /* Persisted evidence does not depend on a renderer. */ }
    for (const listener of listeners) { try { listener(session); } catch { /* Isolate status subscribers. */ } }
  }
  function warning(runtime, message) {
    const value = clean(message, 2000);
    if (value && !runtime.session.warnings.includes(value) && runtime.session.warnings.length < 30) runtime.session.warnings.push(value);
  }
  function file(runtime, name, label, data) {
    let item = runtime.session.files.find(item => item.name === name);
    if (!item) { item = { name, label, bytes: 0, truncated: false }; runtime.session.files.push(item); }
    if (Number.isSafeInteger(data?.bytes) && data.bytes >= 0) item.bytes = data.bytes;
    item.truncated ||= data?.truncated === true;
    if (data?.error) warning(runtime, data.error);
    return item;
  }
  async function sample(runtime, initial = false, final = false) {
    if (active !== runtime || (closed || runtime.stopping) && !final) return;
    const sources = await sourceSnapshots(runtime.session.selection, runtime.cursors, false);
    if (active !== runtime || runtime.stopping && !final) return;
    runtime.cursors = sources.cursors;
    for (const item of sources.items) {
      if (item.warning) warning(runtime, item.warning);
      if (!item.text) continue;
      const result = await store.append(runtime.session.id, item.name, { at: now(), sourceTime: 'host-receipt', text: item.text }, 8 * 1024 * 1024);
      file(runtime, item.name, item.label, { ...result, truncated: result.truncated || item.truncated });
      if (result.truncated) warning(runtime, tr('部分来源达到采集上限，已保留已有内容并标记不完整。'));
    }
    if (!final && !runtime.stopping && runtime.session.selection.performance && (initial || now() - runtime.lastPerformance >= 5000)) {
      runtime.lastPerformance = now();
      try {
        const snapshot = await samplePerformance(runtime.session.deviceId);
        if (active !== runtime || runtime.stopping) return;
        const result = await store.append(runtime.session.id, 'performance.jsonl', { at: now(), snapshot }, 2 * 1024 * 1024);
        file(runtime, 'performance.jsonl', tr('性能采样'), result);
      } catch (error) { warning(runtime, tr('性能采样未完成：{0}', { 0: clean(error.message, 500) })); }
    }
    if (runtime.logger) file(runtime, 'device.log', tr('设备日志'), runtime.logger.info());
    await notify(runtime);
  }
  function schedule(runtime) {
    runtime.timer = setTimer(() => {
      if (closed || active !== runtime || runtime.stopping) return;
      if (monotonic() - runtime.monotonicStart >= runtime.session.durationLimitMs) { void stop({ id: runtime.session.id }).catch(() => {}); return; }
      runtime.sampling = sample(runtime).catch(error => warning(runtime, error.message)).finally(() => {
        runtime.sampling = null;
        if (!closed && active === runtime && !runtime.stopping) schedule(runtime);
      });
    }, intervalMs);
    runtime.timer?.unref?.();
  }
  async function start(args = {}) {
    if (closed || starting || active) return { ok: false, error: tr('已有复现采集正在进行，请先结束当前会话。') };
    starting = true;
    let resolveStart;
    const startToken = { cancelled: false, done: new Promise(resolve => { resolveStart = resolve; }) };
    pendingStart = startToken;
    const assertStarting = () => { if (closed || startToken.cancelled) throw Object.assign(new Error(tr('操作已取消')), { code: 'CANCELLED' }); };
    try {
      await initialize();
      assertStarting();
      const selection = normalizeSelection(args.selection);
      if (typeof args.deviceId !== 'string' || !/^[A-Za-z0-9_.:[\]-]{1,160}$/.test(args.deviceId)
        || typeof args.title !== 'string' || !args.title.trim() || args.title.length > 100
        || !Number.isInteger(args.durationMs) || args.durationMs < 10000 || args.durationMs > 300000) throw new Error(tr('复现会话的名称、设备或时长无效。'));
      await verifyDevice(args.deviceId);
      assertStarting();
      const initialSources = await sourceSnapshots(selection, {}, true);
      assertStarting();
      if (initialSources.items.some(item => item.unavailable)) throw new Error(tr('所选串口或 SSH 会话已变化，请重新选择。'));
      const session = { schemaVersion: 1, id: randomUUID(), title: clean(args.title, 100), deviceId: args.deviceId,
        status: 'starting', selection, startedAt: now(), durationLimitMs: args.durationMs, files: [], markers: [], warnings: [], clockBasis: 'host-monotonic' };
      await store.create(session);
      let resolveLaunched;
      const runtime = { session, startToken, launched: new Promise(resolve => { resolveLaunched = resolve; }), cursors: initialSources.cursors,
        monotonicStart: monotonic(), lastPerformance: 0, sampling: null, timer: null, stopping: false };
      active = runtime;
      try {
        await notify(runtime);
        assertStarting();
        if (selection.video) {
          runtime.videoMonotonicStart = monotonic();
          const result = await recording.start({ deviceId: session.deviceId, withLogs: false });
          if (!result.success) throw new Error(result.error || tr('复现录屏未能启动。'));
          runtime.recordingId = result.session.id; session.recordingId = runtime.recordingId; session.videoStartedAt = result.session.startedAt;
          assertStarting();
        }
        if (selection.logs) {
          const logPath = await store.filePath(session.id, 'device.log');
          assertStarting();
          runtime.logger = await startLog({ deviceId: session.deviceId, videoPath: logPath.replace(/\.log$/, '.mp4') });
          assertStarting();
        }
        session.status = 'recording';
        await sample(runtime, true); assertStarting(); resolveLaunched(); schedule(runtime);
        return { ok: true, session: visible(session) };
      } catch (error) {
        warning(runtime, error.message);
        resolveLaunched();
        await stop({ id: session.id });
        return { ok: false, error: clean(error.message, 1000), session: visible(session) };
      }
    } catch (error) { return { ok: false, error: clean(error.message, 1000) }; }
    finally { starting = false; resolveStart(); if (pendingStart === startToken) pendingStart = null; }
  }
  async function mark({ id, note } = {}) {
    const runtime = active;
    if (!runtime || runtime.session.id !== id || runtime.stopping || runtime.session.status !== 'recording') return { ok: false, error: tr('当前会话没有正在采集。') };
    if (typeof note !== 'string' || !note.trim() || note.length > 240 || runtime.session.markers.length >= 100) return { ok: false, error: tr('标记内容无效或已达到 100 条上限。') };
    const at = now();
    const marker = { id: randomUUID(), note: clean(note.trim(), 240), at, offsetMs: Math.max(0, monotonic() - runtime.monotonicStart),
      videoOffsetMs: Number.isFinite(runtime.videoMonotonicStart) ? Math.max(0, monotonic() - runtime.videoMonotonicStart) : null };
    runtime.session.markers.push(marker);
    await notify(runtime); return { ok: true, marker, session: visible(runtime.session) };
  }
  async function stop({ id } = {}) {
    const runtime = active;
    if (!runtime || runtime.session.id !== id) return { ok: false, error: tr('当前会话没有正在采集。') };
    if (runtime.stopPromise) return runtime.stopPromise;
    runtime.stopping = true; runtime.startToken.cancelled = true; clearTimer(runtime.timer);
    runtime.stopPromise = (async () => {
      await runtime.launched;
      runtime.session.status = 'stopping';
      try { await notify(runtime); } catch (error) { warning(runtime, error.message); }
      await runtime.sampling?.catch(error => warning(runtime, error.message));
      try { await sample(runtime, false, true); } catch (error) { warning(runtime, error.message); }
      if (runtime.logger) {
        try { file(runtime, 'device.log', tr('设备日志'), await runtime.logger.stop()); }
        catch (error) { warning(runtime, error.message); }
      }
      if (runtime.recordingId) {
        try {
          const result = await recording.stopOwned({ id: runtime.recordingId });
          if (!result.success) throw new Error(result.error || tr('录屏尚未保存，请在设备录屏记录中恢复。'));
          const target = await store.filePath(id, 'video.mp4');
          if (result.path !== target) await fs.copyFile(result.path, target, require('node:fs').constants.COPYFILE_EXCL);
          file(runtime, 'video.mp4', tr('复现视频'), { bytes: (await fs.stat(target)).size });
          runtime.session.videoDurationMs = result.session?.durationMs || 0;
        } catch (error) { warning(runtime, error.message); }
      }
      runtime.session.endedAt = now();
      runtime.session.status = runtime.session.warnings.length || runtime.session.files.some(item => item.truncated) ? 'partial' : 'completed';
      try { await notify(runtime); }
      catch (error) {
        runtime.session.status = 'partial'; warning(runtime, error.message); runtime.session.unsaved = true;
        unsaved.set(id, visible(runtime.session)); publish(runtime.session);
        return { ok: false, error: clean(error.message, 1000), session: visible(runtime.session) };
      }
      return { ok: true, session: visible(runtime.session) };
    })().finally(() => { if (active === runtime) active = null; });
    return runtime.stopPromise;
  }
  async function list() {
    await initialize();
    let result;
    try { result = await store.list(); } catch (error) { if (!unsaved.size) throw error; result = { sessions: [], unreadable: 1 }; }
    return { ok: true, ...result, sessions: [...unsaved.values()].map(visible).concat(result.sessions.filter(item => !unsaved.has(item.id))), activeId: active?.session.id || '' };
  }
  async function load(id) { await initialize(); return unsaved.has(id) ? visible(unsaved.get(id)) : store.load(id); }
  async function retrySave({ id } = {}) {
    const record = unsaved.get(id);
    if (!record) return { ok: false, error: tr('没有待重试保存的复现记录。') };
    const session = visible(record); delete session.unsaved;
    try { await store.save(session); unsaved.delete(id); publish(session); return { ok: true, session }; }
    catch (error) { return { ok: false, error: clean(error.message, 1000), session: visible(record) }; }
  }
  async function stopCurrent() {
    const pending = pendingStart;
    if (pending) pending.cancelled = true;
    let result = active ? await stop({ id: active.session.id }) : { ok: true };
    await pending?.done;
    for (const id of unsaved.keys()) { const saved = await retrySave({ id }); if (!saved.ok) result = saved; }
    if (!unsaved.size && result?.session?.unsaved) result = { ok: true, session: await load(result.session.id) };
    return result;
  }
  async function cleanup() { closed = true; return stopCurrent(); }
  return { start, mark, stop, stopCurrent, list, load, retrySave, cleanup, store, hasActive: () => Boolean(active || starting), hasUnpersisted: () => unsaved.size > 0,
    onChange: callback => { listeners.add(callback); return () => listeners.delete(callback); } };
}
module.exports = { createReproductionService, normalizeSelection };
