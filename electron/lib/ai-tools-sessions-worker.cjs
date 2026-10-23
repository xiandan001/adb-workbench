const fs = require('node:fs');
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const { readSafe, decodeConfig, assertSafeParents, fail } = require('./ai-tools-file-safety.cjs');
const { parseSession, summarizeUsage } = require('./ai-tools-session-parser.cjs');
const { sessionArchiveId, sessionRoots, isSessionCandidate, isCredentialName } = require('./ai-tools-session-archives.cjs');

const MAX_FILE = 16 * 1024 * 1024;
const MAX_SCAN = 96 * 1024 * 1024;
let indexed = new Map(); let lastScan = null; let archivedBytes = 0; const contentIds = new Set();

function candidates(root, toolId, budget, depth = 0) {
  if (depth > 8 || budget.entries >= 20000) { budget.incomplete = true; return []; }
  let entries;
  try { assertSafeParents(path.join(root, '.scan')); entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') budget.skipped++; return []; }
  const files = [];
  for (const entry of entries) {
    if (++budget.entries > 20000 || files.length >= 2000) { budget.incomplete = true; break; }
    if (isCredentialName(entry.name)) continue;
    if (entry.isSymbolicLink()) { budget.skipped++; continue; }
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...candidates(file, toolId, budget, depth + 1));
    else if (entry.isFile() && isSessionCandidate(file, toolId)) {
      try { const stat = fs.lstatSync(file); if (stat.size > MAX_FILE || stat.nlink !== 1) { budget.skipped++; continue; } files.push({ file, toolId, size: stat.size, modifiedAt: stat.mtimeMs }); }
      catch { budget.skipped++; }
    }
  }
  return files;
}
function parseFile(row) {
  const source = readSafe(row.file, fs, MAX_FILE);
  if (!source.exists) throw fail('AI_TOOLS_SESSION_MISSING', '会话文件已移走，请重新扫描');
  const parsed = parseSession(decodeConfig(source.bytes), row.toolId, row.file.endsWith('.json') ? 'json' : 'jsonl');
  return { ...parsed, toolId: row.toolId, id: row.id, contentId: sessionArchiveId(row.toolId, row.file.endsWith('.json') ? 'json' : 'jsonl', source.bytes), path: row.file, modifiedAt: row.modifiedAt, size: source.bytes.length };
}
function scan() {
  const budget = { entries: 0, skipped: 0, incomplete: false }; const all = [];
  for (const source of sessionRoots(workerData.home)) all.push(...candidates(source.root, source.toolId, budget));
  all.sort((a, b) => b.modifiedAt - a.modifiedAt);
  const next = new Map(); const sessions = []; let bytes = 0; contentIds.clear(); archivedBytes = 0;
  for (const source of all) {
    if (next.size >= 500 || bytes + source.size > MAX_SCAN) { budget.incomplete = true; continue; }
    bytes += source.size;
    const row = { ...source, id: createHash('sha256').update(`${source.toolId}:${source.file}`).digest('hex') };
    try {
      const parsed = parseFile(row); const { messages, usage, ...summary } = parsed;
      if (!messages.length && !usage.length && !parsed.sessionId) continue;
      if (contentIds.has(parsed.contentId)) continue;
      contentIds.add(parsed.contentId);
      sessions.push({ toolId: row.toolId, usage });
      next.set(row.id, { ...row, usage, summary: { ...summary, messageCount: messages.length, title: parsed.title || path.basename(source.file) } });
    } catch { budget.skipped++; }
  }
  indexed = next;
  lastScan = { scannedAt: Date.now(), count: next.size, archivedCount: 0, skipped: budget.skipped, incomplete: budget.incomplete, roots: sessionRoots(workerData.home), usage: summarizeUsage(sessions) };
  return lastScan;
}
function list(args) {
  if (!lastScan) return { scannedAt: null, count: 0, sessions: [], roots: sessionRoots(workerData.home) };
  const query = (typeof args.search === 'string' ? args.search : '').trim().toLocaleLowerCase().slice(0, 200);
  const selected = [...indexed.values()].map(row => row.summary).filter(row => (!args.toolId || row.toolId === args.toolId) && (!query || `${row.title} ${row.cwd} ${row.model}`.toLocaleLowerCase().includes(query)))
    .sort((first, second) => second.modifiedAt - first.modifiedAt);
  const offset = Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : 0;
  return { ...lastScan, count: selected.length, sessions: selected.slice(offset, offset + 50), offset, hasMore: selected.length > offset + 50 };
}
function parseArchive(row, buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > MAX_FILE || buffer.byteLength !== row.bytes) throw fail('AI_TOOLS_SESSION_ARCHIVE_FORMAT', '归档读取数据无效');
  const raw = Buffer.from(buffer);
  if (sessionArchiveId(row.toolId, row.format, raw) !== row.id) throw fail('AI_TOOLS_SESSION_ARCHIVE_CHANGED', '归档内容与扫描身份不一致，请重新扫描');
  return { ...parseSession(decodeConfig(raw), row.toolId, row.format), id: row.id, contentId: row.id, toolId: row.toolId,
    imported: true, archived: true, readOnly: true, source: 'migration-archive', sourceName: row.sourceName, path: `迁移归档/${row.sourceName}`, modifiedAt: row.modifiedAt, size: raw.length };
}
function indexArchive(args) {
  if (!lastScan) throw fail('AI_TOOLS_SESSION_MISSING', '请先扫描会话');
  const row = args.metadata;
  if (!row || typeof row.id !== 'string' || !/^[a-f0-9]{64}$/.test(row.id) || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > MAX_FILE) throw fail('AI_TOOLS_SESSION_ARCHIVE_FORMAT', '归档元数据无效');
  if (contentIds.has(row.id)) return { indexed: false, duplicate: true };
  if (indexed.size >= 1000 || lastScan.archivedCount >= 500 || archivedBytes + row.bytes > MAX_SCAN) { lastScan.incomplete = true; return { indexed: false, limited: true }; }
  const parsed = parseArchive(row, args.raw); const { messages, usage, ...summary } = parsed;
  indexed.set(row.id, { ...row, archived: true, usage, summary: { ...summary, messageCount: messages.length, title: parsed.title || row.sourceName } });
  contentIds.add(row.id); archivedBytes += row.bytes; lastScan.count = indexed.size; lastScan.archivedCount++;
  return { indexed: true };
}
function finishScan() { if (lastScan) lastScan.usage = summarizeUsage([...indexed.values()].map(row => ({ toolId: row.toolId, usage: row.usage }))); return lastScan; }
function open(args) {
  const row = indexed.get(args.id); if (!row) throw fail('AI_TOOLS_SESSION_MISSING', '请先扫描并从列表选择会话');
  const parsed = row.archived ? parseArchive(row, args.raw) : parseFile(row); const offset = Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : 0;
  const messages = parsed.messages.slice(offset, offset + 50);
  return { ...parsed, messages, messageCount: parsed.messages.length, offset, hasMore: parsed.messages.length > offset + 50 };
}
parentPort.on('message', request => {
  try {
    const result = request.command === 'scan' ? scan() : request.command === 'list' ? list(request.args || {}) : request.command === 'open' ? open(request.args || {})
      : request.command === 'archive-index' ? indexArchive(request.args || {}) : request.command === 'scan-finish' ? finishScan() : null;
    if (result === null) throw fail('AI_TOOLS_SESSION_COMMAND', '会话操作无效');
    parentPort.postMessage({ id: request.id, result });
  } catch (error) { parentPort.postMessage({ id: request.id, error: { code: error.code?.startsWith('AI_TOOLS_') ? error.code : 'AI_TOOLS_SESSION_FAILED', message: error.code?.startsWith('AI_TOOLS_') ? error.message : '读取会话未完成；源文件未修改' } }); }
});
