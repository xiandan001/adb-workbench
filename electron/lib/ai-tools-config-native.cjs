const { tr } = require('./localization.cjs');
// Native schemas verified against MIT-licensed CC Switch e4873bc8aa2555225d4867ec2f04b1290f1d21d9:
// grok_config.rs, pi_config/mod.rs, mcode_config.rs, kimi_config.rs. No OAuth/account adapters.
const { isDeepStrictEqual } = require('node:util');
const toml = require('smol-toml');
const { fail } = require('./ai-tools-file-safety.cjs');
const { parseYaml, patchYaml } = require('./ai-tools-config-yaml.cjs');
const { parseRanges, setJson5Path } = require('./ai-tools-config-json5.cjs');

const nativeApi = { 'openai-chat': 'openai-completions', 'openai-responses': 'openai-responses', anthropic: 'anthropic-messages', gemini: 'google-generative-ai' };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const ownId = provider => `awb_${provider.id.replaceAll('-', '')}`;
const contextRequired = provider => {
  if (!Number.isSafeInteger(provider.contextWindow) || provider.contextWindow < 1 || provider.contextWindow > 2147483647) throw fail('AI_TOOLS_CONFIG_CONTEXT', tr("此工具要求明确的模型上下文上限，请按服务商说明填写后预览"));
  return provider.contextWindow;
};

function parseToml(content) {
  try { return toml.parse(content); } catch { throw fail('AI_TOOLS_CONFIG_TOML', tr("TOML 配置格式无效，未修改")); }
}
function patchTables(content, parsed, plans, helpers) {
  const expected = structuredClone(parsed); let result = content; const changes = [];
  for (const { section, fields } of plans) {
    const keys = section ? section.split('.') : []; let original = parsed; let target = expected;
    for (const key of keys) {
      original = original?.[key];
      if (target[key] === undefined) target[key] = {};
      if (!object(target[key])) throw fail('AI_TOOLS_CONFIG_TOML', tr("受管理的 TOML 配置节不是普通表，未修改"));
      target = target[key];
    }
    result = helpers.patchTomlSection(result, section, fields, original);
    for (const [key, value] of Object.entries(fields)) {
      changes.push(helpers.change(section ? `${section}.${key}` : key, original?.[key], value, key === 'api_key'));
      target[key] = value;
    }
  }
  if (!isDeepStrictEqual(structuredClone(parseToml(result)), expected)) throw fail('AI_TOOLS_CONFIG_COMPLEX', tr("此 TOML 布局不能安全保留未管理字段，未修改"));
  return { content: result, format: 'toml', changes };
}

function grok(content, provider, helpers) {
  const context = contextRequired(provider); const id = ownId(provider); const parsed = parseToml(content);
  if (parsed.model?.[id]?.env_key !== undefined) throw fail('AI_TOOLS_CONFIG_AUTH', tr("此 Grok 模型表使用环境凭据引用，请先明确凭据来源"));
  return patchTables(content, parsed, [
    { section: 'models', fields: { default: id } },
    { section: `model.${id}`, fields: { model: provider.model, base_url: provider.baseUrl, name: provider.name, api_key: provider.apiKey, api_backend: 'responses', context_window: context } },
  ], helpers);
}

function kimi(content, provider, helpers) {
  const context = contextRequired(provider); const id = ownId(provider); const parsed = parseToml(content);
  const existing = parsed.providers?.[id]; const model = parsed.models?.[id];
  if (existing && ['oauth', 'api_key_env', 'env'].some(key => existing[key] !== undefined)) throw fail('AI_TOOLS_CONFIG_AUTH', tr("此 Kimi 供应商有原生登录或环境凭据引用，未覆盖"));
  if (model?.provider !== undefined && model.provider !== id) throw fail('AI_TOOLS_CONFIG_OWNER', tr("此 Kimi 模型属于其他供应商，未覆盖"));
  const types = { 'openai-chat': 'openai', 'openai-responses': 'openai_responses', anthropic: 'anthropic', gemini: 'google-genai' };
  const plans = [
    { section: `providers.${id}`, fields: { type: types[provider.protocol], base_url: provider.baseUrl, api_key: provider.apiKey } },
    { section: `models.${id}`, fields: { provider: id, model: provider.model, display_name: provider.model, max_context_size: context } },
  ];
  if (parsed.default_model === undefined || parsed.default_model === '') plans.unshift({ section: '', fields: { default_model: id } });
  return { ...patchTables(content, parsed, plans, helpers), warnings: [tr("Kimi 保留已有默认与辅助模型选择；若已有默认模型，请在 Kimi 中选择新登记的模型。")] };
}

