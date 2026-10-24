const { tr } = require('./localization.cjs');
const jsonc = require('jsonc-parser');
const toml = require('smol-toml');
const fields = require('../assets/ai-cli-config-fields.json');
const { fail } = require('./ai-tools-file-safety.cjs');

const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const error = message => fail('AI_TOOLS_CLI_CONFIG_INVALID', message);
const SECRET = /\b(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9]{20,}|Bearer\s+\S+|eyJ[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)/i;
function text(value, limit, label) {
  if (typeof value !== 'string' || value.length > limit || Array.from(value).some(char => char.charCodeAt(0) < 32 && !['\n', '\t'].includes(char) || char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159) || SECRET.test(value)) throw error(tr("{0}含无效内容、疑似凭据或超出长度限制", { 0: label }));
  return value;
}
function exact(value, allowed, label) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) throw error(tr("{0}包含不支持的字段；凭据、权限、Hooks、MCP 和执行命令请使用各自独立配置，不会在这里自动覆盖", { 0: label }));
}
function scalar(value, descriptor) {
  if (value === null) return null;
  if (descriptor.type === 'integer' && Number.isSafeInteger(value) && value >= descriptor.min && value <= descriptor.max) return value;
  if (descriptor.type === 'boolean' && typeof value === 'boolean') return value;
  if (descriptor.type === 'enum' && descriptor.values.includes(value)) return value;
  if (descriptor.type === 'text' && typeof value === 'string') return text(value, descriptor.max || 256, descriptor.label || tr("补充配置"));
  throw error(tr("{0}的值无效", { 0: descriptor.label || tr("补充配置") }));
}
function parseSettingsJson(value) {
  text(value, 65536, tr("Claude 补充 JSON"));
  const errors = []; const tree = jsonc.parseTree(value.trim() || '{}', errors, { allowTrailingComma: true });
  if (errors.length || tree?.type !== 'object') throw error(tr("Claude 补充配置需要有效的 JSON/JSONC 对象"));
  const visit = node => {
    if (node.type === 'object') {
      const seen = new Set();
      for (const property of node.children || []) { const key = property.children[0].value; if (seen.has(key)) throw error(tr("Claude 补充 JSON 包含重复字段")); seen.add(key); }
    }
    for (const child of node.children || []) visit(child);
  };
  visit(tree); return jsonc.getNodeValue(tree);
}
const BOOL = { type: 'boolean' }; const STR = { type: 'text', max: 256 };
const CLAUDE_EXTRA = { language: STR, outputStyle: STR, alwaysThinkingEnabled: BOOL, respectGitignore: BOOL, showTurnDuration: BOOL, spinnerTipsEnabled: BOOL, terminalProgressBarEnabled: BOOL,
  teammateMode: { type: 'enum', values: ['auto', 'in-process', 'tmux'] }, attribution: { commit: { type: 'text', max: 1024 }, pr: { type: 'text', max: 1024 } } };
const CODEX_EXTRA = { hide_agent_reasoning: BOOL, show_raw_agent_reasoning: BOOL, check_for_update_on_startup: BOOL,
  file_opener: { type: 'enum', values: ['vscode', 'vscode-insiders', 'windsurf', 'cursor', 'none'] }, project_doc_max_bytes: { type: 'integer', min: 1, max: 16777216 },
  history: { persistence: { type: 'enum', values: ['save-all', 'none'] }, max_bytes: { type: 'integer', min: 1, max: 2147483647 } },
  tui: { animations: BOOL, alternate_screen: { type: 'enum', values: ['auto', 'always', 'never'] } }, feedback: { enabled: BOOL } };
