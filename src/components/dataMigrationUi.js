const AI_DOMAINS = [['providers', 'AI 供应商与凭据'], ['mcpServers', 'MCP'], ['prompts', '提示词'], ['skills', 'Skills 技能库'], ['projects', 'AI 项目入口'], ['routes', '本地路由'], ['sessions', 'AI 会话归档']];
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function migrationPasswordProblem(password, confirmation, exporting) {
  if (typeof password !== 'string') return '请输入备份密码';
  const bytes = new TextEncoder().encode(password);
  if (bytes.length < 8 || bytes.length > 1024 || password.includes('\0') || new TextDecoder().decode(bytes) !== password) return '密码需要 8–1024 字节，不能包含空字符或无效字符';
  if (exporting && password !== confirmation) return '两次输入的密码不一致';
  return '';
}
export function migrationAiRows(summary) {
  if (summary?.encrypted !== true || !summary.ai || typeof summary.ai !== 'object') return [];
  return AI_DOMAINS.map(([key, label]) => {
    const value = summary.ai[key] || {}; const added = count(value.added); const skipped = count(value.skipped);
    return { key, label, added, skipped, count: count(value.count) ?? (added !== null && skipped !== null ? added + skipped : null),
      omitted: key === 'sessions' && summary.includesAiSessions === false };
  });
}
export function readMigrationPreview(result) {
  if (!result?.ok) throw new Error(typeof result?.error === 'string' ? result.error : '无法读取或解密备份文件');
  if (result.passwordRequired === true) {
    if (typeof result.selectionToken !== 'string' || !result.selectionToken) throw new Error('备份选择已失效，请重新选择文件');
    return { kind: 'password', selectionToken: result.selectionToken, fileName: typeof result.fileName === 'string' ? result.fileName : '所选备份' };
  }
  if (typeof result.token !== 'string' || !result.token || !result.summary || typeof result.summary !== 'object' || Array.isArray(result.summary)) throw new Error('备份预览格式无效，未执行导入');
  return { kind: 'preview', value: result };
}
