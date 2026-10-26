export const AI_WORKSPACE_MODES = ['diagnose', 'analysis', 'task'];

export function createWorkspaceCase(mode, deviceId, caseId) {
  return { mode, caseId, revision: 0, question: '', deviceId: deviceId || '', checks: [], sourceIds: [], text: '',
    plan: null, planUsage: null, preview: null, result: null, draft: null, usage: null, cached: false, error: '', busy: '' };
}

export function editWorkspaceCase(current, changes) {
  if (current.busy) return current;
  return { ...current, ...changes, revision: current.revision + 1, preview: null, result: null, draft: null, usage: null,
    cached: false, error: '', ...(Object.hasOwn(changes, 'question') || Object.hasOwn(changes, 'deviceId') ? { plan: null, planUsage: null } : {}) };
}

export function workspaceRequestCurrent(current, token) {
  return Boolean(current && token && current.caseId === token.caseId && current.revision === token.revision && current.busy === token.operation);
}

export function toggleWorkspaceSelection(values, value) {
  return values.includes(value) ? values.filter(item => item !== value) : [...values, value];
}

export function workspaceDeviceOnline(devices, id) {
  return Boolean(id && devices.some(device => device.id === id && device.status === 'device'));
}

export function workspacePreviewFresh(preview, now = Date.now()) {
  const expiresAt = typeof preview?.expiresAt === 'string' ? Date.parse(preview.expiresAt) : preview?.expiresAt;
  return Boolean(preview?.id && Number.isFinite(expiresAt) && expiresAt > now);
}
