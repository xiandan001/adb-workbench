const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readSafe, decodeConfig, assertSafeParents, fail } = require('./ai-tools-file-safety.cjs');
const { exact, requireEncryption, prepareStateWrite } = require('./ai-tools-migration-common.cjs');

const MAX_RAW = 16 * 1024 * 1024;
const MAX_TOTAL = 96 * 1024 * 1024;
const MAX_ARCHIVE = 32 * 1024 * 1024;
const MAX_RECORDS = 500;
const HASH = /^[a-f0-9]{64}$/;
const TOOLS = new Set(['claude', 'codex', 'gemini', 'pi']);
const sessionRoots = home => [
  { toolId: 'claude', root: path.join(home, '.claude', 'projects') },
  { toolId: 'codex', root: path.join(home, '.codex', 'sessions') },
  { toolId: 'codex', root: path.join(home, '.codex', 'archived_sessions') },
  { toolId: 'gemini', root: path.join(home, '.gemini', 'tmp') },
  { toolId: 'pi', root: path.join(home, '.pi', 'agent', 'sessions') },
];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const malformed = () => fail('AI_TOOLS_SESSION_ARCHIVE_FORMAT', '会话归档格式、原始内容或校验值无效，未导入');
const limit = () => fail('AI_TOOLS_SESSION_ARCHIVE_LIMIT', '会话超过数量或容量限制（500 条 / 总计 96 MiB / 单条 16 MiB）；请取消包含会话或整理源数据，不会截断');
function sessionArchiveId(toolId, format, raw) { return createHash('sha256').update(`${toolId}\0${format}\0`).update(raw).digest('hex'); }
const isCredentialName = name => /^\.?(?:auth|oauth(?:_creds)?|credentials|accounts?|tokens?|secrets|env)(?:[._-]|$)/i.test(name);
function isSessionCandidate(file, toolId) {
  const name = path.basename(file);
  if (isCredentialName(name)) return false;
  return toolId === 'gemini' ? /^session-.+\.jsonl?$/.test(name) && path.basename(path.dirname(file)) === 'chats' : name.endsWith('.jsonl');
}
function recognized(value, toolId) {
  if (!object(value)) return false;
  if (toolId === 'claude') return typeof value.sessionId === 'string' || object(value.message) && ['user', 'assistant', 'system', 'tool'].includes(value.message.role || value.type);
  if (toolId === 'codex') return ['session_meta', 'turn_context', 'response_item', 'event_msg', 'token_usage_record'].includes(value.type) && object(value.payload || value.usage);
  if (toolId === 'gemini') return typeof value.sessionId === 'string' || Array.isArray(value.messages) || object(value.$set) && (typeof value.$set.sessionId === 'string' || Array.isArray(value.$set.messages)) || typeof value.id === 'string' && ['user', 'gemini', 'system', 'tool'].includes(value.type);
  return value.type === 'session' && typeof value.id === 'string' || value.type === 'message' && object(value.message);
}
function validateRaw(raw, toolId, format) {
  if (!Buffer.isBuffer(raw) || !raw.length || raw.length > MAX_RAW) throw limit();
  const text = decodeConfig(raw); let found = false;
  if (format === 'json') { try { found = recognized(JSON.parse(text), toolId); } catch { /* Unknown schemas never become an empty backup. */ } }
  else {
    let start = 0;
    while (start < text.length && !found) {
      const end = text.indexOf('\n', start); const line = text.slice(start, end < 0 ? text.length : end); start = end < 0 ? text.length : end + 1;
      if (!line.trim()) continue;
      try { found = recognized(JSON.parse(line), toolId); } catch { /* Preserve malformed trailing/original lines verbatim if this is a recognized session. */ }
    }
  }
  if (!found) throw fail('AI_TOOLS_SESSION_ARCHIVE_FORMAT', '发现无法识别的会话格式，未导出或截断；请检查源文件或取消包含会话');
}
function normalizeRecord(record) {
  exact(record, ['id', 'toolId', 'format', 'data', 'sourceName', 'modifiedAt', 'bytes'], '会话归档');
  if (Object.keys(record).length !== 7 || !HASH.test(record.id) || !TOOLS.has(record.toolId) || !['json', 'jsonl'].includes(record.format)
    || typeof record.sourceName !== 'string' || !record.sourceName || record.sourceName.length > 256 || ['.', '..'].includes(record.sourceName)
    || path.basename(record.sourceName) !== record.sourceName || path.win32.basename(record.sourceName) !== record.sourceName || Array.from(record.sourceName).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    || !Number.isFinite(record.modifiedAt) || record.modifiedAt < 0 || record.modifiedAt > 8640000000000000 || !Number.isSafeInteger(record.bytes) || record.bytes < 1 || record.bytes > MAX_RAW
    || typeof record.data !== 'string' || record.data.length > Math.ceil(MAX_RAW / 3) * 4) throw malformed();
  const raw = Buffer.from(record.data, 'base64');
  if (raw.toString('base64') !== record.data || raw.length !== record.bytes || sessionArchiveId(record.toolId, record.format, raw) !== record.id) throw malformed();
  validateRaw(raw, record.toolId, record.format);
  return { record: { ...record }, raw };
}

