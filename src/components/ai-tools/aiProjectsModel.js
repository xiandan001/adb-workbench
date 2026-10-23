export function projectDraft(project, defaultTool = '') {
  return { id: project?.id, name: project?.name || '', toolId: project?.toolId || defaultTool, pinned: project?.pinned === true,
    path: project?.path || '', directoryToken: '', oldPath: project?.oldPath || '', needsRelocation: project?.needsRelocation === true };
}
export function projectInput(draft, tools) {
  if (!draft.name.trim() || draft.name.length > 100) throw new Error('请填写不超过 100 字的项目名称');
  if (!tools.some(tool => tool.id === draft.toolId)) throw new Error('请选择受支持的 CLI 工具');
  if (!draft.id && !draft.directoryToken) throw new Error('请通过选择按钮明确选择项目文件夹');
  return { ...(draft.id ? { id: draft.id } : {}), name: draft.name.trim(), toolId: draft.toolId, pinned: draft.pinned === true,
    ...(draft.directoryToken ? { directoryToken: draft.directoryToken } : {}) };
}
export function projectLaunchProvider(provider) {
  return provider.protocol === 'gemini' && provider.hasCredential === true && Boolean(provider.model) && provider.targetApps?.includes('agy');
}