function pi(content, provider, helpers) {
  // Pi treats !command and $NAME/${NAME} in apiKey as executable/dynamic credential sources.
  if (provider.apiKey.startsWith('!') || provider.apiKey.includes('$')) throw fail('AI_TOOLS_CONFIG_AUTH', tr("Pi 凭据包含命令或环境变量展开语法；这里只接受普通 API Key，不配置命令"));
  const parsed = helpers.parseJsonc(content); const id = ownId(provider); const existing = parsed.providers?.[id];
  if (existing?.models !== undefined && !Array.isArray(existing.models)) throw fail('AI_TOOLS_CONFIG_JSON', tr("Pi models 必须是数组，未覆盖"));
  const models = existing?.models || []; const matches = models.map((model, index) => model?.id === provider.model ? index : -1).filter(index => index >= 0);
  if (matches.length > 1) throw fail('AI_TOOLS_CONFIG_JSON', tr("Pi 模型列表包含重复标识，未修改"));
  const index = matches[0] ?? models.length; const model = models[index];
  if (model && ['api', 'apiKey', 'baseUrl'].some(key => model[key] !== undefined)) throw fail('AI_TOOLS_CONFIG_AUTH', tr("此 Pi 模型有独立协议、地址或凭据覆盖，请先核对后再应用"));
  const assignments = [
    { keys: ['providers', id, 'name'], value: provider.name },
    { keys: ['providers', id, 'baseUrl'], value: provider.baseUrl },
    { keys: ['providers', id, 'api'], value: nativeApi[provider.protocol] },
    { keys: ['providers', id, 'apiKey'], value: provider.apiKey, secret: true },
  ];
  if (model) {
    assignments.push({ keys: ['providers', id, 'models', index, 'name'], value: provider.model });
    if (provider.contextWindow !== undefined) assignments.push({ keys: ['providers', id, 'models', index, 'contextWindow'], value: provider.contextWindow });
  } else {
    const newModel = { id: provider.model, name: provider.model, ...(provider.contextWindow === undefined ? {} : { contextWindow: provider.contextWindow }) };
    assignments.push({ keys: ['providers', id, 'models', index], value: newModel });
  }
  return { ...helpers.patchJson(content, assignments), warnings: [tr("Pi 只登记供应商和模型，不改 settings.json/auth.json；请在 Pi 的 /model 中选择需要的模型。")] };
}

function mcode(content, provider, helpers) {
  const document = parseYaml(content); const { original } = document;
  const id = ownId(provider); const existing = original.custom_provider?.[id];
  if (existing?.kind !== undefined && existing.kind !== 'custom') throw fail('AI_TOOLS_CONFIG_OWNER', tr("此 MCode 供应商由账号系统拥有，未覆盖 account 配置"));
  const assignments = [
    { keys: ['custom_provider', id, 'name'], value: provider.name },
    { keys: ['custom_provider', id, 'kind'], value: 'custom' },
    { keys: ['custom_provider', id, 'enabled'], value: true },
    { keys: ['custom_provider', id, 'api'], value: nativeApi[provider.protocol] },
    { keys: ['custom_provider', id, 'options', 'baseURL'], value: provider.baseUrl },
    { keys: ['custom_provider', id, 'options', 'apiKey'], value: provider.apiKey, secret: true },
    { keys: ['custom_provider', id, 'models', provider.model, 'name'], value: provider.model },
  ];
  return { ...patchYaml(document, assignments, helpers.change), warnings: [tr("MCode 只登记自定义供应商，保留 defaultModel/defaultLightModel；请在 MCode 内选择需要的模型。")] };
}

