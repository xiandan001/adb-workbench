export function skillActionEnabled(can, command, { recoveryOnly = false, restoring = false } = {}) {
  if (recoveryOnly && !['skills_backups_list', 'skills_backup_preview_restore'].includes(command) && !(command === 'skills_apply' && restoring)) return false;
  return Boolean(can?.(command, { restoring }));
}
export function skillInstallation(skill, toolId) {
  return skill.installations?.find(row => row.toolId === toolId) || null;
}
export function skillApplyRequest(preview, now = Date.now()) {
  if (!preview || typeof preview.token !== 'string' || !preview.token || !['install', 'uninstall', 'restore'].includes(preview.operation)) throw new Error('技能预览无效，请重新预览');
  if (!Number.isFinite(preview.expiresAt) || preview.expiresAt <= now) throw new Error('技能预览已过期，请关闭后重新预览');
  return { command: 'skills_apply', args: { token: preview.token }, options: { restoring: preview.operation === 'restore' } };
}
export function skillChangeSummary(preview) {
  const changes = Array.isArray(preview.changes) ? preview.changes : [];
  return { add: changes.filter(row => row.action === 'add').length, remove: changes.filter(row => row.action === 'remove').length,
    replace: changes.filter(row => row.action === 'replace').length, total: changes.length, shown: changes.slice(0, 100), hidden: Math.max(0, changes.length - 100) };
}
export function createSkillsRequestGate() {
  let active = true; let scope; let generation = 0; let pending = null;
  return {
    setActive(value, nextScope) { if (active !== value || scope !== nextScope) { generation++; pending = null; } active = value; scope = nextScope; },
    start() { if (!active || pending) return null; pending = { generation }; return pending; },
    current(token) { return active && pending === token && token.generation === generation; },
    finish(token) { if (pending !== token) return false; pending = null; return true; },
  };
}

export async function executeSkillMutation(onRequest, command, args, options, refresh) {
  const result = await onRequest(command, args, options);
  if (result?.cancelled) return { result, data: null, refreshError: '' };
  try { return { result, data: await refresh(), refreshError: '' }; }
  catch (error) { return { result, data: null, refreshError: error.message || '列表刷新失败' }; }
}
