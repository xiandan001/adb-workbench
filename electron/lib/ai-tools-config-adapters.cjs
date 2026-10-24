const { tr } = require('./localization.cjs');
const { isDeepStrictEqual } = require('node:util');
const jsonc = require('jsonc-parser');
const toml = require('smol-toml');
const { fail } = require('./ai-tools-file-safety.cjs');
const { projectNativeConfig } = require('./ai-tools-config-native.cjs');
const { projectDesktopConfig } = require('./ai-tools-config-desktop.cjs');
const { claudeModelAssignments } = require('./ai-tools-claude-models.cjs');
const { claudeCliAssignments, assertCliEndpoint } = require('./ai-tools-cli-config.cjs');
const { projectCodexAdvanced } = require('./ai-tools-cli-config-projector.cjs');

const MASK = '******';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const ownId = provider => `awb_${provider.id.replaceAll('-', '')}`;
const get = (value, keys) => keys.reduce((current, key) => current?.[key], value);
const change = (field, before, after, secret = false) => ({ field, before: secret && before !== undefined ? MASK : before ?? null, after: secret && after !== undefined ? MASK : after ?? null, secret });

function parseJsonc(content) {
  const errors = []; const tree = jsonc.parseTree(content.trim() ? content : '{}', errors, { allowTrailingComma: true });
  if (errors.length || !tree || tree.type !== 'object') throw fail('AI_TOOLS_CONFIG_JSON', tr("JSON/JSONC 配置格式无效，未修改"));
  const visit = node => {
    if (node.type === 'object') {
      const seen = new Set();
      for (const property of node.children || []) {
        const key = property.children[0].value;
        if (seen.has(key)) throw fail('AI_TOOLS_CONFIG_JSON', tr("JSON/JSONC 配置包含重复字段，未修改"));
        seen.add(key);
      }
    }
    for (const child of node.children || []) visit(child);
  };
  visit(tree); return jsonc.getNodeValue(tree);
}

function patchJson(content, assignments) {
  const original = parseJsonc(content); let result = content.trim() ? content : '{}\n';
  const changes = [];
  for (const { keys, value, secret = false } of assignments) {
    for (let i = 1; i < keys.length; i += 1) {
      const parent = get(original, keys.slice(0, i));
      if (parent !== undefined && !(typeof keys[i] === 'number' ? Array.isArray(parent) : object(parent))) throw fail('AI_TOOLS_CONFIG_JSON', tr("目标配置字段不是对象，未覆盖现有数据"));
    }
    const before = get(original, keys);
    if (isDeepStrictEqual(before, value)) continue;
    result = jsonc.applyEdits(result, jsonc.modify(result, keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } }));
    changes.push(change(keys.join('.'), before, value, secret));
  }
  parseJsonc(result);
  return { content: result, format: 'jsonc', changes };
}

function claude(content, provider) {
  assertCliEndpoint(provider, 'claude');
  const original = parseJsonc(content);
  const authField = provider.cliConfig?.claude?.authField || 'ANTHROPIC_AUTH_TOKEN';
  const alternate = authField === 'ANTHROPIC_AUTH_TOKEN' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN';
  const assignments = [
    { keys: ['env', 'ANTHROPIC_BASE_URL'], value: provider.baseUrl },
    { keys: ['env', authField], value: provider.apiKey, secret: true },
    { keys: ['env', 'ANTHROPIC_MODEL'], value: provider.model },
    ...claudeModelAssignments(provider.claudeModels),
    ...claudeCliAssignments(provider.cliConfig?.claude),
  ];
  // Both credentials can affect client auth selection. Remove only the explicitly managed alternate key.
  if (original.env?.[alternate] !== undefined) assignments.push({ keys: ['env', alternate], value: undefined, secret: true });
  return patchJson(content, assignments);
}

