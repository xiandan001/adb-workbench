const { tr } = require('./localization.cjs');
const { validateArguments } = require('./ai-tools-policy.cjs');
const { fail } = require('./ai-tools-file-safety.cjs');

const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const START = '<!-- adb-workbench:prompt:start -->';
const END = '<!-- adb-workbench:prompt:end -->';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const clone = value => JSON.parse(JSON.stringify(value));
const keyFor = id => `awb_${id.replaceAll('-', '')}`;
const invalid = message => fail('AI_TOOLS_RESOURCE_INVALID', message);
function text(value, label, maximum, empty = false) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maximum || (!empty && !value.trim()) || Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw invalid(tr("{0}无效", { 0: label }));
  return value;
}
function validateId(id) { if (typeof id !== 'string' || !ID.test(id)) throw invalid(tr("资源标识无效")); return id; }
function fields(input, allowed) {
  const value = validateArguments(input);
  if (Object.keys(value).some(key => !allowed.includes(key))) throw invalid(tr("资源包含未知字段"));
  if (value.id !== undefined) validateId(value.id);
  return value;
}
function secretMap(input, kind) {
  if (input === null) return {};
  if (!plain(input) || Object.keys(input).length > 64) throw invalid(tr("环境变量或请求头无效"));
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (!(kind === 'env' ? /^[A-Za-z_][A-Za-z0-9_]{0,127}$/ : /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/).test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw invalid(tr("环境变量或请求头名称无效"));
    result[key] = text(value, tr("环境变量或请求头值"), 8192, true);
  }
  return result;
}
function normalizeMcp(input, existing) {
  const value = fields(input, ['id', 'name', 'description', 'type', 'command', 'args', 'url', 'env', 'headers']);
  if (!['stdio', 'http', 'sse'].includes(value.type)) throw invalid(tr("MCP 传输类型无效"));
  const result = { ...(value.id ? { id: value.id } : {}), name: text(value.name, tr("MCP 名称"), 120).trim(), description: text(value.description ?? '', tr("描述"), 2048, true), type: value.type };
  if (value.type === 'stdio') {
    result.command = text(value.command, tr("MCP 命令"), 2048);
    if (!Array.isArray(value.args ?? []) || (value.args?.length ?? 0) > 128) throw invalid(tr("MCP 参数无效"));
    result.args = (value.args ?? []).map(arg => text(arg, tr("MCP 参数"), 4096, true));
    if (value.url !== undefined || (value.headers !== undefined && value.headers !== null)) throw invalid(tr("本地 MCP 不能包含远程字段"));
    result.env = value.env === undefined ? clone(existing?.env || {}) : secretMap(value.env, 'env');
  } else {
    const raw = text(value.url, tr("MCP 地址"), 2048); let url;
    try { url = new URL(raw); } catch { throw invalid(tr("MCP 地址无效")); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || raw.trim() !== raw) throw invalid(tr("MCP 地址不能包含密码、查询参数或片段，凭据请填写到请求头"));
    result.url = url.href;
    if (value.command !== undefined || value.args !== undefined || (value.env !== undefined && value.env !== null)) throw invalid(tr("远程 MCP 不能包含本地字段"));
    if (existing?.headers && Object.keys(existing.headers).length && value.headers === undefined && existing.url && new URL(existing.url).origin !== url.origin) throw fail('AI_TOOLS_CREDENTIAL_ORIGIN', tr("MCP 域名已变化，请重新填写或明确移除请求头，不会转发旧凭据"));
    result.headers = value.headers === undefined ? clone(existing?.headers || {}) : secretMap(value.headers, 'headers');
  }
  return result;
}
function normalizePrompt(input) {
  const value = fields(input, ['id', 'name', 'description', 'content']);
  if (typeof value.content !== 'string' || !value.content.trim() || Buffer.byteLength(value.content) > 128 * 1024 || value.content.includes('\0') || value.content.includes(START) || value.content.includes(END)) throw invalid(tr("提示词内容为空、超过 128 KiB 或包含保留标记"));
  return { ...(value.id ? { id: value.id } : {}), name: text(value.name, tr("提示词名称"), 120).trim(), description: text(value.description ?? '', tr("描述"), 2048, true), content: value.content.replaceAll('\r\n', '\n').replaceAll('\r', '\n') };
}
function publicMcp(value, applications = []) {
  const result = clone(value); delete result.env; delete result.headers;
  return { ...result, key: keyFor(value.id), envKeys: Object.keys(value.env || {}), headerKeys: Object.keys(value.headers || {}), hasSecrets: Boolean(Object.keys(value.env || {}).length || Object.keys(value.headers || {}).length), applications: applications.filter(row => row.kind === 'mcp' && row.resourceId === value.id).map(row => row.toolId) };
}
function publicPrompt(value, applications = []) { return { ...clone(value), applications: applications.filter(row => row.kind === 'prompt' && row.resourceId === value.id).map(row => row.toolId) }; }

module.exports = { ID, START, END, plain, clone, keyFor, validateId, normalizeMcp, normalizePrompt, publicMcp, publicPrompt };