function createAiToolsSessionArchives({ directory, home, canEncrypt, encrypt, decrypt } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || typeof home !== 'string' || !path.isAbsolute(home) || directory.includes('\0') || home.includes('\0')) throw fail('AI_TOOLS_SESSION_PATH', '会话归档目录无效');
  const archiveDirectory = path.join(directory, 'session-archives'); const encryption = { canEncrypt, encrypt, decrypt }; let disposed = false;
  const active = signal => { if (disposed || signal?.aborted) throw fail('AI_TOOLS_CANCELLED', '会话归档操作已取消'); };
  const archivePath = id => { if (typeof id !== 'string' || !HASH.test(id)) throw malformed(); return path.join(archiveDirectory, `${id}.json`); };
  async function archiveFiles(signal) {
    active(signal); assertSafeParents(path.join(archiveDirectory, '.scope')); let dir;
    try { dir = await fs.promises.opendir(archiveDirectory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const result = []; let entries = 0;
    for await (const entry of dir) {
      active(signal); if (++entries > 20000) throw limit();
      if (!/^[a-f0-9]{64}\.json$/i.test(entry.name)) continue;
      if (!/^[a-f0-9]{64}\.json$/.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) throw malformed();
      result.push(entry.name.slice(0, -5)); if (result.length > MAX_RECORDS) throw limit();
    }
    return result.sort();
  }
  function readArchive(id, expectedHash) {
    active(); requireEncryption(encryption); const source = readSafe(archivePath(id), fs, MAX_ARCHIVE);
    if (!source.bytes) throw fail('AI_TOOLS_SESSION_ARCHIVE_MISSING', '会话归档已移走，请重新扫描');
    if (expectedHash !== undefined && source.hash !== expectedHash) throw fail('AI_TOOLS_SESSION_ARCHIVE_CHANGED', '会话归档在扫描后已变化，请重新扫描');
    try {
      const envelope = JSON.parse(decodeConfig(source.bytes)); exact(envelope, ['version', 'encrypted'], '会话密文');
      if (envelope.version !== 1 || Object.keys(envelope).length !== 2 || typeof envelope.encrypted !== 'string') throw malformed();
      const cipher = Buffer.from(envelope.encrypted, 'base64'); if (!cipher.length || cipher.toString('base64') !== envelope.encrypted) throw malformed();
      const decoded = decrypt(cipher); if (typeof decoded !== 'string' || Buffer.byteLength(decoded) > MAX_ARCHIVE) throw malformed();
      const value = JSON.parse(decoded); exact(value, ['version', 'record'], '会话密文内容'); if (value.version !== 1 || Object.keys(value).length !== 2) throw malformed();
      const validated = normalizeRecord(value.record); if (validated.record.id !== id) throw malformed();
      return { ...validated, hash: source.hash, path: source.path };
    } catch { throw fail('AI_TOOLS_SESSION_ARCHIVE_READ', '会话加密归档无法读取或校验失败，原文件已保留'); }
  }
  async function visitArchives(visitor, { signal } = {}) {
    let bytes = 0; let count = 0;
    for (const id of await archiveFiles(signal)) {
      active(signal); const result = readArchive(id); bytes += result.raw.length; if (bytes > MAX_TOTAL) throw limit(); count++;
      await visitor(result); active(signal);
    }
    return { count, bytes };
  }
  async function nativeFiles() {
    const files = []; let entries = 0;
    const walk = async (folder, toolId, depth) => {
      active(); if (depth > 8) throw fail('AI_TOOLS_SESSION_ARCHIVE_LIMIT', '会话目录层级超过扫描限制，未导出或截断');
      assertSafeParents(path.join(folder, '.scope')); let dir;
      try { dir = await fs.promises.opendir(folder); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for await (const entry of dir) {
        active(); if (++entries > 20000) throw limit(); const file = path.join(folder, entry.name);
        if (isCredentialName(entry.name)) continue;
        if (entry.isSymbolicLink()) throw fail('AI_TOOLS_SESSION_PATH', '会话目录包含链接，未跟随或导出');
        if (entry.isDirectory()) await walk(file, toolId, depth + 1);
        else if (entry.isFile() && isSessionCandidate(file, toolId)) {
          const stat = await fs.promises.lstat(file); if (stat.nlink !== 1) throw fail('AI_TOOLS_SESSION_PATH', '会话文件包含硬链接，未导出'); if (stat.size > MAX_RAW) throw limit();
          files.push({ file, toolId, modifiedAt: stat.mtimeMs, format: file.endsWith('.json') ? 'json' : 'jsonl' }); if (files.length > 2000) throw limit();
        }
      }
    };
    for (const root of sessionRoots(home)) await walk(root.root, root.toolId, 0);
    return files;
  }
  async function exportPortable({ includeSessions = true } = {}) {
    active(); if (typeof includeSessions !== 'boolean') throw malformed();
    if (!includeSessions) return { version: 1, included: false, records: [] };
    const rows = new Map(); let bytes = 0; let readBytes = 0;
    const add = record => { if (rows.has(record.id)) return; bytes += record.bytes; if (bytes > MAX_TOTAL || rows.size >= MAX_RECORDS) throw limit(); rows.set(record.id, record); };
    for (const source of await nativeFiles()) {
      active(); const saved = readSafe(source.file, fs, MAX_RAW); if (!saved.bytes) throw fail('AI_TOOLS_SESSION_ARCHIVE_CHANGED', '会话文件在导出时已移走，请重试');
      readBytes += saved.bytes.length; if (readBytes > MAX_TOTAL * 2) throw limit(); validateRaw(saved.bytes, source.toolId, source.format);
      add({ id: sessionArchiveId(source.toolId, source.format, saved.bytes), toolId: source.toolId, format: source.format, data: saved.bytes.toString('base64'), sourceName: path.basename(source.file), modifiedAt: source.modifiedAt, bytes: saved.bytes.length });
      await new Promise(resolve => setImmediate(resolve));
    }
    await visitArchives(({ record, raw }) => { readBytes += raw.length; if (readBytes > MAX_TOTAL * 2) throw limit(); add(record); });
    active(); return { version: 1, included: true, records: [...rows.values()] };
  }
  async function preparePortableImport(payload) {
    active(); exact(payload, ['version', 'included', 'records'], '会话迁移');
    if (Object.keys(payload).length !== 3 || payload.version !== 1 || typeof payload.included !== 'boolean' || !Array.isArray(payload.records) || payload.records.length > MAX_RECORDS || !payload.included && payload.records.length) throw malformed();
    if (!payload.included) return { targets: [], guards: [], counts: { added: 0, skipped: 0 } };
    requireEncryption(encryption); const incoming = new Map(); let incomingBytes = 0;
    for (const input of payload.records) { const { record } = normalizeRecord(input); if (incoming.has(record.id)) throw malformed(); incomingBytes += record.bytes; if (incomingBytes > MAX_TOTAL) throw limit(); incoming.set(record.id, record); }
    const current = new Map(); const guards = []; let total = 0;
    await visitArchives(({ record, hash, path: file }) => { current.set(record.id, record); total += record.bytes; guards.push({ path: file, expectedHash: hash, limit: MAX_ARCHIVE }); });
    const targets = []; let skipped = 0;
    for (const record of incoming.values()) {
      active(); if (current.has(record.id)) { skipped++; continue; }
      total += record.bytes; if (total > MAX_TOTAL || current.size + targets.length >= MAX_RECORDS) throw limit();
      targets.push(prepareStateWrite(archivePath(record.id), { version: 1, record }, null, encryption, MAX_ARCHIVE));
    }
    return { targets, guards, counts: { added: targets.length, skipped } };
  }
  return { exportPortable, preparePortableImport, visitArchives, readForViewer: ({ id, expectedHash }) => readArchive(id, expectedHash), dispose() { disposed = true; } };
}

module.exports = { createAiToolsSessionArchives, sessionArchiveId, sessionRoots, isSessionCandidate, isCredentialName, MAX_SESSION_RAW_BYTES: MAX_RAW, MAX_SESSION_TOTAL_BYTES: MAX_TOTAL };
