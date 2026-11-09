const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { tr } = require('./localization.cjs');
const { UUID } = require('./harmony-media-protocol.cjs');

const ACTIVE = new Set(['starting', 'recording', 'stopping', 'saving']);
const MAX_CHUNK = 8 * 1024 * 1024;
const MAX_RECORDING = 2 * 1024 * 1024 * 1024;
const MAX_SESSIONS = 100;
const localName = session => 'harmony-record_' + new Date(session.startedAt).toISOString().replace(/[:.]/g, '-') + '_' + session.id + '.webm';

async function validateWebmFile(filename) {
  const stat = await fs.promises.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 64 || stat.size > MAX_RECORDING) throw new Error(tr('WebM 录像文件无效或超出大小限制。'));
  const handle = await fs.promises.open(filename, 'r');
  try {
    const header = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
    await handle.read(header, 0, header.length, 0);
    if (!header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) || !header.includes(Buffer.from('webm'))
      || !header.includes(Buffer.from([0x18, 0x53, 0x80, 0x67])) || !header.includes(Buffer.from([0x1f, 0x43, 0xb6, 0x75]))) {
      throw new Error(tr('录像容器不完整，未作为已保存视频发布。'));
    }
    return { bytes: stat.size, format: 'webm' };
  } finally { await handle.close(); }
}
async function fileDigest(filename) {
  const before = await fs.promises.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_RECORDING) throw new Error(tr('录像恢复文件类型或大小无效。'));
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of fs.createReadStream(filename)) {
    bytes += chunk.length;
    if (bytes > MAX_RECORDING) throw new Error(tr('录像恢复文件超过大小限制。'));
    hash.update(chunk);
  }
  const after = await fs.promises.lstat(filename);
  if (before.size !== bytes || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.isSymbolicLink()) {
    throw new Error(tr('录像文件在恢复期间发生变化，未发布结果。'));
  }
  return hash.digest('hex');
}

async function publishOwnedCopy(session) {
  await validateWebmFile(session.partPath);
  try { await fs.promises.copyFile(session.partPath, session.localPath, fs.constants.COPYFILE_EXCL); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await validateWebmFile(session.localPath);
    const [part, final] = await Promise.all([fileDigest(session.partPath), fileDigest(session.localPath)]);
    if (part !== final) throw new Error(tr('录像目标文件已存在且内容不同，未覆盖该文件。'));
  }
}

