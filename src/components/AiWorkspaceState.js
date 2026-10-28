export const AI_WORKSPACE_MODES = ['diagnose', 'analysis', 'task'];
export const AI_WORKSPACE_TURN_LIMIT = 6;
export const workspaceSelection = () => ({ keywords: '', from: '', to: '', contextLines: 3, maxLines: 2000 });
export const workspaceRequirements = () => ({ application: '', preconditions: '', target: '', expectedResult: '' });
export const workspaceCaseReview = () => ({ status: 'unverified', rootCause: '', solution: '', verification: '', packageName: '', version: '', tags: [] });

export function createWorkspaceCase(mode, deviceId, caseId) {
  return { mode, caseId, revision: 0, question: '', deviceId: deviceId || '', checks: [], sourceIds: [], text: '',
    plan: null, planUsage: null, preview: null, result: null, draft: null, usage: null, cached: false, error: '', busy: '',
    selection: workspaceSelection(), selectionChanged: false, requirements: workspaceRequirements(), turns: [], reportView: null,
    contextRef: null, context: null, findingIndex: null, baseline: '', diagnostic: { packageName: '', symptom: '' },
    handoffId: '', handoff: null, targetSelection: { tokens: [] }, targets: [] };
}

export function completeWorkspaceTurn(current, response) {
  if (!response.turn?.id) return { ...current, result: response.result, usage: response.usage, cached: response.cached === true };
  const turn = response.turn;
  const turns = [turn, ...current.turns.filter(item => item.id !== turn.id)].slice(0, AI_WORKSPACE_TURN_LIMIT);
  return { ...current, turns, result: response.result, usage: response.usage, cached: response.cached === true,
    reportView: { report: turn, reportRef: { caseId: current.caseId, turnId: turn.id }, cached: response.cached === true } };
}

export function prepareWorkspaceContext(current, reportView, kind, findingIndex = null) {
  const { report, reportRef } = reportView;
  const finding = Number.isInteger(findingIndex) ? report.result?.findings?.[findingIndex] : null;
  return editWorkspaceCase(current, { question: '', sourceIds: [], checks: [], text: '', selection: workspaceSelection(), selectionChanged: false,
    contextRef: { ...reportRef }, context: { question: report.preview?.question || '', summary: report.result?.summary || '', ...(finding ? { finding } : {}),
      ...(report.review ? { caseReview: report.review, caseName: report.name } : {}) },
    findingIndex: finding ? findingIndex : null, requirements: workspaceRequirements(),
    handoffId: '', handoff: null, targetSelection: { tokens: [] }, targets: [],
    reportView: kind === 'task' ? null : reportView });
}

export function prepareWorkspaceHandoff(current, metadata) {
  const targets = metadata.taskTargets || [];
  return editWorkspaceCase(current, { question: metadata.question || '', contextRef: null, context: null, sourceIds: [], text: '',
    preview: null, reportView: null, handoffId: metadata.id || metadata.handoffId, handoff: metadata,
    targetSelection: { tokens: targets.map(target => target.token) }, targets, findingIndex: null });
}

export function workspaceReportKey(reportRef) {
  return reportRef?.casebookId ? `casebook:${reportRef.casebookId}` : reportRef?.historyId ? `history:${reportRef.historyId}` : reportRef?.turnId ? `turn:${reportRef.caseId}:${reportRef.turnId}` : '';
}

export function workspaceReportRef(key) {
  if (typeof key !== 'string') return null;
  const parts = key.split(':');
  if (parts[0] === 'history' && parts.length === 2 && parts[1]) return { historyId: parts[1] };
  if (parts[0] === 'casebook' && parts.length === 2 && parts[1]) return { casebookId: parts[1] };
  if (parts[0] === 'turn' && parts.length === 3 && parts[1] && parts[2]) return { caseId: parts[1], turnId: parts[2] };
  return null;
}

export function workspaceCitation(preview, citation) {
  const entry = preview?.entries?.find(item => item.id === citation?.evidenceId);
  const count = entry?.text ? entry.text.split('\n').length : 0;
  if (!entry || !Number.isInteger(citation.startLine) || !Number.isInteger(citation.endLine)
    || citation.startLine < 1 || citation.endLine < citation.startLine || citation.endLine > count) return null;
  return { evidenceId: entry.id, startLine: citation.startLine, endLine: citation.endLine };
}

export function workspaceLinePage(total, requested, size = 80) {
  const count = Math.max(1, Math.ceil(total / size));
  const page = Math.max(0, Math.min(count - 1, Number.isInteger(requested) ? requested : 0));
  return { page, count, start: page * size, end: Math.min(total, (page + 1) * size) };
}

export function editWorkspaceCase(current, changes) {
  if (current.busy) return current;
  const changedDevice = Object.hasOwn(changes, 'deviceId') && changes.deviceId !== current.deviceId;
  return { ...current, ...changes, ...(changedDevice ? { diagnostic: { packageName: '', symptom: '' }, targets: [], targetSelection: { tokens: [] } } : {}), revision: current.revision + 1, preview: null, result: null, draft: null, usage: null,
    cached: false, error: '', ...(Object.hasOwn(changes, 'selection') ? { selectionChanged: changes.selectionChanged ?? true } : {}),
    ...(Object.hasOwn(changes, 'question') || Object.hasOwn(changes, 'deviceId') ? { plan: null, planUsage: null } : {}) };
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
