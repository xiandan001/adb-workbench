import { tr } from '../../shared/i18n.js';
export function projectDraft(project, defaultTool = '') {
  return { id: project?.id, name: project?.name || '', toolId: project?.toolId || defaultTool, pinned: project?.pinned === true,
    path: project?.path || '', directoryToken: '', oldPath: project?.oldPath || '', needsRelocation: project?.needsRelocation === true };
}
export function projectInput(draft, tools) {
  if (!draft.name.trim() || draft.name.length > 100) throw new Error(tr("请填写不超过 100 字的项目名称"));
  if (!tools.some(tool => tool.id === draft.toolId)) throw new Error(tr("请选择受支持的 CLI 工具"));
  if (!draft.id && !draft.directoryToken) throw new Error(tr("请通过选择按钮明确选择项目文件夹"));
  return { ...(draft.id ? { id: draft.id } : {}), name: draft.name.trim(), toolId: draft.toolId, pinned: draft.pinned === true,
    ...(draft.directoryToken ? { directoryToken: draft.directoryToken } : {}) };
}
export function projectLaunchProvider(provider) {
  return provider.protocol === 'gemini' && provider.hasCredential === true && Boolean(provider.model) && provider.targetApps?.includes('agy');
}
export function projectQuickStartAvailable(detected, tools, can) {
  return typeof detected?.path === 'string' && Boolean(detected.path.trim()) && tools.some(tool => tool.id === detected.id)
    && ['projects_pick', 'projects_save', 'projects_launch_preview', 'projects_launch'].every(command => can(command));
}
export function createProjectScope() {
  let active = true; let generation = 0;
  return {
    setActive(value) { if (active !== value) generation++; active = value; },
    capture: () => active ? generation : null,
    current: token => active && token !== null && token === generation,
  };
}
export function projectPreviewFor(project, preview, now = Date.now()) {
  if (!preview?.token || preview.projectId !== project.id || preview.toolId !== project.toolId || !preview.executable || !preview.cwd) throw new Error(tr("启动预览与当前项目不一致，请重新预览"));
  if (!Number.isFinite(preview.expiresAt) || preview.expiresAt <= now) throw new Error(tr("启动预览已过期，请重新预览"));
  return preview;
}