function createHarmonyRecordingService({
  directory, getOutputDirectory = async () => path.join(directory, 'screenrecord'),
  ensureStream, beginRendererRecording, endRendererRecording, onSaved = async () => null,
  logCaptureFactory = args => require('./recording-log.cjs').startRecordingLog(args),
  broadcast = () => {}, now = Date.now
}) {
  const filename = path.join(directory, 'harmony-recording-sessions.json');
  const sessions = new Map(), runtimes = new Map(), starting = new Set();
  let reservedSlots = 0;
  let initializationError = '';
  const publicSession = session => {
    const { localPath, partPath, complete, indexed, ...value } = session;
    return { ...value, format: 'webm', ...(session.status === 'saved' ? { path: localPath } : {}) };
  };
  const list = ({ deviceId } = {}) => [...sessions.values()].filter(item => !deviceId || item.deviceId === deviceId)
    .sort((left, right) => right.startedAt - left.startedAt).map(publicSession);
  const notify = () => { try { broadcast({ sessions: list() }); } catch { /* Keep recovery state if a window closes. */ } };
  function persist() {
    const history = [...sessions.values()].filter(item => item.status === 'saved').sort((a, b) => b.startedAt - a.startedAt);
    const unsaved = sessions.size - history.length;
    if (unsaved > MAX_SESSIONS) throw new Error(tr('未保存的录像已达上限，请先恢复保存后再开始新录像。'));
    for (const item of history.slice(Math.min(60, MAX_SESSIONS - unsaved))) { sessions.delete(item.id); runtimes.delete(item.id); }
    fs.mkdirSync(directory, { recursive: true });
    const temporary = filename + '.' + randomUUID() + '.tmp';
    try { fs.writeFileSync(temporary, JSON.stringify({ version: 1, sessions: [...sessions.values()] }), { flag: 'wx' }); fs.renameSync(temporary, filename); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  function update(session, patch) { Object.assign(session, patch); persist(); notify(); }
  function failed(session, error) {
    Object.assign(session, { status: 'needs-save', error: error.message || String(error) });
    try { persist(); } catch { session.error = tr('录像与恢复记录尚未完整保存，请保留当前窗口。'); }
    notify(); return { success: false, error: session.error, session: publicSession(session) };
  }
  function restore() {
    if (!fs.existsSync(filename)) return;
    const state = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (state.version !== 1 || !Array.isArray(state.sessions) || state.sessions.length > MAX_SESSIONS) throw new Error();
    for (const item of state.sessions) {
      if (!UUID.test(item?.id || '') || !String(item.deviceId || '').startsWith('hdc:') || !Number.isFinite(item.startedAt)
        || !path.isAbsolute(item.localPath || '') || path.basename(item.localPath) !== localName(item)
        || item.partPath !== item.localPath + '.part' || ![...ACTIVE, 'needs-save', 'saved'].includes(item.status)
        || item.logPath && item.logPath !== item.localPath.replace(/\.webm$/i, '.log')) throw new Error();
      if (ACTIVE.has(item.status)) { item.status = 'needs-save'; item.error = tr('上次鸿蒙录像未正常结束，保留的片段尚未确认完整。'); }
      sessions.set(item.id, item);
    }
  }
  try { restore(); } catch { sessions.clear(); initializationError = tr('鸿蒙录像恢复记录无效，原记录已保留。'); }

  async function startImpl({ deviceId, withLogs = false } = {}, consumeSlot) {
    if (initializationError) return { success: false, error: initializationError };
    const pending = [...sessions.values()].find(item => item.deviceId === deviceId && ACTIVE.has(item.status));
    if (pending) return { success: false, error: tr('此设备已有正在进行的录像，请先停止并保存。'), session: publicSession(pending) };
    const stream = await ensureStream(deviceId);
    if (!stream?.success || stream.session?.deviceId !== deviceId) return { success: false, error: stream?.error || tr('原生投屏尚未就绪，未开始录像。') };
    const session = { id: randomUUID(), streamId: stream.session.id, deviceId, startedAt: now(), status: 'starting', withLogs: withLogs === true, complete: false, format: 'webm' };
    const runtime = { pending: Promise.resolve(), sequence: 0, bytes: 0 };
    try {
      const outputDirectory = path.resolve(await getOutputDirectory());
      await fs.promises.mkdir(outputDirectory, { recursive: true });
      session.localPath = path.join(outputDirectory, localName(session)); session.partPath = session.localPath + '.part';
      runtime.file = await fs.promises.open(session.partPath, 'wx');
      consumeSlot(); sessions.set(session.id, session); runtimes.set(session.id, runtime); update(session, {});
      const result = await beginRendererRecording({ id: session.id, streamId: session.streamId });
      if (!result?.success) throw new Error(result?.error || tr('主机视频编码器未能开始录像。'));
      update(session, { status: 'recording' });
      if (withLogs) {
        runtime.logPromise = Promise.resolve(logCaptureFactory({ deviceId, videoPath: session.localPath,
          onState: log => { if (sessions.has(session.id)) update(session, { logTruncated: Boolean(log.truncated), logError: log.error || undefined }); } }))
          .then(log => { runtime.log = log; const info = log.info(); update(session, { logPath: info.path, logTruncated: Boolean(info.truncated), logError: info.error || undefined }); })
          .catch(() => update(session, { logError: tr('关联日志未能启动，视频录像仍可继续。') }));
      }
      return { success: true, session: publicSession(session) };
    } catch (error) {
      await runtime.pending.catch(() => {});
      await runtime.file?.close().catch(() => {}); runtime.file = null;
      if (!sessions.has(session.id)) return { success: false, error: error.message };
      if (runtime.bytes === 0 && session.status === 'starting') {
        await fs.promises.unlink(session.partPath).catch(() => {});
        sessions.delete(session.id); runtimes.delete(session.id);
        try { persist(); } catch { /* No captured data is discarded; preserve earlier metadata if unwritable. */ }
        notify(); return { success: false, error: error.message };
      }
      return failed(session, error);
    }
  }
  async function start(args = {}) {
    if (typeof args.deviceId !== 'string' || !args.deviceId.startsWith('hdc:')) return { success: false, error: tr('请选择鸿蒙设备。') };
    if (starting.has(args.deviceId)) return { success: false, error: tr('此设备正在准备录像，请稍候。') };
    if ([...sessions.values()].filter(item => item.status !== 'saved').length + reservedSlots >= MAX_SESSIONS) {
      return { success: false, error: tr('未保存的录像已达上限，请先恢复保存后再开始新录像。') };
    }
    reservedSlots++;
    let reserved = true;
    const consumeSlot = () => { if (reserved) { reserved = false; reservedSlots--; } };
    starting.add(args.deviceId);
    try { return await startImpl(args, consumeSlot); }
    catch { return { success: false, error: tr('原生投屏尚未就绪，未开始录像。') }; }
    finally { consumeSlot(); starting.delete(args.deviceId); }
  }
  async function append({ id, sequence, bytes }) {
    const session = sessions.get(id), runtime = runtimes.get(id);
    const length = bytes?.byteLength;
    if (!session || !runtime?.file || !ACTIVE.has(session.status) || !Number.isInteger(sequence) || sequence !== runtime.sequence
      || !Number.isSafeInteger(length) || length <= 0 || length > MAX_CHUNK || runtime.bytes + length > MAX_RECORDING) {
      throw new Error(tr('录像数据块顺序、大小或会话状态无效。'));
    }
    const chunk = Buffer.from(bytes.buffer || bytes, bytes.byteOffset || 0, length);
    runtime.sequence++; runtime.bytes += length;
    runtime.pending = runtime.pending.then(async () => {
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await runtime.file.write(chunk, offset, chunk.length - offset);
        if (bytesWritten <= 0) throw new Error(tr('录像文件写入未完成。'));
        offset += bytesWritten;
      }
    });
    try { await runtime.pending; return { success: true }; }
    catch (error) { failed(session, error); throw error; }
  }
  async function end({ id, mimeType }) {
    const session = sessions.get(id), runtime = runtimes.get(id);
    if (!session || !runtime || !['video/webm', 'video/webm;codecs=vp8', 'video/webm;codecs=vp9'].includes(mimeType)) throw new Error(tr('录像结束信息无效。'));
    if (session.complete) return { success: true };
    await runtime.pending;
    if (runtime.file) { await runtime.file.sync(); await runtime.file.close(); runtime.file = null; }
    update(session, { complete: true, mimeType, endedAt: now(), durationMs: Math.max(0, now() - session.startedAt) });
    return { success: true };
  }
  async function finish(session, retrying = false) {
    if (session.status === 'saved') return { success: true, path: session.localPath, session: publicSession(session) };
    let runtime = runtimes.get(session.id);
    if (!runtime) { runtime = { pending: Promise.resolve() }; runtimes.set(session.id, runtime); }
    if (runtime.finishing) return runtime.finishing;
    const job = (async () => {
      try {
        if (!session.complete && !retrying) {
          update(session, { status: 'stopping' });
          const result = await endRendererRecording({ id: session.id, streamId: session.streamId });
          if (!result?.success || !session.complete) throw new Error(result?.error || tr('录像未正常结束，保留片段但不标记保存成功。'));
        }
        if (!session.complete) throw new Error(tr('录像未正常结束，保留片段但不标记保存成功。'));
        update(session, { status: 'saving' });
        try {
          await runtime?.logPromise;
          if (runtime?.log) {
            const log = await runtime.log.stop(); runtime.log = null;
            Object.assign(session, { logPath: log.path || session.logPath, logTruncated: Boolean(log.truncated), logError: log.error || undefined });
          }
        } catch { session.logError = tr('关联日志未完整结束，已保留可用视频。'); if (runtime) runtime.log = null; }
        if (!session.finalized) {
          await publishOwnedCopy(session);
          update(session, { finalized: true });
        }
        await validateWebmFile(session.localPath);
        const media = await onSaved({ type: 'video', deviceId: session.deviceId, path: session.localPath,
          createdAt: session.startedAt, durationMs: session.durationMs, format: 'webm',
          logPath: session.logPath, logTruncated: session.logTruncated, logError: session.logError });
        update(session, { status: 'saved', path: session.localPath, mediaId: media?.id, savedAt: now(), error: undefined });
        await fs.promises.unlink(session.partPath).catch(() => {});
        return { success: true, path: session.localPath, session: publicSession(session) };
      } catch (error) {
        await runtime?.pending.catch(() => {});
        await runtime?.file?.close().catch(() => {}); if (runtime) runtime.file = null;
        try { await runtime?.logPromise; await runtime?.log?.stop(); if (runtime) runtime.log = null; } catch { /* Preserve original saving error. */ }
        return failed(session, error);
      } finally { if (runtime) runtime.finishing = null; }
    })();
    if (runtime) runtime.finishing = job;
    return job;
  }
  const stopOwned = ({ id }) => {
    if (initializationError) return Promise.resolve({ success: false, error: initializationError });
    const session = sessions.get(id);
    return session ? finish(session) : Promise.resolve({ success: false, error: tr('没有找到指定的鸿蒙录像会话。') });
  };
  const stop = ({ deviceId }) => {
    if (initializationError) return Promise.resolve({ success: false, error: initializationError });
    const session = [...sessions.values()].find(item => item.deviceId === deviceId && ACTIVE.has(item.status));
    return session ? finish(session) : Promise.resolve({ success: false, error: tr('当前设备没有正在进行的鸿蒙录像。') });
  };
  return { start, stop, stopOwned, append, end, list, has: id => sessions.has(id),
    retry: ({ id }) => initializationError ? Promise.resolve({ success: false, error: initializationError })
      : sessions.has(id) ? finish(sessions.get(id), true) : Promise.resolve({ success: false, error: tr('没有找到待恢复的鸿蒙录像。') }),
    hasActiveRecordings: () => [...sessions.values()].some(item => ACTIVE.has(item.status)),
    listUnresolved: () => list().filter(item => ACTIVE.has(item.status) || item.status === 'needs-save'),
    async stopAllRecordings() {
      const results = await Promise.all([...sessions.values()].filter(item => ACTIVE.has(item.status) || item.status === 'needs-save')
        .map(item => finish(item, item.status === 'needs-save')));
      return { success: results.every(result => result.success), failed: results.filter(result => !result.success).map(result => result.session) };
    }
  };
}
module.exports = { createHarmonyRecordingService, validateWebmFile, localName };
