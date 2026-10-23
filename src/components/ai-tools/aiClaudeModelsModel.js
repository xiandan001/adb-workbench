export const CLAUDE_MODEL_ROLES = Object.freeze([
  { id: 'sonnet', label: 'Sonnet' }, { id: 'opus', label: 'Opus' }, { id: 'fable', label: 'Fable' },
  { id: 'haiku', label: 'Haiku' }, { id: 'subagent', label: 'Subagent', description: '子任务模型，不显示在 /model 菜单' },
]);
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function field(value, max, label) {
  if (typeof value !== 'string' || value.length > max || Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159)) throw new Error(`${label}无效或超出长度限制`);
  return value.trim();
}
function modelId(value) {
  const model = field(value, 256, '模型 ID');
  if (reserved.has(model.replace(/(?:\[1m\])+$/i, ''))) throw new Error('模型 ID 不能使用保留字段名');
  return model;
}
export function cloneClaudeModels(value) {
  if (value === undefined) return undefined;
  if (!plain(value) || Object.keys(value).some(key => !CLAUDE_MODEL_ROLES.some(role => role.id === key))) throw new Error('Claude 模型角色配置无效');
  const result = {};
  for (const { id } of CLAUDE_MODEL_ROLES) {
    if (!Object.hasOwn(value, id)) continue;
    const row = value[id]; const keys = id === 'subagent' ? ['model', 'supports1m'] : ['model', 'displayName', 'supports1m'];
    if (!plain(row) || Object.keys(row).some(key => !keys.includes(key))) throw new Error('Claude 模型角色字段无效');
    result[id] = { model: modelId(row.model) };
    if (row.displayName !== undefined) result[id].displayName = field(row.displayName, 120, '模型显示名称');
    if (row.supports1m !== undefined) {
      if (typeof row.supports1m !== 'boolean') throw new Error('1M 上下文声明必须为勾选状态');
      result[id].supports1m = row.supports1m;
    }
  }
  return result;
}
export function modelConfigurationInput(value, { requireModel = false } = {}) {
  const model = modelId(value.model);
  if (requireModel && !model) throw new Error('请填写默认模型 ID，可手动输入服务商提供的模型名称');
  return { model, ...(value.claudeModels === undefined ? {} : { claudeModels: cloneClaudeModels(value.claudeModels) }) };
}
export function updateClaudeRole(value, role, patch) {
  if (!CLAUDE_MODEL_ROLES.some(row => row.id === role)) throw new Error('模型角色无效');
  const current = value?.[role] || { model: '', ...(role === 'subagent' ? {} : { displayName: '' }), supports1m: false };
  const next = { ...current, ...patch };
  if (patch.supports1m === false) next.model = next.model.replace(/(?:\[1m\])+$/i, '');
  return { ...(value || {}), [role]: next };
}
export function claudeRoleSupports1m(row) { return row?.supports1m === true || /\[1m\]$/i.test(row?.model || ''); }
export function fillClaudeRoles(value, defaultModel) {
  const model = modelId(defaultModel).replace(/(?:\[1m\])+$/i, '');
  if (!model) throw new Error('请先填写默认模型');
  const next = cloneClaudeModels(value) || {};
  for (const { id } of CLAUDE_MODEL_ROLES.filter(role => role.id !== 'subagent')) next[id] = { model, displayName: next[id]?.displayName || '', supports1m: false };
  return next;
}
export function modelCatalogOptions(models, search = '') {
  const needle = search.trim().toLocaleLowerCase(); const unique = new Map();
  for (const row of Array.isArray(models) ? models.slice(0, 5000) : []) {
    if (!row || typeof row.id !== 'string' || !row.id.trim()) continue;
    let id;
    try { id = modelId(row.id); } catch { continue; }
    const name = typeof row.name === 'string' ? row.name.slice(0, 256) : '';
    if (needle && !`${id} ${name}`.toLocaleLowerCase().includes(needle)) continue;
    unique.set(id, { value: id, label: name && name !== id ? `${name} · ${id}` : id });
  }
  return { options: [...unique.values()].slice(0, 200), count: unique.size };
}
export function providerModelReadBlockReason(draft, provider) {
  if (!provider?.id) return '请先保存供应商，再读取模型列表；也可直接手填模型。';
  if (draft.protocol !== provider.protocol || draft.baseUrl.trim().replace(/\/+$/, '') !== provider.baseUrl.replace(/\/+$/, '') || draft.apiKey.trim() || draft.clearKey) return '地址、协议或密钥已修改，请先保存后再读取模型列表。';
  if (!provider.hasCredential) return '请先保存 API 密钥，再读取模型列表。';
  return '';
}
export function modelReadFeedback(error) {
  if (error?.code === 'AI_TOOLS_MODELS_UNSUPPORTED') return { kind: 'warning', message: '此服务不提供模型列表，请手动填写服务商给出的模型 ID。这不代表密钥无效；保存和应用不受影响。' };
  return { kind: 'error', message: error?.message || '读取模型列表失败，仍可手动配置模型。' };
}
