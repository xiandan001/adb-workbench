const { createHash } = require('node:crypto');
const { tr } = require('./localization.cjs');
const { redactText } = require('./feedback-policy.cjs');

const LIMITS = Object.freeze({ requestBytes: 1280 * 1024, batchBytes: 8 * 1024 * 1024, requests: 16,
  pendingBatches: 6, responseBytes: 1024 * 1024, previewMs: 10 * 60 * 1000 });
const fail = (code, message) => Object.assign(new Error(message), { code });
function sanitize(text) {
  return redactText(text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''))
    .replace(/((?:--)?(?:password|passwd|api[_-]?key|access[_-]?token|secret)\s+)[^\s]+/gi, '$1[REDACTED]');
}
// This format is selected only by the main-owned workspace operation, never by
// request JSON or renderer input. Redact decoded leaves, not JSON escape syntax.
function sanitizeWorkspaceContent(content) {
  const invalid = () => fail('AI_SEND_INPUT', tr('AI 请求内容无效，未发送。'));
  let source, nodes = 0;
  try { source = JSON.parse(content); } catch { throw invalid(); }
  if (!source || Array.isArray(source) || typeof source !== 'object') throw invalid();
  const sensitive = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|authorization|cookie|token|secret|密码|激活码)$/i;
  const visit = (value, depth = 0) => {
    if (++nodes > 100000 || depth > 32) throw invalid();
    if (typeof value === 'string') {
      // Preserve evidence line positions, including multiline private-key masks.
      const masked = value.replace(/-----BEGIN [A-Z\d ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z\d ]*PRIVATE KEY-----|$)/g,
        block => block.split(/\r\n?|\n/).map(() => '[REDACTED]').join('\n'));
      return masked.replace(/\r\n?/g, '\n').split('\n').map(sanitize).join('\n');
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(item => visit(item, depth + 1));
    if (typeof value !== 'object') throw invalid();
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitive.test(key) ? '[REDACTED]' : visit(item, depth + 1)]));
  };
  return JSON.stringify(visit(source));
}
function prepareBody(body, { contentFormat } = {}) {
  if (typeof body !== 'string' || Buffer.byteLength(body) > LIMITS.requestBytes) throw fail('AI_SEND_LIMIT', tr('AI 请求超过 1.25 MiB，请缩小筛选范围；未发送或静默截断。'));
  let value;
  try { value = JSON.parse(body); } catch { throw fail('AI_SEND_INPUT', tr('AI 请求内容无效，未发送。')); }
  const allowed = ['model', 'messages', 'stream', 'stream_options', 'temperature', 'chat_template_kwargs', 'max_tokens'];
  if (!value || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))
    || typeof value.model !== 'string' || !value.model || value.model.length > 128 || typeof value.stream !== 'boolean'
    || !Array.isArray(value.messages) || !value.messages.length || value.messages.length > 128
    || value.temperature !== undefined && (!Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2)
    || value.max_tokens !== undefined && (!Number.isInteger(value.max_tokens) || value.max_tokens < 1 || value.max_tokens > 32768)
    || value.chat_template_kwargs !== undefined && (Object.keys(value.chat_template_kwargs || {}).join() !== 'enable_thinking' || typeof value.chat_template_kwargs.enable_thinking !== 'boolean')
    || value.stream_options !== undefined && (Object.keys(value.stream_options || {}).join() !== 'include_usage' || value.stream_options.include_usage !== true)) {
    throw fail('AI_SEND_INPUT', tr('AI 请求内容无效，未发送。'));
  }
  let redactions = 0;
  const messages = value.messages.map(message => {
    if (!message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string'
      || Object.keys(message).some(key => !['role', 'content'].includes(key))) throw fail('AI_SEND_INPUT', tr('AI 请求内容无效，未发送。'));
    const content = contentFormat === 'workspace-json' && message.role === 'user' ? sanitizeWorkspaceContent(message.content) : sanitize(message.content);
    if (content !== message.content) redactions++;
    return { role: message.role, content };
  });
  const normalized = { ...value, messages, ...(value.stream ? { stream_options: { include_usage: true } } : {}) };
  const serialized = JSON.stringify(normalized);
  const bytes = Buffer.byteLength(serialized);
  if (bytes > LIMITS.requestBytes) throw fail('AI_SEND_LIMIT', tr('AI 请求超过 1.25 MiB，请缩小筛选范围；未发送或静默截断。'));
  return { body: serialized, messages, bytes, redactions,
    digest: createHash('sha256').update(serialized).digest('hex'),
    estimatedInputTokens: Math.ceil(messages.reduce((sum, message) => sum + Buffer.byteLength(message.content), 0) / 3),
    parameters: { stream: normalized.stream, temperature: normalized.temperature ?? null,
      thinking: normalized.chat_template_kwargs?.enable_thinking === true, maxTokens: normalized.max_tokens ?? null } };
}
function prepareBatch(bodies, options) {
  if (!Array.isArray(bodies) || !bodies.length || bodies.length > LIMITS.requests
    || bodies.reduce((sum, body) => sum + (typeof body === 'string' ? Buffer.byteLength(body) : LIMITS.batchBytes + 1), 0) > LIMITS.batchBytes) {
    throw fail('AI_SEND_LIMIT', tr('AI 批次最多 16 个请求、8 MiB，请缩小筛选范围；未发送。'));
  }
  const requests = bodies.map(body => prepareBody(body, options));
  const bytes = requests.reduce((sum, request) => sum + request.bytes, 0);
  if (bytes > LIMITS.batchBytes) throw fail('AI_SEND_LIMIT', tr('AI 批次最多 16 个请求、8 MiB，请缩小筛选范围；未发送。'));
  return { requests, bytes, estimatedInputTokens: requests.reduce((sum, request) => sum + request.estimatedInputTokens, 0),
    redactions: requests.reduce((sum, request) => sum + request.redactions, 0) };
}
function readUsage(raw) {
  const valid = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000000;
  if (!valid(raw?.prompt_tokens) || !valid(raw?.completion_tokens)) return null;
  const total = raw.prompt_tokens + raw.completion_tokens;
  if (raw.total_tokens !== undefined && raw.total_tokens !== total) return null;
  return { inputTokens: raw.prompt_tokens, outputTokens: raw.completion_tokens, totalTokens: total };
}
function stripPrivateTaskSnapshot({ text, truncated }) {
  const invalid = () => fail('AI_HANDOFF_PRIVATE_REPORT', tr('任务结果文件不完整或格式无效，不能安全排除私有脚本；请使用任务结果分析入口。'));
  if (truncated || typeof text !== 'string' || Buffer.byteLength(text) > 512 * 1024) throw invalid();
  let parsed;
  try { parsed = JSON.parse(text, (key, value) => key === 'rerunSnapshot' ? undefined : value); } catch { throw invalid(); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw invalid();
  return JSON.stringify(parsed, null, 2);
}
module.exports = { LIMITS, fail, sanitize, prepareBody, prepareBatch, readUsage, stripPrivateTaskSnapshot };
