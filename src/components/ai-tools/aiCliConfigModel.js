import { tr } from '../../shared/i18n.js';
import fields from '../../../electron/assets/ai-cli-config-fields.json' with { type: 'json' };
import { parseTree, getNodeValue } from 'jsonc-parser';

export const AI_CLI_CONFIG_FIELDS = fields;
export function cliConfigDraft(value) {
  if (value === undefined) return undefined;
  const draft = structuredClone(value);
  if (draft.codex && Object.hasOwn(draft.codex, 'httpHeaders')) {
    draft.codex.httpHeadersText = JSON.stringify(draft.codex.httpHeaders, null, 2); delete draft.codex.httpHeaders;
  }
  return draft;
}
export function updateCliOption(value, tool, key, item) {
  const next = { ...(value || {}), [tool]: { ...(value?.[tool] || {}) } };
  if (item === undefined) delete next[tool][key]; else next[tool][key] = item;
  return next;
}
function headersFromText(value) {
  if (!value.trim()) return undefined;
  const errors = []; const tree = parseTree(value, errors, { allowTrailingComma: true });
  if (errors.length || !tree || !['object', 'null'].includes(tree.type)) throw new Error(tr("请求头需要 JSON 对象，或用 null 明确清除全部自定义头"));
  const seen = new Set();
  for (const property of tree.children || []) {
    const key = property.children[0].value.toLowerCase(); if (seen.has(key)) throw new Error(tr("请求头不能包含重复字段")); seen.add(key);
  }
  return structuredClone(getNodeValue(tree));
}
function integerProblem(row) {
  const range = { 0: row.min, 1: row.max };
  switch (row.key) {
    case 'timeoutMs': return tr('请求超时（毫秒）需要 {0}–{1} 的整数', range);
    case 'maxOutputTokens': return tr('最大输出 Token需要 {0}–{1} 的整数', range);
    case 'maxThinkingTokens': return tr('思考 Token 预算需要 {0}–{1} 的整数', range);
    case 'contextTokens': case 'contextWindow': return tr('上下文 Token 上限需要 {0}–{1} 的整数', range);
    case 'autoCompactPercent': return tr('自动压缩阈值（%）需要 {0}–{1} 的整数', range);
    case 'autoCompactTokenLimit': return tr('自动压缩 Token 阈值需要 {0}–{1} 的整数', range);
    default: return tr('数值需要 {0}–{1} 的整数', range);
  }
}
export function cliConfigInput(value) {
  if (value === undefined) return undefined;
  const result = {};
  for (const [tool, options] of Object.entries(value)) {
    if (!fields[tool]) throw new Error(tr("CLI 高级配置类型无效"));
    const next = { ...options };
    for (const row of fields[tool]) if (row.type === 'integer' && next[row.key] !== undefined && next[row.key] !== null) {
      const raw = String(next[row.key]); const number = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(number) || number < row.min || number > row.max) throw new Error(integerProblem(row));
      next[row.key] = number;
    }
    if (Object.hasOwn(next, 'httpHeadersText')) {
      const headers = headersFromText(next.httpHeadersText); delete next.httpHeadersText;
      if (headers !== undefined) next.httpHeaders = headers;
    }
    result[tool] = next;
  }
  return result;
}
export function cliEndpointError(protocol, baseUrl, targetApps) {
  let url; try { url = new URL(baseUrl); } catch { return ''; }
  if (protocol === 'openai-responses' && targetApps.includes('codex') && (/\/(?:anthropic|messages)(?:\/|$)/i.test(url.pathname) || url.hostname === 'api.anthropic.com')) return tr("Codex 需要 Responses 兼容基础地址，不能填写 Anthropic / Messages 地址。");
  if (protocol === 'anthropic' && targetApps.includes('claude') && (/\/(?:responses|chat\/completions)(?:\/|$)/i.test(url.pathname) || url.hostname === 'api.openai.com')) return tr("Claude Code 需要 Anthropic Messages 兼容基础地址，不能填写 Responses / Chat Completions 地址。");
  return '';
}
