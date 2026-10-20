const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_ENTRIES = 50000;
const MAX_EVIDENCE_ENTRIES = 100000;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function normalizeEntries(entries, limit, withReferences = false) {
  if (!Array.isArray(entries) || entries.length > limit) throw new Error(`日志数量无效或超过 ${limit.toLocaleString()} 条限制；未保存或截断数据`);
  const seen = new Set();
  return entries.map(entry => {
    if (!entry || typeof entry.id !== 'string' || typeof entry.raw !== 'string') throw new Error('日志条目格式无效');
    const next = { id: entry.id, raw: entry.raw };
    for (const key of ['source', 'message', 'pkg', 'tag', 'level', 'deviceId']) {
      if (typeof entry[key] === 'string') next[key] = entry[key];
    }
    for (const key of ['ts', 'pid', 'tid']) {
      if (Number.isFinite(entry[key])) next[key] = entry[key];
    }
    if (withReferences) {
      if (!/^L[1-9]\d*$/.test(entry.ref) || seen.has(entry.ref)) throw new Error('证据编号无效或重复');
      seen.add(entry.ref);
      next.ref = entry.ref;
    }
    return next;
  });
}

function normalizeSession(input) {
  if (!input || !['realtime', 'file'].includes(input.source)) throw new Error('会话来源无效');
  const name = String(input.name || '').trim();
  if (!name || name.length > 80) throw new Error('会话名称需为 1–80 字');
  const filter = {};
  for (const key of ['text', 'excludeText', 'regex', 'regexFlags', 'pkg', 'tag', 'minLevel']) {
    if (typeof input.filter?.[key] === 'string') filter[key] = input.filter[key];
  }
  if (Number.isFinite(input.filter?.pid)) filter.pid = input.filter.pid;
  const entries = normalizeEntries(input.entries, MAX_SESSION_ENTRIES);
  const evidence = normalizeEntries(input.evidence || [], MAX_EVIDENCE_ENTRIES, true);
  const validRefs = new Set(evidence.map(entry => entry.ref));
  if (!Array.isArray(input.aiTurns) || input.aiTurns.length > 500) throw new Error('AI 对话格式无效或超过 500 轮限制；未截断');
  const aiTurns = input.aiTurns.map(turn => {
    if (!turn || typeof turn.content !== 'string' || !Array.isArray(turn.evidenceRefs || [])) throw new Error('AI 对话内容无效');
    const evidenceRefs = turn.evidenceRefs || [];
    if (evidenceRefs.some(ref => !validRefs.has(ref))) throw new Error('AI 对话缺少对应原始证据，不能保存不完整引用');
    return {
      header: String(turn.header || ''), content: turn.content,
      reasoning: String(turn.reasoning || ''), reasoningExpanded: false, evidenceRefs
    };
  });
  const buffers = Array.isArray(input.buffers) ? input.buffers.filter(item => ['main', 'system', 'radio', 'events', 'crash', 'kernel'].includes(item)) : ['main'];
  return {
    schemaVersion: 1, name, source: input.source, sourceLabel: String(input.sourceLabel || ''),
    deviceId: String(input.deviceId || ''), filter, buffers, entries, evidence, aiTurns,
    truncated: input.truncated === true, savedScope: 'loaded-entries', readOnlyAi: true
  };
}

function createSessionStore(directory) {
  function sessionPath(id) {
    if (!ID_PATTERN.test(String(id))) throw new Error('会话 ID 无效');
    return path.join(directory, `${id}.json`);
  }
  async function read(id) {
    const file = sessionPath(id);
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SESSION_BYTES) throw new Error('会话文件无效或超过 64 MB 限制');
    const data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    if (data.schemaVersion !== 1 || data.id !== id) throw new Error('不支持的会话格式');
    return { ...normalizeSession(data), id, savedAt: data.savedAt };
  }
  return {
    async save(input) {
      const session = { ...normalizeSession(input), id: randomUUID(), savedAt: new Date().toISOString() };
      const json = JSON.stringify(session);
      if (Buffer.byteLength(json, 'utf8') > MAX_SESSION_BYTES) throw new Error('会话超过 64 MB 限制，未保存、未截断。请先导出原始日志后拆分分析');
      await fs.promises.mkdir(directory, { recursive: true });
      await fs.promises.writeFile(sessionPath(session.id), json, { encoding: 'utf8', flag: 'wx' });
      return { id: session.id, name: session.name, savedAt: session.savedAt, entryCount: session.entries.length };
    },
    read,
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
          const data = await read(id);
          sessions.push({ id, name: data.name, savedAt: data.savedAt, entryCount: data.entries.length, deviceId: data.deviceId, source: data.source });
        } catch (error) {
          errors.push({ id, error: error.message });
        }
      }
      sessions.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
      return { sessions, errors };
    }
  };
}

function register(ipcMain, { getDirectory, restore }) {
  const store = () => createSessionStore(getDirectory());
  const handle = (channel, action) => ipcMain.handle(channel, async (_event, args) => {
    try { return { ok: true, ...await action(args) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  handle('logSession:save', async args => ({ session: await store().save(args) }));
  handle('logSession:list', () => store().list());
  handle('logSession:load', async args => {
    const session = await store().read(args?.id);
    await restore(session);
    return { session };
  });
}

module.exports = { MAX_SESSION_BYTES, MAX_SESSION_ENTRIES, normalizeSession, createSessionStore, register };