function hermes(content, provider, helpers) {
  const document = parseYaml(content); const { original } = document; const id = ownId(provider);
  if (original.custom_providers !== undefined && !Array.isArray(original.custom_providers)) throw fail('AI_TOOLS_CONFIG_YAML', tr("Hermes custom_providers 必须是列表"));
  if (original.providers?.[id] !== undefined) throw fail('AI_TOOLS_CONFIG_OWNER', tr("Hermes 原生 providers 字典已拥有此标识，未覆盖账号配置"));
  const rows = original.custom_providers || [];
  const indices = rows.map((row, index) => row?.name === id ? index : -1).filter(index => index >= 0);
  if (indices.length > 1) throw fail('AI_TOOLS_CONFIG_YAML', tr("Hermes 供应商标识重复，未修改"));
  const index = indices[0] ?? rows.length;
  if (rows[index]?.key_env !== undefined) throw fail('AI_TOOLS_CONFIG_AUTH', tr("此 Hermes 供应商配置了环境凭据引用，未覆盖"));
  const previousModel = rows[index]?.models?.[provider.model];
  if (previousModel !== undefined && !object(previousModel)) throw fail('AI_TOOLS_CONFIG_YAML', tr("Hermes 模型元数据必须是对象"));
  const modes = { 'openai-chat': 'chat_completions', 'openai-responses': 'codex_responses', anthropic: 'anthropic_messages' };
  const assignments = [
    { keys: ['custom_providers', index, 'name'], value: id },
    { keys: ['custom_providers', index, 'base_url'], value: provider.baseUrl },
    { keys: ['custom_providers', index, 'api_key'], value: provider.apiKey, secret: true },
    { keys: ['custom_providers', index, 'api_mode'], value: modes[provider.protocol] },
    { keys: ['custom_providers', index, 'model'], value: provider.model },
  ];
  if (provider.contextWindow !== undefined) assignments.push({ keys: ['custom_providers', index, 'models', provider.model, 'context_length'], value: provider.contextWindow });
  else if (previousModel === undefined) assignments.push({ keys: ['custom_providers', index, 'models', provider.model], value: {} });
  return { ...patchYaml(document, assignments, helpers.change), warnings: [tr("Hermes 只登记自定义供应商，保留原有默认模型与账号字典；请在 Hermes 中选择新模型。")] };
}

function openclaw(content, provider, helpers) {
  const { value } = parseRanges(content); const id = ownId(provider); const old = value.models?.providers?.[id];
  if (old !== undefined && !object(old)) throw fail('AI_TOOLS_CONFIG_JSON5', tr("OpenClaw 供应商不是普通对象"));
  if (old?.models !== undefined && !Array.isArray(old.models)) throw fail('AI_TOOLS_CONFIG_JSON5', tr("OpenClaw models 必须是列表"));
  const models = structuredClone(old?.models || []); const matches = models.map((row, index) => row?.id === provider.model ? index : -1).filter(index => index >= 0);
  if (matches.length > 1) throw fail('AI_TOOLS_CONFIG_JSON5', tr("OpenClaw 模型标识重复"));
  const index = matches[0] ?? models.length;
  models[index] = { ...(models[index] || {}), id: provider.model, name: provider.model, ...(provider.contextWindow === undefined ? {} : { contextWindow: provider.contextWindow }) };
  const next = { ...(old || {}), baseUrl: provider.baseUrl, apiKey: provider.apiKey, api: nativeApi[provider.protocol], models };
  const warnings = [tr("OpenClaw 保留 agents 默认模型、工具、网关及工作区设置；只登记本次供应商与模型。")];
  if (isDeepStrictEqual(old, next)) return { content, format: 'json5', changes: [], warnings };
  let result = content;
  if (value.models === undefined) result = setJson5Path(content, ['models'], { mode: 'merge', providers: { [id]: next } });
  else result = setJson5Path(content, ['models', 'providers', id], next);
  return { content: result, format: 'json5', changes: [
    helpers.change(`models.providers.${id}.baseUrl`, old?.baseUrl, provider.baseUrl),
    helpers.change(`models.providers.${id}.api`, old?.api, nativeApi[provider.protocol]),
    helpers.change(`models.providers.${id}.apiKey`, old?.apiKey, provider.apiKey, true),
    helpers.change(`models.providers.${id}.models`, old?.models?.map(row => row?.id), models.map(row => row.id)),
  ], warnings };
}

function projectNativeConfig(toolId, content, provider, helpers) {
  if (toolId === 'grokbuild') return grok(content, provider, helpers);
  if (toolId === 'kimi') return kimi(content, provider, helpers);
  if (toolId === 'pi') return pi(content, provider, helpers);
  if (toolId === 'mcode') return mcode(content, provider, helpers);
  if (toolId === 'hermes') return hermes(content, provider, helpers);
  if (toolId === 'openclaw') return openclaw(content, provider, helpers);
  throw fail('AI_TOOLS_CONFIG_UNSUPPORTED', tr("该工具的配置适配尚未完成"));
}

module.exports = { projectNativeConfig };
