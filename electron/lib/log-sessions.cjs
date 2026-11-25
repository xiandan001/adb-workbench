const { tr } = require('./localization.cjs');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { runSessionJob, cleanupSessionJobs } = require('./log-session-jobs.cjs');

const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_ENTRIES = 50000;
const MAX_EVIDENCE_ENTRIES = 100000;
const MAX_MARKERS = 500;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const liveOperations = new Set();
const failedTemporaryCleanup = new Map();
let cleanupFlight = null;
let quitting = false;
async function removePrivateTemporary(file, directory = false) {
  try { if (directory) await fs.promises.rm(file, { recursive: true, force: true }); else await fs.promises.unlink(file); failedTemporaryCleanup.delete(file); }
  catch (failure) {
    if (failure.code === 'ENOENT') { failedTemporaryCleanup.delete(file); return; }
    failedTemporaryCleanup.set(file, directory);
    throw Object.assign(new Error(tr('会话临时文件清理失败，请重试后再退出。')), { code: 'LOG_SESSION_CLEANUP_FAILED', cause: failure });
  }
}
function cleanup() {
  if (cleanupFlight) return cleanupFlight;
  const flight = (async () => {
    const operations = [...liveOperations];
    for (const operation of operations) operation.controller.abort();
    await cleanupSessionJobs();
    await Promise.allSettled(operations.filter(operation => operation.started && operation.awaitCleanup).map(operation => operation.completion));
    for (const [file, directory] of [...failedTemporaryCleanup]) await removePrivateTemporary(file, directory);
  })().finally(() => { if (cleanupFlight === flight) cleanupFlight = null; });
  cleanupFlight = flight; return flight;
}
async function prepareQuit() { quitting = true; await cleanup(); }
function resumeAfterQuit() { quitting = false; }
function chooseUntilCancelled(choosing, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); resolve({ canceled: true }); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(choosing).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, failure => { signal.removeEventListener('abort', abort); reject(failure); });
    if (signal.aborted) abort();
  });
}