function validateSupplement(value, schema, prefix = []) {
  exact(value, Object.keys(schema), tr("原生补充配置")); const result = [];
  for (const [key, item] of Object.entries(value)) {
    const descriptor = schema[key]; const keys = [...prefix, key];
    if (descriptor.type) result.push({ keys, value: scalar(item, descriptor) });
    else result.push(...validateSupplement(item, descriptor, keys));
  }
  return result;
}
function claudeSupplement(value) { return validateSupplement(parseSettingsJson(value), CLAUDE_EXTRA); }
function codexSupplement(value) {
  text(value, 65536, tr("Codex 补充 TOML")); let parsed;
  try { parsed = toml.parse(value); } catch { throw error(tr("Codex 补充 TOML 格式无效或包含重复字段")); }
  return validateSupplement(parsed, CODEX_EXTRA);
}
function normalizeHeaders(value) {
  if (value === null) return null;
  const names = ['User-Agent', 'OpenAI-Organization', 'OpenAI-Project', 'HTTP-Referer', 'X-Title']; const allowed = names.map(name => name.toLowerCase());
  if (!plain(value) || Object.keys(value).length > allowed.length) throw error(tr("请求头必须是非敏感静态头对象"));
  const result = {}; const used = new Set();
  for (const [name, item] of Object.entries(value)) {
    if (!allowed.includes(name.toLowerCase()) || used.has(name.toLowerCase())) throw error(tr("仅支持 User-Agent、OpenAI-Organization、OpenAI-Project、HTTP-Referer、X-Title，不能填写认证头或重复请求头"));
    used.add(name.toLowerCase());
    if (item !== null && (typeof item !== 'string' || !item.trim() || item.length > 512 || !/^[\x20-\x7e]+$/.test(item) || SECRET.test(item))) throw error(tr("请求头值需要不含凭据的可见 ASCII 文本"));
    if (name.toLowerCase() === 'http-referer' && item !== null) {
      let url; try { url = new URL(item); } catch { throw error(tr("HTTP-Referer 需要完整 HTTPS 地址")); }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw error(tr("HTTP-Referer 不可含凭据、查询参数或片段"));
    }
    result[names[allowed.indexOf(name.toLowerCase())]] = item;
  }
  return result;
}
function normalizeCliConfig(value) {
  exact(value, ['claude', 'codex'], tr("CLI 高级配置")); const result = {};
  for (const [tool, options] of Object.entries(value)) {
    const extraKeys = tool === 'claude' ? ['settingsJson'] : ['httpHeaders', 'extraToml'];
    exact(options, [...fields[tool].map(row => row.key), ...extraKeys], tr("CLI 高级配置")); const next = {};
    for (const descriptor of fields[tool]) if (Object.hasOwn(options, descriptor.key)) next[descriptor.key] = scalar(options[descriptor.key], descriptor);
    if (tool === 'claude' && Object.hasOwn(options, 'settingsJson')) { claudeSupplement(options.settingsJson); next.settingsJson = options.settingsJson; }
    if (tool === 'codex') {
      if (Object.hasOwn(options, 'extraToml')) { codexSupplement(options.extraToml); next.extraToml = options.extraToml; }
      if (Object.hasOwn(options, 'httpHeaders')) next.httpHeaders = normalizeHeaders(options.httpHeaders);
    }
    result[tool] = next;
  }
  return result;
}
function claudeCliAssignments(value) {
  const options = value === undefined ? {} : normalizeCliConfig({ claude: value }).claude;
  const assignments = fields.claude.filter(row => row.native && Object.hasOwn(options, row.key)).map(row => ({ keys: row.native.split('.'), value: options[row.key] === null ? undefined : String(typeof options[row.key] === 'boolean' ? Number(options[row.key]) : options[row.key]) }));
  if (options.settingsJson) assignments.push(...claudeSupplement(options.settingsJson).map(row => ({ ...row, value: row.value === null ? undefined : row.value })));
  return assignments;
}
function codexCliAssignments(value) {
  const options = value === undefined ? {} : normalizeCliConfig({ codex: value }).codex;
  const assignments = fields.codex.filter(row => Object.hasOwn(options, row.key)).map(row => ({ keys: [row.native], value: options[row.key] === null ? undefined : options[row.key] }));
  if (options.extraToml) assignments.push(...codexSupplement(options.extraToml));
  return { assignments, ...(Object.hasOwn(options, 'httpHeaders') ? { httpHeaders: options.httpHeaders } : {}) };
}
function assertCliEndpoint(provider, toolId) {
  const url = new URL(provider.baseUrl); const route = url.pathname.toLowerCase();
  if (toolId === 'codex' && (provider.protocol !== 'openai-responses' || /\/(?:anthropic|messages)(?:\/|$)/.test(route) || url.hostname === 'api.anthropic.com')) throw fail('AI_TOOLS_CONFIG_PROTOCOL', tr("Codex 需要 OpenAI Responses 兼容地址，不能使用 Anthropic / Messages 地址；请填写服务商提供的 Responses 基础地址"));
  if (toolId === 'claude' && (provider.protocol !== 'anthropic' || /\/(?:responses|chat\/completions)(?:\/|$)/.test(route) || url.hostname === 'api.openai.com')) throw fail('AI_TOOLS_CONFIG_PROTOCOL', tr("Claude Code 需要 Anthropic Messages 兼容地址，不能使用 Responses / Chat Completions 地址"));
}

module.exports = { normalizeCliConfig, claudeCliAssignments, codexCliAssignments, assertCliEndpoint };
