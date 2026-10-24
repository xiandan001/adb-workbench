import { tr } from '../shared/i18n.js';
const aiDomains = () => [['providers', tr('AI 供应商与凭据')], ['mcpServers', 'MCP'], ['prompts', tr('提示词')], ['skills', tr('Skills 技能库')], ['projects', tr('AI 项目入口')], ['routes', tr('本地路由')], ['sessions', tr('AI 会话归档')]];
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function migrationPasswordProblem(password, confirmation, exporting) {
  if (typeof password !== 'string') return tr('请输入备份密码');
  const bytes = new TextEncoder().encode(password);
  if (bytes.length < 8 || bytes.length > 1024 || password.includes('\0') || new TextDecoder().decode(bytes) !== password) return tr('密码需要 8–1024 字节，不能包含空字符或无效字符');
  if (exporting && password !== confirmation) return tr('两次输入的密码不一致');
  return '';
}
export function migrationAiRows(summary) {
  if (summary?.encrypted !== true || !summary.ai || typeof summary.ai !== 'object') return [];
  return aiDomains().map(([key, label]) => {
    const value = summary.ai[key] || {}; const added = count(value.added); const skipped = count(value.skipped);
    return { key, label, added, skipped, count: count(value.count) ?? (added !== null && skipped !== null ? added + skipped : null),
      omitted: key === 'sessions' && summary.includesAiSessions === false };
  });
}
export function readMigrationPreview(result) {
  if (!result?.ok) throw new Error(typeof result?.error === 'string' ? result.error : tr('无法读取或解密备份文件'));
  if (result.passwordRequired === true) {
    if (typeof result.selectionToken !== 'string' || !result.selectionToken) throw new Error(tr('备份选择已失效，请重新选择文件'));
    return { kind: 'password', selectionToken: result.selectionToken, fileName: typeof result.fileName === 'string' ? result.fileName : tr('所选备份') };
  }
  if (typeof result.token !== 'string' || !result.token || !result.summary || typeof result.summary !== 'object' || Array.isArray(result.summary)) throw new Error(tr('备份预览格式无效，未执行导入'));
  return { kind: 'preview', value: result };
}
