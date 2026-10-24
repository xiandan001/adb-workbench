const { tr } = require('./localization.cjs');
const { fail } = require('./ai-tools-file-safety.cjs');

const ROLES = Object.freeze(['sonnet', 'opus', 'fable', 'haiku', 'subagent']);
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function text(value, label, max) {
  const controls = typeof value === 'string' && Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159);
  if (typeof value !== 'string' || value.length > max || controls) throw fail('AI_TOOLS_PROVIDER_INVALID', tr("{0}无效", { 0: label }));
  return value.trim();
}

function normalizeClaudeModels(value) {
  if (!plain(value) || Object.keys(value).some(key => !ROLES.includes(key))) throw fail('AI_TOOLS_PROVIDER_INVALID', tr("Claude 模型角色配置无效"));
  const result = {};
  for (const role of ROLES) {
    if (!Object.hasOwn(value, role)) continue;
    const row = value[role]; const keys = role === 'subagent' ? ['model', 'supports1m'] : ['model', 'displayName', 'supports1m'];
    if (!plain(row) || Object.keys(row).some(key => !keys.includes(key))) throw fail('AI_TOOLS_PROVIDER_INVALID', tr("Claude 模型角色字段无效"));
    const model = text(row.model, tr("Claude 模型 ID"), 256);
    if (RESERVED.has(model.replace(/(?:\[1m\])+$/i, ''))) throw fail('AI_TOOLS_PROVIDER_INVALID', tr("模型名称不能使用保留字段名"));
    const normalized = { model };
    if (row.displayName !== undefined) normalized.displayName = text(row.displayName, tr("Claude 模型显示名称"), 120);
    if (row.supports1m !== undefined) {
      if (typeof row.supports1m !== 'boolean') throw fail('AI_TOOLS_PROVIDER_INVALID', tr("Claude 1M 上下文声明必须为布尔值"));
      normalized.supports1m = row.supports1m;
    }
    result[role] = normalized;
  }
  return result;
}

function claudeModelAssignments(value) {
  if (value === undefined) return [];
  const models = normalizeClaudeModels(value); const assignments = [];
  for (const [role, row] of Object.entries(models)) {
    const field = role === 'subagent' ? 'CLAUDE_CODE_SUBAGENT_MODEL' : `ANTHROPIC_DEFAULT_${role.toUpperCase()}_MODEL`;
    const model = row.model && (row.supports1m === true ? `${row.model.replace(/(?:\[1m\])+$/i, '')}[1m]` : row.model);
    assignments.push({ keys: ['env', field], value: model || undefined });
    if (role !== 'subagent') assignments.push({ keys: ['env', `${field}_NAME`], value: row.model ? row.displayName || undefined : undefined });
  }
  return assignments;
}

module.exports = { normalizeClaudeModels, claudeModelAssignments };
