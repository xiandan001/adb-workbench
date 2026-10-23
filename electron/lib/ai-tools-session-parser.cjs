const { fail } = require('./ai-tools-file-safety.cjs');

const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = value => typeof value === 'string' ? value : '';
const short = (value, maximum = 256) => text(value).slice(0, maximum);
const time = value => { const result = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(result) ? result : null; };
function content(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(block => ['text', 'input_text', 'output_text'].includes(block?.type) ? text(block.text) : block?.type === 'tool_use' || block?.type === 'function_call' ? `[工具调用：${text(block.name)}]` : block?.type === 'tool_result' ? '[工具返回]' : '').filter(Boolean).join('\n');
}
function normalizedUsage(value, names) {
  if (!value || typeof value !== 'object') return null;
  const values = Object.fromEntries(Object.entries(names).map(([key, field]) => [key, number(value[field])]));
  return Object.values(values).some(value => value !== null) ? values : null;
}
const nativeNames = { input: 'input_tokens', output: 'output_tokens', cached: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens' };
function readRows(raw, format) {
  if (format === 'json') {
    let document;
    try { document = JSON.parse(raw); } catch { throw fail('AI_TOOLS_SESSION_FORMAT', '会话 JSON 格式无效'); }
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw fail('AI_TOOLS_SESSION_FORMAT', '会话 JSON 必须为对象');
    return { document, rows: Array.isArray(document.messages) ? document.messages.slice(0, 20000) : [], invalid: 0, incomplete: document.messages?.length > 20000 };
  }
  const rows = []; let invalid = 0; let start = 0; let lineCount = 0;
  while (start < raw.length) {
    if (++lineCount > 20000) return { document: null, rows, invalid, incomplete: true };
    const end = raw.indexOf('\n', start); const line = raw.slice(start, end < 0 ? raw.length : end); start = end < 0 ? raw.length : end + 1;
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > 2 * 1024 * 1024) { invalid++; continue; }
    try { const row = JSON.parse(line); if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row); else invalid++; }
    catch { invalid++; }
  }
  return { document: null, rows, invalid };
}