function normalizeSessionTimeRange(value = { kind: 'all' }) {
  const exact = keys => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  if (exact(['kind']) && value.kind === 'all') return { kind: 'all' };
  if (exact(['kind', 'durationMs', 'basis']) && value.kind === 'recent' && [30000, 300000].includes(value.durationMs) && ['source', 'received'].includes(value.basis)) return { ...value };
  if (exact(['kind', 'entryId', 'windowMs', 'basis']) && value.kind === 'around' && [5000, 30000].includes(value.windowMs) && ['source', 'received'].includes(value.basis)
    && typeof value.entryId === 'string' && value.entryId.length > 0 && value.entryId.length <= 200 && ![...value.entryId].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return { ...value };
  throw new Error(tr('会话时间范围无效，未保存或恢复。'));
}

function normalizeEntries(entries, limit, withReferences = false) {
  if (!Array.isArray(entries) || entries.length > limit) throw new Error(tr("日志数量无效或超过 {0} 条限制；未保存或截断数据", { 0: limit.toLocaleString() }));
  const seen = new Set();
  return entries.map(entry => {
    if (!entry || typeof entry.id !== 'string' || typeof entry.raw !== 'string') throw new Error(tr("日志条目格式无效"));
    const next = { id: entry.id, raw: entry.raw };
    for (const key of ['source', 'message', 'pkg', 'tag', 'level', 'deviceId', 'platform', 'logFormat', 'domain', 'processName', 'clockBasis', 'timestamp']) {
      if (typeof entry[key] === 'string') next[key] = entry[key];
    }
    for (const key of ['ts', 'pid', 'tid', 'receivedAt']) {
      if (Number.isFinite(entry[key])) next[key] = entry[key];
    }
    if (typeof entry.timeKnown === 'boolean') next.timeKnown = entry.timeKnown;
    if (withReferences) {
      if (!/^L[1-9]\d*$/.test(entry.ref) || seen.has(entry.ref)) throw new Error(tr("证据编号无效或重复"));
      seen.add(entry.ref);
      next.ref = entry.ref;
      if (entry.locatableInSession === true) next.locatableInSession = true;
    }
    return next;
  });
}

function normalizeSession(input) {
  if (!input || !['realtime', 'file'].includes(input.source)) throw new Error(tr("会话来源无效"));
  const name = String(input.name || '').trim();
  if (!name || name.length > 80) throw new Error(tr("会话名称需为 1–80 字"));
  if (typeof input.deviceId === 'string' && input.deviceId.length > 300 || typeof input.sourceLabel === 'string' && input.sourceLabel.length > 4096) throw new Error(tr('会话来源信息过长，未保存。'));
  const filter = {};
  for (const key of ['text', 'excludeText', 'regex', 'regexFlags', 'pkg', 'tag', 'domain', 'minLevel']) {
    if (typeof input.filter?.[key] === 'string') filter[key] = input.filter[key];
  }
  if (Number.isFinite(input.filter?.pid)) filter.pid = input.filter.pid;
  const entries = normalizeEntries(input.entries, MAX_SESSION_ENTRIES);
  const evidence = normalizeEntries(input.evidence || [], MAX_EVIDENCE_ENTRIES, true);
  const validRefs = new Set(evidence.map(entry => entry.ref));
  if (!Array.isArray(input.aiTurns) || input.aiTurns.length > 500) throw new Error(tr("AI 对话格式无效或超过 500 轮限制；未截断"));
  const aiTurns = input.aiTurns.map(turn => {
    if (!turn || typeof turn.content !== 'string' || !Array.isArray(turn.evidenceRefs || [])) throw new Error(tr("AI 对话内容无效"));
    const evidenceRefs = turn.evidenceRefs || [];
    if (evidenceRefs.some(ref => !validRefs.has(ref))) throw new Error(tr("AI 对话缺少对应原始证据，不能保存不完整引用"));
    return {
      header: String(turn.header || ''), content: turn.content,
      reasoning: String(turn.reasoning || ''), reasoningExpanded: false, evidenceRefs
    };
  });
  const buffers = Array.isArray(input.buffers) ? input.buffers.filter(item => ['main', 'system', 'radio', 'events', 'crash', 'kernel', 'app', 'core', 'init', 'kmsg'].includes(item)) : ['main'];
  const markers = normalizeMarkers(input.markers || []);
  return {
    schemaVersion: 1, name, source: input.source, sourceLabel: String(input.sourceLabel || ''),
    deviceId: String(input.deviceId || ''), filter, buffers, entries, evidence, aiTurns, markers,
    timeRange: normalizeSessionTimeRange(input.timeRange),
    truncated: input.truncated === true, savedScope: 'loaded-entries', readOnlyAi: true
  };
}

function normalizeMarkers(markers) {
  if (!Array.isArray(markers) || markers.length > MAX_MARKERS) throw new Error(tr("问题标记超过 500 条或格式无效；未截断"));
  const seen = new Set();
  return markers.map(marker => {
    if (!marker || typeof marker.id !== 'string' || !ID_PATTERN.test(marker.id) || seen.has(marker.id)) throw new Error(tr("问题标记 ID 无效或重复"));
    const note = String(marker.note || '').trim();
    if (!note || note.length > 240) throw new Error(tr("问题标记备注需为 1–240 字"));
    if (!Number.isFinite(marker.createdAt)) throw new Error(tr("问题标记时间无效"));
    seen.add(marker.id);
    return {
      id: marker.id, note, createdAt: marker.createdAt,
      entry: normalizeEntries([marker.entry], 1)[0],
      context: normalizeEntries(marker.context || [], 11)
    };
  });
}

function sessionSummary(session) {
  return {
    id: session.id, name: session.name, savedAt: session.savedAt, entryCount: session.entries.length,
    deviceId: session.deviceId, source: session.source, markerCount: session.markers.length
  };
}

function validSummary(summary, id) {
  return summary?.id === id && typeof summary.name === 'string' && summary.name.length > 0 && summary.name.length <= 80
    && typeof summary.deviceId === 'string' && ['realtime', 'file'].includes(summary.source)
    && typeof summary.savedAt === 'string' && Number.isFinite(Date.parse(summary.savedAt))
    && Number.isInteger(summary.entryCount) && summary.entryCount >= 0 && summary.entryCount <= MAX_SESSION_ENTRIES
    && Number.isInteger(summary.markerCount) && summary.markerCount >= 0 && summary.markerCount <= MAX_MARKERS;
}

function createSessionStore(directory, { trashItem, signal, maxBytes = MAX_SESSION_BYTES } = {}) {
  const metadataDirectory = path.join(directory, '.metadata');
  function sessionPath(id) {
    if (!ID_PATTERN.test(String(id))) throw new Error(tr("会话 ID 无效"));
    return path.join(directory, `${id}.json`);
  }
  async function fileStat(id) {
    signal?.throwIfAborted();
    const root = await fs.promises.lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error(tr('会话目录必须是普通目录，不能是链接。'));
    const stat = await fs.promises.lstat(sessionPath(id));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error(tr("会话文件无效或超过 64 MB 限制"));
    return stat;
  }
  async function read(id) {
    const file = sessionPath(id);
    await fileStat(id);
    const bytes = await fs.promises.readFile(file, signal ? { signal } : undefined);
    if (bytes.length > maxBytes) throw new Error(tr("会话文件无效或超过 64 MB 限制"));
    return runSessionJob('decode', { bytes, id }, { signal, maxBytes });
  }
  async function writeMetadata(session) {
    const stat = await fileStat(session.id);
    await fs.promises.mkdir(metadataDirectory, { recursive: true });
    const directoryStat = await fs.promises.lstat(metadataDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error(tr("会话索引目录无效"));
    const temporary = path.join(metadataDirectory, `${session.id}.${randomUUID()}.tmp`);
    try {
      await fs.promises.writeFile(temporary, JSON.stringify({
        version: 1, size: stat.size, mtimeMs: stat.mtimeMs, session: Array.isArray(session.entries) ? sessionSummary(session) : session
      }), { encoding: 'utf8', flag: 'wx' });
      await fs.promises.rename(temporary, path.join(metadataDirectory, `${session.id}.json`));
    } finally { await fs.promises.unlink(temporary).catch(() => {}); }
  }
  async function summary(id) {
    const stat = await fileStat(id);
    try {
      const metadataStat = await fs.promises.lstat(metadataDirectory);
      if (!metadataStat.isDirectory() || metadataStat.isSymbolicLink()) throw new Error(tr("会话索引目录无效"));
      const metadataPath = path.join(metadataDirectory, `${id}.json`);
      const metaStat = await fs.promises.lstat(metadataPath);
      if (metaStat.isFile() && !metaStat.isSymbolicLink() && metaStat.size < 16384) {
        const meta = JSON.parse(await fs.promises.readFile(metadataPath, 'utf8'));
        if (meta.version === 1 && meta.size === stat.size && meta.mtimeMs === stat.mtimeMs && validSummary(meta.session, id)) return meta.session;
      }
    } catch { /* Missing/stale metadata is rebuilt once from the original, never used as the source of truth. */ }
    const session = await read(id);
    await writeMetadata(session).catch(() => {});
    return sessionSummary(session);
  }
  return {
    async save(input) {
      const id = randomUUID(), savedAt = new Date().toISOString();
      const encoded = await runSessionJob('encode', { input, id, savedAt }, { signal, maxBytes });
      if (signal?.aborted) throw new Error(tr('会话操作已取消；当前内容保持不变。'));
      await fs.promises.mkdir(directory, { recursive: true });
      const root = await fs.promises.lstat(directory);
      if (!root.isDirectory() || root.isSymbolicLink()) throw new Error(tr('会话目录必须是普通目录，不能是链接。'));
      const temporary = path.join(directory, `${id}.${randomUUID()}.tmp`);
      try {
        await fs.promises.writeFile(temporary, encoded.bytes, { flag: 'wx' });
        if (signal?.aborted) throw new Error(tr('会话操作已取消；当前内容保持不变。'));
        await fs.promises.rename(temporary, sessionPath(id));
      } finally { await removePrivateTemporary(temporary); }
      await writeMetadata(encoded.summary).catch(() => {});
      return encoded.summary;
    },
    read,
    async rename(id, name) {
      const session = await read(id);
      const encoded = await runSessionJob('encode', { input: { ...session, name }, id, savedAt: session.savedAt }, { signal, maxBytes });
      const temporary = path.join(directory, `${id}.${randomUUID()}.tmp`);
      try {
        await fs.promises.writeFile(temporary, encoded.bytes, { flag: 'wx' });
        if (signal?.aborted) throw new Error(tr('会话操作已取消；当前内容保持不变。'));
        await fs.promises.rename(temporary, sessionPath(id));
      } finally { await removePrivateTemporary(temporary); }
      await writeMetadata(encoded.summary).catch(() => {});
      return encoded.summary;
    },
    async trash(id, confirmed) {
      if (confirmed !== true) throw new Error(tr("请先确认将会话移至回收站"));
      await fileStat(id);
      if (typeof trashItem !== 'function') throw new Error(tr("当前环境不支持回收站，未删除会话"));
      await trashItem(sessionPath(id));
      // Metadata is disposable; stale entries are ignored when the original is absent.
      const metadataStat = await fs.promises.lstat(metadataDirectory).catch(() => null);
      if (metadataStat?.isDirectory() && !metadataStat.isSymbolicLink()) {
        await fs.promises.unlink(path.join(metadataDirectory, `${id}.json`)).catch(() => {});
      }
      return { id };
    },
    async list() {
      const names = await fs.promises.readdir(directory).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const sessions = [];
      const errors = [];
      for (const name of names) {
        signal?.throwIfAborted();
        const id = name.endsWith('.json') ? name.slice(0, -5) : '';
        if (!ID_PATTERN.test(id)) continue;
        try {
          sessions.push(await summary(id));
        } catch (error) {
          if (signal?.aborted) throw error;
          errors.push({ id, error: error.message });
        }
      }
      sessions.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
      return { sessions, errors };
    }
  };
}

function register(ipcMain, { getDirectory, restore, trashItem, chooseDestination, getProtectedPaths = () => [], getSourceIdentity = () => '' } = {}) {
  const store = signal => createSessionStore(getDirectory(), { trashItem, signal });
  let pending = Promise.resolve();
  const operations = new Map();
  const protectedPaths = () => {
    const paths = getProtectedPaths();
    if (!Array.isArray(paths) || paths.length > 32 || paths.some(file => typeof file !== 'string' || !path.isAbsolute(file))) throw new Error(tr('导出选项无效。'));
    return [...paths];
  };
  const assertUnprotected = async (destination, originalPaths) => {
    for (const file of new Set([...originalPaths, ...protectedPaths()])) {
      const resolved = await fs.promises.realpath(file).catch(() => path.resolve(file));
      if (resolved.toLowerCase() === destination.toLowerCase()) throw new Error(tr('导出不能覆盖当前导入的原始日志文件。'));
    }
  };
  const handle = (channel, action) => ipcMain.handle(channel, async (event, args) => {
    if (cleanupFlight || quitting) return { ok: false, cancelled: true, error: tr('会话操作已取消；当前内容保持不变。') };
    const sender = event?.sender;
    if (sender) {
      const window = require('./app-context.cjs').getLogAnalyzerWindow();
      if (!window || window.isDestroyed() || sender !== window.webContents || event.senderFrame !== sender.mainFrame) return { ok: false, error: tr('会话请求来源无效。') };
    }
    const requestId = args?.requestId || randomUUID();
    if (!ID_PATTERN.test(requestId) || operations.has(requestId) || operations.size >= 8) return { ok: false, error: tr('会话请求无效或已有操作等待完成。') };
    const sourceAtRequest = channel === 'logSession:load' ? getSourceIdentity() : '';
    if (channel === 'logSession:load' && (typeof sourceAtRequest !== 'string'
      || args?.expectedSourceIdentity !== undefined && (typeof args.expectedSourceIdentity !== 'string' || args.expectedSourceIdentity.length > 4096 || args.expectedSourceIdentity !== sourceAtRequest))) {
      return { ok: false, error: tr('日志来源已变化，未恢复会话；当前内容保持不变。') };
    }
    const controller = new AbortController(), operation = { controller, sender, started: false, awaitCleanup: true, sourceAtRequest };
    operations.set(requestId, operation); liveOperations.add(operation);
    const abort = () => controller.abort(); sender?.once('destroyed', abort);
    const current = () => !controller.signal.aborted && !sender?.isDestroyed();
    // Keep rename/delete/list migration ordered, including requests from separate windows.
    const request = operation.completion = pending.then(() => { if (!current()) throw new Error(tr('会话操作已取消；当前内容保持不变。')); operation.started = true; return action(args, controller.signal, current, sender, operation); });
    pending = request.catch(() => {});
    try { return { ok: true, ...await request }; }
    catch (error) { return { ok: false, ...(controller.signal.aborted ? { cancelled: true } : {}), error: error.message }; }
    finally { sender?.removeListener('destroyed', abort); operations.delete(requestId); liveOperations.delete(operation); }
  });
  ipcMain.handle('logSession:cancel', async (event, args) => {
    const operation = operations.get(args?.requestId);
    if (!operation || operation.sender !== event?.sender || event?.sender && event.senderFrame !== event.sender.mainFrame) return { ok: false };
    operation.controller.abort(); return { ok: true };
  });
  handle('logSession:save', async (args, signal) => ({ session: await store(signal).save(args) }));
  handle('logSession:list', (_args, signal) => store(signal).list());
  handle('logSession:rename', async (args, signal) => ({ session: await store(signal).rename(args?.id, args?.name) }));
  handle('logSession:delete', async (args, signal) => store(signal).trash(args?.id, args?.confirmed));
  handle('logSession:load', async (args, signal, current, _sender, operation) => {
    if (getSourceIdentity() !== operation.sourceAtRequest) throw new Error(tr('日志来源已变化，未恢复会话；当前内容保持不变。'));
    const session = await store(signal).read(args?.id);
    if (!current()) throw new Error(tr('会话操作已取消；当前内容保持不变。'));
    if (getSourceIdentity() !== operation.sourceAtRequest) throw new Error(tr('日志来源已变化，未恢复会话；当前内容保持不变。'));
    const restored = await restore(session);
    return { session, ...(typeof restored?.sourceIdentity === 'string' && restored.sourceIdentity ? { sourceIdentity: restored.sourceIdentity } : {}) };
  });
  handle('logSession:compare', async (args, signal) => {
    if (!args || Object.keys(args).some(key => !['beforeId', 'afterId', 'requestId'].includes(key))) throw new Error(tr('比较请求无效。'));
    const before = await store(signal).read(args.beforeId), after = await store(signal).read(args.afterId);
    return { comparison: await runSessionJob('compare', { before, after }, { signal }) };
  });
  handle('logSession:exportPreview', async (args, signal) => {
    if (!args || Object.keys(args).some(key => !['requestId', 'scope', 'format', 'redact', 'snapshot', 'includeAi'].includes(key))
      || args.format !== 'bundle' || args.redact !== true || typeof args.includeAi !== 'boolean') throw new Error(tr('导出选项无效。'));
    return { preview: await runSessionJob('preview', { input: args.snapshot, options: { scope: args.scope, format: 'bundle', redact: true, includeAi: args.includeAi } }, { signal }) };
  });
  handle('logSession:export', async (args, signal, current, sender, operation) => {
    if (!args || Object.keys(args).some(key => !['requestId', 'scope', 'format', 'redact', 'snapshot', 'includeAi'].includes(key))
      || !['loaded', 'filtered', 'issue'].includes(args.scope) || !['raw', 'bundle'].includes(args.format)
      || typeof args.redact !== 'boolean' || typeof args.includeAi !== 'boolean' || args.format === 'raw' && args.includeAi) throw new Error(tr('导出选项无效。'));
    const options = { scope: args.scope, format: args.format, redact: args.redact, includeAi: args.includeAi };
    const originalPaths = protectedPaths();
    const extension = args.format === 'raw' ? 'log' : 'zip';
    operation.awaitCleanup = false;
    const choosing = chooseDestination ? chooseDestination(options) : require('electron').dialog.showSaveDialog(
      sender ? require('electron').BrowserWindow.fromWebContents(sender) : undefined,
      { title: tr('导出日志'), defaultPath: `Veylo-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`,
        filters: [{ name: args.format === 'raw' ? tr('原始日志') : tr('问题证据包'), extensions: [extension] }] });
    const result = await chooseUntilCancelled(choosing, signal);
    if (result?.canceled || !result?.filePath || !current()) return { cancelled: true };
    operation.awaitCleanup = true;
    const target = result.filePath;
    if (!path.isAbsolute(target) || path.extname(target).toLowerCase() !== `.${extension}`) throw new Error(tr('导出文件类型与所选格式不一致。'));
    const parent = await fs.promises.realpath(path.dirname(target)), destination = path.join(parent, path.basename(target));
    await assertUnprotected(destination, originalPaths);
    if (args.snapshot?.source === 'file' && typeof args.snapshot.sourceLabel === 'string' && path.isAbsolute(args.snapshot.sourceLabel)
      && path.resolve(args.snapshot.sourceLabel).toLowerCase() === destination.toLowerCase()) throw new Error(tr('导出不能覆盖当前导入的原始日志文件。'));
    const sessionRoot = await fs.promises.realpath(getDirectory()).catch(() => path.resolve(getDirectory()));
    const relative = path.relative(sessionRoot, destination);
    if (!relative || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) throw new Error(tr('请将导出文件保存在会话目录之外。'));
    const original = await fs.promises.lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (original && (!original.isFile() || original.isSymbolicLink() || original.nlink > 1)) throw new Error(tr('保存位置必须是普通文件，不能是链接。'));
    const temporaryRoot = await fs.promises.mkdtemp(path.join(parent, '.veylo-log-export-'));
    try {
      const temporary = path.join(temporaryRoot, `export.${extension}`);
      const built = await runSessionJob('export', { input: args.snapshot, options, staging: path.join(temporaryRoot, 'content'), bundle: temporary }, { signal });
      if (built.bytes) await fs.promises.writeFile(temporary, built.bytes, { flag: 'wx' });
      if (!current()) return { cancelled: true };
      const latest = await fs.promises.lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (Boolean(latest) !== Boolean(original) || latest && (latest.dev !== original.dev || latest.ino !== original.ino || latest.size !== original.size || latest.mtimeMs !== original.mtimeMs)) throw new Error(tr('保存位置已发生变化，未替换原文件。'));
      const bytes = (await fs.promises.stat(temporary)).size;
      await assertUnprotected(destination, originalPaths);
      if (!current()) return { cancelled: true };
      await fs.promises.rename(temporary, destination);
      return { path: destination, bytes, entryCount: built.entryCount };
    } finally {
      if (path.dirname(temporaryRoot) === parent && path.basename(temporaryRoot).startsWith('.veylo-log-export-')) await removePrivateTemporary(temporaryRoot, true);
    }
  });
}

module.exports = { MAX_SESSION_BYTES, MAX_SESSION_ENTRIES, normalizeSession, normalizeSessionTimeRange, createSessionStore, register, cleanup, prepareQuit, resumeAfterQuit };