// Track multiline strings so text that looks like a TOML table/key inside a value is never edited.
function tomlLines(content) {
  const lines = content.split(/(?<=\n)/); let quote = null; let multiline = false;
  return lines.map(text => {
    const normalStart = quote === null;
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (!quote) {
        if (c === '#') break;
        if (c === '"' || c === "'") { quote = c; multiline = text.slice(i, i + 3) === c.repeat(3); if (multiline) i += 2; }
      } else if (quote === '"' && c === '\\') i += 1;
      else if (c === quote) {
        if (!multiline) quote = null;
        else if (text.slice(i, i + 3) === quote.repeat(3)) { quote = null; multiline = false; i += 2; }
      }
    }
    return { text, normalStart };
  });
}

function scalarLine(line, value) {
  const eq = line.indexOf('='); let quoted = null; let comment = -1;
  for (let i = eq + 1; i < line.length; i += 1) {
    if (quoted === '"' && line[i] === '\\') { i += 1; continue; }
    if (quoted) { if (line[i] === quoted) quoted = null; }
    else if (line[i] === '"' || line[i] === "'") quoted = line[i];
    else if (line[i] === '#') { comment = i; break; }
  }
  if (value === undefined) return comment < 0 ? '' : `${line.slice(comment).trimEnd()}\n`;
  return `${line.slice(0, eq + 1)} ${tomlValue(value)}${comment < 0 ? '' : ` ${line.slice(comment).trimEnd()}`}\n`;
}

function tomlValue(value) {
  if (!object(value)) return JSON.stringify(value);
  if (Object.values(value).some(item => typeof item !== 'string')) throw fail('AI_TOOLS_CONFIG_TOML', tr("原有请求头不是字符串映射，未覆盖"));
  return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${JSON.stringify(item)}`).join(', ')} }`;
}

