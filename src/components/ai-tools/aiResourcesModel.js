import { tr } from '../../shared/i18n.js';
export function mcpDraft(item) {
  return { id: item?.id, name: item?.name || '', description: item?.description || '', type: item?.type || 'stdio', command: item?.command || '',
    argsText: JSON.stringify(item?.args || [], null, 2), url: item?.url || '', secretMode: 'keep', secretText: '{}' };
}
function parseJson(text, label) { try { return JSON.parse(text); } catch { throw new Error(tr("{0}必须是有效 JSON", { 0: label })); } }
export function mcpInput(draft, original) {
  if (!draft.name.trim()) throw new Error(tr("请填写 MCP 名称"));
  if (!['stdio', 'http', 'sse'].includes(draft.type)) throw new Error(tr("请选择 MCP 传输类型"));
  const result = { ...(draft.id ? { id: draft.id } : {}), name: draft.name.trim(), description: draft.description || '', type: draft.type };
  const secretField = draft.type === 'stdio' ? 'env' : 'headers';
  if (draft.type === 'stdio') {
    if (!draft.command.trim()) throw new Error(tr("请填写 MCP 命令；保存不会执行它"));
    const args = parseJson(draft.argsText || '[]', tr("参数"));
    if (!Array.isArray(args) || args.length > 128 || args.some(value => typeof value !== 'string')) throw new Error(tr("参数必须是最多 128 项的 JSON 字符串数组"));
    result.command = draft.command; result.args = args;
  } else {
    let url; try { url = new URL(draft.url.trim()); } catch { throw new Error(tr("请输入完整 MCP 服务地址")); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(tr("MCP 地址不能包含登录信息、查询参数或片段"));
    if (original?.headerKeys?.length && original.url && new URL(original.url).origin !== url.origin && draft.secretMode === 'keep') throw new Error(tr("服务域名已变化，请替换或明确清除原请求头"));
    result.url = url.href;
  }
  if (draft.secretMode === 'clear') result[secretField] = null;
  else if (draft.secretMode === 'replace') {
    const values = parseJson(draft.secretText, secretField === 'env' ? tr("环境变量") : tr("请求头"));
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 64 || Object.values(values).some(value => typeof value !== 'string')) throw new Error(tr("环境变量或请求头必须是最多 64 项的 JSON 字符串对象"));
    if (Object.keys(values).some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error(tr("环境变量或请求头名称无效"));
    result[secretField] = values;
  } else if (draft.secretMode !== 'keep') throw new Error(tr("请选择明确的凭据保留方式"));
  return result;
}
export function promptInput(draft) {
  if (!draft.name.trim()) throw new Error(tr("请填写提示词名称"));
  const content = draft.content.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  if (!content.trim() || new TextEncoder().encode(content).byteLength > 128 * 1024 || content.includes('\0')) throw new Error(tr("提示词不能为空或超过 128 KiB"));
  if (content.includes('<!-- adb-workbench:prompt:start -->') || content.includes('<!-- adb-workbench:prompt:end -->')) throw new Error(tr("内容不能包含本应用保留标记"));
  return { ...(draft.id ? { id: draft.id } : {}), name: draft.name.trim(), description: draft.description || '', content };
}