/** Read-only views: source text is never interpreted as markup, instructions or executable commands. */
function parseSession(raw, toolId, format = 'jsonl') {
  if (typeof raw !== 'string' || raw.includes('\0')) throw fail('AI_TOOLS_SESSION_FORMAT', '会话不是有效文本');
  const decoded = readRows(raw, format); const messages = []; const seenMessages = new Set(); const usages = new Map();
  const meta = { sessionId: '', cwd: '', model: '', title: '', startedAt: null, updatedAt: null };
  let clipped = Boolean(decoded.incomplete); let characters = 0; let codexTotal = null; let codexCounterSeen = false;
  const addUsage = (id, usage, model) => { if (usage) usages.set(short(id), { ...usage, model: short(model) || meta.model || '未知模型' }); };
  const addMessage = (id, role, value, timestamp) => {
    if (!['user', 'assistant', 'system', 'tool'].includes(role)) return;
    const body = content(value); if (!body) return;
    if (id && seenMessages.has(id)) return;
    if (id) seenMessages.add(id);
    if (role === 'user' && !meta.title) meta.title = body.replace(/\s+/g, ' ').slice(0, 160);
    const ts = time(timestamp); if (ts !== null) { meta.startedAt = meta.startedAt === null ? ts : Math.min(meta.startedAt, ts); meta.updatedAt = meta.updatedAt === null ? ts : Math.max(meta.updatedAt, ts); }
    if (messages.length >= 2000 || characters >= 1024 * 1024) { clipped = true; return; }
    const shown = body.slice(0, Math.min(16000, 1024 * 1024 - characters)); characters += shown.length;
    messages.push({ id: short(String(id || messages.length)), role, text: shown, timestamp: ts, truncated: body.length > shown.length });
  };
  let rows = decoded.rows;
  if (toolId === 'gemini') {
    let doc = decoded.document || {}; const byId = new Map();
    if (!decoded.document) {
      for (const row of rows) {
        if (row.$set && typeof row.$set === 'object') { doc = { ...doc, ...row.$set }; if (Array.isArray(row.$set.messages)) { byId.clear(); for (const item of row.$set.messages) if (item?.id) byId.set(item.id, item); } }
        else if (row.id && row.type) byId.set(row.id, row);
        else { doc = { ...doc, ...row }; if (Array.isArray(row.messages)) { byId.clear(); for (const item of row.messages) if (item?.id) byId.set(item.id, item); } }
      }
      rows = [...byId.values()];
    }
    meta.sessionId = short(doc.sessionId); meta.cwd = short(doc.cwd, 4096); meta.startedAt = time(doc.startTime); meta.updatedAt = time(doc.lastUpdated);
  }
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]; if (!row || typeof row !== 'object') continue;
    if (toolId === 'codex') {
      const payload = row.payload || {};
      if (row.type === 'session_meta') { meta.sessionId = short(payload.id); meta.cwd = short(payload.cwd, 4096); }
      if (row.type === 'turn_context') { meta.model = short(payload.model) || meta.model; meta.cwd = short(payload.cwd, 4096) || meta.cwd; }
      if (row.type === 'response_item' && payload.type === 'message') addMessage(payload.id, payload.role, payload.content, row.timestamp);
      if (row.type === 'event_msg' && payload.type === 'token_count' && payload.info?.total_token_usage) {
        const next = normalizedUsage(payload.info.total_token_usage, { input: 'input_tokens', output: 'output_tokens', cached: 'cached_input_tokens', cacheWrite: 'cache_write_input_tokens' });
        if (next) {
          // Cumulative counters are not individual requests. Repeated snapshots add nothing;
          // a reset starts a new segment rather than silently subtracting already seen usage.
          const delta = Object.fromEntries(Object.entries(next).map(([key, value]) => [key, value === null ? null : codexTotal?.[key] !== null && codexTotal?.[key] !== undefined && value >= codexTotal[key] ? value - codexTotal[key] : value]));
          addUsage(`counter-${index}`, delta, meta.model); codexTotal = { ...codexTotal, ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== null)) }; codexCounterSeen = true;
        }
      }
    } else if (toolId === 'claude') {
      meta.sessionId = short(row.sessionId) || meta.sessionId; meta.cwd = short(row.cwd, 4096) || meta.cwd;
      const message = row.message;
      if (message) { meta.model = short(message.model) || meta.model; addMessage(row.uuid || message.id, message.role || row.type, message.content, row.timestamp); if ((message.role || row.type) === 'assistant') addUsage(message.id || row.uuid || `row-${index}`, normalizedUsage(message.usage, nativeNames), message.model); }
    } else if (toolId === 'gemini') {
      meta.model = short(row.model) || meta.model;
      addMessage(row.id, row.type === 'gemini' ? 'assistant' : row.type, row.content, row.timestamp);
      if (row.type === 'gemini') addUsage(row.id || `row-${index}`, normalizedUsage(row.tokens, { input: 'input', output: 'output', cached: 'cached', cacheWrite: 'cacheWrite' }), row.model);
    } else if (toolId === 'pi') {
      if (row.type === 'session') { meta.sessionId = short(row.id); meta.cwd = short(row.cwd, 4096); }
      if (row.type === 'message' && row.message) {
        const message = row.message; meta.model = short(message.model) || meta.model;
        addMessage(row.id, message.role === 'toolResult' ? 'tool' : message.role, message.content, row.timestamp || message.timestamp);
        if (message.role === 'assistant') addUsage(row.id || `row-${index}`, normalizedUsage(message.usage, { input: 'input', output: 'output', cached: 'cacheRead', cacheWrite: 'cacheWrite' }), message.model);
      }
    }
  }
  // token_usage_record-only Codex logs cannot safely be added to token_count snapshots
  // without correlating turns. State this explicitly instead of inventing a billed total.
  const uncounted = toolId === 'codex' && !codexCounterSeen && rows.some(row => row.type === 'token_usage_record');
  const aggregated = summarizeUsage([{ toolId, usage: [...usages.values()] }]);
  return { ...meta, messages, usage: aggregated.models, invalidLines: decoded.invalid, truncated: clipped, usageIncomplete: uncounted || Boolean(decoded.incomplete) || aggregated.incomplete,
    note: uncounted ? '当前文件只有逐轮用量记录，未纳入累计统计' : '本地文件中的 token 统计，不代表服务商额度或最终账单' };
}

function summarizeUsage(sessions) {
  const models = new Map(); let sessionsWithUsage = 0; let incomplete = false;
  for (const session of sessions) {
    if (session.usage.length) sessionsWithUsage++;
    for (const usage of session.usage) {
      let key = `${session.toolId}:${usage.model}`; let model = usage.model;
      if (!models.has(key) && models.size >= 64) { key = `${session.toolId}:bounded-other`; model = '其他模型（受容量限制合并）'; incomplete = true; }
      const row = models.get(key) || { toolId: session.toolId, model, input: null, output: null, cached: null, cacheWrite: null, observations: 0 };
      row.observations++;
      for (const field of ['input', 'output', 'cached', 'cacheWrite']) if (usage[field] !== null && Number.isSafeInteger(usage[field])) row[field] = Math.min(Number.MAX_SAFE_INTEGER, (row[field] ?? 0) + usage[field]);
      models.set(key, row);
    }
  }
  return { sessionsWithUsage, models: [...models.values()], incomplete, note: '只统计本次读取到的本地会话；缓存 token 的计入方式因工具而异，不据此推算服务商余额。' };
}

module.exports = { parseSession, summarizeUsage };
