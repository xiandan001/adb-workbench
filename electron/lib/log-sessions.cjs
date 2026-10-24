const { tr } = require('./localization.cjs');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_ENTRIES = 50000;
const MAX_EVIDENCE_ENTRIES = 100000;
const MAX_MARKERS = 500;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function normalizeEntries(entries, limit, withReferences = false) {
  if (!Array.isArray(entries) || entries.length > limit) throw new Error(tr("日志数量无效或超过 {0} 条限制；未保存或截断数据", { 0: limit.toLocaleString() }));
  const seen = new Set();
  return entries.map(entry => {
    if (!entry || typeof entry.id !== 'string' || typeof entry.raw !== 'string') throw new Error(tr("日志条目格式无效"));
    const next = { id: entry.id, raw: entry.raw };
    for (const key of ['source', 'message', 'pkg', 'tag', 'level', 'deviceId']) {
      if (typeof entry[key] === 'string') next[key] = entry[key];
    }
    for (const key of ['ts', 'pid', 'tid']) {
      if (Number.isFinite(entry[key])) next[key] = entry[key];
    }
    if (withReferences) {
      if (!/^L[1-9]\d*$/.test(entry.ref) || seen.has(entry.ref)) throw new Error(tr("证据编号无效或重复"));
      seen.add(entry.ref);
      next.ref = entry.ref;
    }
    return next;
  });
}

function normalizeSession(input) {
  if (!input || !['realtime', 'file'].includes(input.source)) throw new Error(tr("会话来源无效"));
  const name = String(input.name || '').trim();
  if (!name || name.length > 80) throw new Error(tr("会话名称需为 1–80 字"));
  const filter = {};
  for (const key of ['text', 'excludeText', 'regex', 'regexFlags', 'pkg', 'tag', 'minLevel']) {
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
  const buffers = Array.isArray(input.buffers) ? input.buffers.filter(item => ['main', 'system', 'radio', 'events', 'crash', 'kernel'].includes(item)) : ['main'];
  const markers = normalizeMarkers(input.markers || []);
  return {
    schemaVersion: 1, name, source: input.source, sourceLabel: String(input.sourceLabel || ''),
    deviceId: String(input.deviceId || ''), filter, buffers, entries, evidence, aiTurns, markers,
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

function createSessionStore(directory, { trashItem } = {}) {
  const metadataDirectory = path.join(directory, '.metadata');
  function sessionPath(id) {
    if (!ID_PATTERN.test(String(id))) throw new Error(tr("会话 ID 无效"));
    return path.join(directory, `${id}.json`);
  }
  async function fileStat(id) {
    const stat = await fs.promises.lstat(sessionPath(id));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SESSION_BYTES) throw new Error(tr("会话文件无效或超过 64 MB 限制"));
    return stat;
  }
  async function read(id) {
    const file = sessionPath(id);
    await fileStat(id);
    const data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    if (data.schemaVersion !== 1 || data.id !== id) throw new Error(tr("不支持的会话格式"));
    return { ...normalizeSession(data), id, savedAt: data.savedAt };
  }
  async function writeMetadata(session) {
    const stat = await fileStat(session.id);
    await fs.promises.mkdir(metadataDirectory, { recursive: true });
    const directoryStat = await fs.promises.lstat(metadataDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error(tr("会话索引目录无效"));
    const temporary = path.join(metadataDirectory, `${session.id}.${randomUUID()}.tmp`);
    try {
      await fs.promises.writeFile(temporary, JSON.stringify({
        version: 1, size: stat.size, mtimeMs: stat.mtimeMs, session: sessionSummary(session)
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
      const session = { ...normalizeSession(input), id: randomUUID(), savedAt: new Date().toISOString() };
      const json = JSON.stringify(session);
      if (Buffer.byteLength(json, 'utf8') > MAX_SESSION_BYTES) throw new Error(tr("会话超过 64 MB 限制，未保存、未截断。请先导出原始日志后拆分分析"));
      await fs.promises.mkdir(directory, { recursive: true });
      await fs.promises.writeFile(sessionPath(session.id), json, { encoding: 'utf8', flag: 'wx' });
      await writeMetadata(session).catch(() => {});
      return sessionSummary(session);
    },
    read,
    async rename(id, name) {
      const session = await read(id);
      const renamed = { ...normalizeSession({ ...session, name }), id, savedAt: session.savedAt };
      const json = JSON.stringify(renamed);
      if (Buffer.byteLength(json, 'utf8') > MAX_SESSION_BYTES) throw new Error(tr("新名称将使会话超过 64 MB 限制，未修改原文件"));
      const temporary = path.join(directory, `${id}.${randomUUID()}.tmp`);
      try {
        await fs.promises.writeFile(temporary, json, { encoding: 'utf8', flag: 'wx' });
        await fs.promises.rename(temporary, sessionPath(id));
      } finally { await fs.promises.unlink(temporary).catch(() => {}); }
      await writeMetadata(renamed).catch(() => {});
      return sessionSummary(renamed);
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
        const id = name.endsWith('.json') ? name.slice(0, -5) : '';
        if (!ID_PATTERN.test(id)) continue;
        try {
          sessions.push(await summary(id));
        } catch (error) {
          errors.push({ id, error: error.message });
        }
      }
      sessions.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
      return { sessions, errors };
    }
  };
}

function register(ipcMain, { getDirectory, restore, trashItem }) {
  const store = () => createSessionStore(getDirectory(), { trashItem });
  let pending = Promise.resolve();
  const handle = (channel, action) => ipcMain.handle(channel, async (_event, args) => {
    // Keep rename/delete/list migration ordered, including requests from separate windows.
    const request = pending.then(() => action(args));
    pending = request.catch(() => {});
    try { return { ok: true, ...await request }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  handle('logSession:save', async args => ({ session: await store().save(args) }));
  handle('logSession:list', () => store().list());
  handle('logSession:rename', async args => ({ session: await store().rename(args?.id, args?.name) }));
  handle('logSession:delete', async args => store().trash(args?.id, args?.confirmed));
  handle('logSession:load', async args => {
    const session = await store().read(args?.id);
    await restore(session);
    return { session };
  });
}

module.exports = { MAX_SESSION_BYTES, MAX_SESSION_ENTRIES, normalizeSession, createSessionStore, register };