function patchTomlSection(content, section, updates, parsed) {
  const lines = tomlLines(content); let active = ''; let firstTable = lines.length;
  let sectionStart = section === '' ? 0 : -1; let sectionEnd = lines.length;
  const found = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const row = lines[i];
    if (!row.normalStart) continue;
    if (/^\s*\[/.test(row.text)) {
      firstTable = Math.min(firstTable, i);
      if (active === section && sectionStart !== -1) sectionEnd = Math.min(sectionEnd, i);
      const header = /^\s*\[([\w.-]+)\]\s*(?:#.*)?(?:\r?\n)?$/.exec(row.text);
      active = header ? header[1] : '<unmanaged>';
      if (active === section) { if (sectionStart !== -1 && section !== '') throw fail('AI_TOOLS_CONFIG_TOML', tr("TOML 配置节重复")); sectionStart = i + 1; sectionEnd = lines.length; }
      continue;
    }
    if (active !== section) continue;
    const assignment = /^\s*(?:([A-Za-z0-9_-]+)|"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)')\s*=/.exec(row.text);
    const key = assignment && (assignment[1] || assignment[2] || assignment[3]);
    if (!key || !Object.hasOwn(updates, key)) continue;
    if (row.text.includes('"""') || row.text.includes("'''")) throw fail('AI_TOOLS_CONFIG_COMPLEX', tr("受管理的 TOML 字段使用多行格式，请先简化该字段再预览"));
    found.add(key); row.text = scalarLine(row.text, updates[key]);
  }
  for (const key of Object.keys(updates)) {
    if (Object.hasOwn(parsed || {}, key) && !found.has(key)) throw fail('AI_TOOLS_CONFIG_COMPLEX', tr("TOML 配置使用不支持的内联或复杂字段写法，未修改"));
  }
  const missing = Object.entries(updates).filter(([key, value]) => !found.has(key) && value !== undefined).map(([key, value]) => `${key} = ${tomlValue(value)}\n`).join('');
  if (sectionStart === -1) {
    if (!missing) return content;
    return `${content}${content.endsWith('\n') || !content ? '' : '\n'}\n[${section}]\n${missing}`;
  }
  const insert = section === '' ? firstTable : sectionEnd;
  if (missing && insert > 0 && !lines[insert - 1].text.endsWith('\n')) lines[insert - 1].text += '\n';
  lines.splice(insert, 0, { text: missing });
  return lines.map(row => row.text).join('');
}

function codex(content, provider) {
  assertCliEndpoint(provider, 'codex');
  let parsed;
  try { parsed = toml.parse(content); } catch { throw fail('AI_TOOLS_CONFIG_TOML', tr("TOML 配置格式无效，未修改")); }
  if (parsed.profile !== undefined) throw fail('AI_TOOLS_CONFIG_PROFILE', tr("当前 Codex 已选择 profile 配置档，可能覆盖全局模型；请先取消该配置档或单独配置它"));
  const id = ownId(provider); const section = `model_providers.${id}`;
  const fields = { name: provider.name, base_url: provider.baseUrl, wire_api: 'responses', experimental_bearer_token: provider.apiKey, requires_openai_auth: false };
  if (parsed.model_providers !== undefined && !object(parsed.model_providers)) throw fail('AI_TOOLS_CONFIG_TOML', tr("model_providers 不是配置表"));
  const originalSection = parsed.model_providers?.[id];
  if (originalSection !== undefined && !object(originalSection)) throw fail('AI_TOOLS_CONFIG_TOML', tr("供应商配置表格式无效"));
  if (originalSection?.env_key !== undefined) throw fail('AI_TOOLS_CONFIG_AUTH', tr("此供应商表设置了 env_key，可能覆盖 API Key；请先明确凭据来源再应用"));
  if (originalSection?.auth !== undefined) throw fail('AI_TOOLS_CONFIG_AUTH', tr("此供应商表设置了命令式 auth，不能与直接 API Key 同时应用；请先在原生文件明确认证来源"));
  let result = patchTomlSection(content, '', { model: provider.model, model_provider: id }, parsed);
  result = patchTomlSection(result, section, fields, originalSection);
  const expected = structuredClone(parsed);
  expected.model = provider.model; expected.model_provider = id; expected.model_providers ||= {};
  expected.model_providers[id] = { ...(expected.model_providers[id] || {}), ...fields };
  const advanced = projectCodexAdvanced(result, provider, expected, { patchTomlSection, change }); result = advanced.content;
  for (const key of ['http_headers', 'env_http_headers']) if (Object.keys(expected.model_providers[id][key] || {}).some(name => /^(?:authorization|proxy-authorization|cookie|x-api-key|api-key)$/i.test(name))) throw fail('AI_TOOLS_CONFIG_AUTH', tr("此供应商已有额外认证请求头，可能覆盖 API Key；请先明确移除静态头或在原生文件处理环境认证头"));
  let actual;
  try { actual = toml.parse(result); } catch { throw fail('AI_TOOLS_CONFIG_COMPLEX', tr("此 TOML 布局暂不能安全保留，未修改")); }
  // smol-toml uses null-prototype maps. Compare cloned values, not parser-specific prototypes.
  if (!isDeepStrictEqual(structuredClone(actual), expected)) throw fail('AI_TOOLS_CONFIG_COMPLEX', tr("此 TOML 布局暂不能安全保留所有字段，未修改"));
  const changes = [change('model', parsed.model, provider.model), change('model_provider', parsed.model_provider, id), ...Object.entries(fields).map(([key, value]) => change(`${section}.${key}`, originalSection?.[key], value, key === 'experimental_bearer_token')), ...advanced.changes];
  return { content: result, format: 'toml', changes };
}

function geminiEnv(content, provider) {
  const values = { GEMINI_API_KEY: provider.apiKey, GOOGLE_GEMINI_BASE_URL: provider.baseUrl, GEMINI_MODEL: provider.model };
  const found = new Set(); const changes = []; let multilineQuote = null;
  const closesQuote = (text, quote, start) => {
    for (let i = start; i < text.length; i += 1) {
      if (quote === '"' && text[i] === '\\') { i += 1; continue; }
      if (text[i] === quote) return true;
    }
    return false;
  };
  const lines = content.split(/(?<=\n)/).map(line => {
    if (multilineQuote) { if (closesQuote(line, multilineQuote, 0)) multilineQuote = null; return line; }
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)(?:\r?\n)?$/.exec(line);
    if (!match) return line;
    const quote = ['"', "'", '`'].includes(match[2][0]) ? match[2][0] : null;
    if (quote && !closesQuote(match[2], quote, 1)) {
      if (Object.hasOwn(values, match[1])) throw fail('AI_TOOLS_CONFIG_ENV', tr("Gemini 环境字段使用多行或不完整格式，未修改"));
      multilineQuote = quote; return line;
    }
    if (!Object.hasOwn(values, match[1])) return line;
    const key = match[1];
    if (found.has(key)) throw fail('AI_TOOLS_CONFIG_ENV', tr("Gemini 环境文件包含重复的受管理字段，未修改"));
    if ((match[2].startsWith('"') && !/^"(?:[^"\\]|\\.)*"\s*(?:#.*)?$/.test(match[2])) || (match[2].startsWith("'") && !/^'[^']*'\s*(?:#.*)?$/.test(match[2]))) throw fail('AI_TOOLS_CONFIG_ENV', tr("Gemini 环境字段使用多行或不完整格式，未修改"));
    found.add(key); changes.push(change(key, match[2], values[key], key === 'GEMINI_API_KEY'));
    return `${key}=${JSON.stringify(values[key])}\n`;
  });
  if (multilineQuote) throw fail('AI_TOOLS_CONFIG_ENV', tr("Gemini 环境文件有未闭合的字符串，未修改"));
  let result = lines.join(''); if (result && !result.endsWith('\n')) result += '\n';
  for (const [key, value] of Object.entries(values)) if (!found.has(key)) { result += `${key}=${JSON.stringify(value)}\n`; changes.push(change(key, undefined, value, key === 'GEMINI_API_KEY')); }
  return { content: result, format: 'dotenv', changes };
}

function opencode(content, provider) {
  const parsed = parseJsonc(content); const v2 = parsed.providers !== undefined || parsed.provider === undefined;
  const root = v2 ? 'providers' : 'provider'; const id = ownId(provider);
  const packages = { 'openai-chat': '@ai-sdk/openai-compatible', 'openai-responses': '@ai-sdk/openai', anthropic: '@ai-sdk/anthropic', gemini: '@ai-sdk/google' };
  return patchJson(content, [
    { keys: [root, id, 'name'], value: provider.name },
    { keys: [root, id, v2 ? 'package' : 'npm'], value: packages[provider.protocol] },
    { keys: [root, id, v2 ? 'settings' : 'options', 'baseURL'], value: provider.baseUrl },
    { keys: [root, id, v2 ? 'settings' : 'options', 'apiKey'], value: provider.apiKey, secret: true },
    { keys: [root, id, 'models', provider.model, 'name'], value: provider.model },
    { keys: ['model'], value: `${id}/${provider.model}` },
  ]);
}

function projectConfig(toolId, role, content, provider) {
  if (!provider.apiKey || !provider.model) throw fail('AI_TOOLS_CONFIG_CREDENTIAL', tr("应用配置前请填写模型和 API Key；不会读取现有登录凭据"));
  if (['__proto__', 'prototype', 'constructor'].includes(provider.model)) throw fail('AI_TOOLS_CONFIG_MODEL', tr("模型名称不能使用保留字段名"));
  if (toolId === 'claude') return claude(content, provider);
  if (toolId === 'codex') return codex(content, provider);
  if (toolId === 'opencode') return opencode(content, provider);
  if (toolId === 'gemini') return role === 'env' ? geminiEnv(content, provider) : patchJson(content, [{ keys: ['security', 'auth', 'selectedType'], value: 'gemini-api-key' }]);
  if (toolId === 'claude-desktop') return projectDesktopConfig(role, content, provider, { patchJson, parseJsonc });
  return projectNativeConfig(toolId, content, provider, { patchJson, parseJsonc, patchTomlSection, change });
}

module.exports = { projectConfig, parseJsonc };
