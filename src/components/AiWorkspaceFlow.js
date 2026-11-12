import { editWorkspaceCase, workspaceDeviceOnline } from './AiWorkspaceState.js';

const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const CHECK_IDS = ['device_info', 'logcat_snapshot', 'performance_snapshot', 'app_package', 'app_process', 'app_memory', 'app_activity'];

export function adoptWorkspaceDefaults(current, devices = [], activeDeviceId = '') {
  if (!current.pristine || current.busy || current.handoffId || current.contextRef || current.reportView) return current;
  const deviceId = workspaceDeviceOnline(devices, activeDeviceId) ? activeDeviceId : workspaceDeviceOnline(devices, current.deviceId) ? current.deviceId : devices.find(device => device.status === 'device')?.id || '';
  return deviceId === current.deviceId ? current : { ...current, deviceId, revision: current.revision + 1 };
}

export function workspacePhase(current) {
  if (current.preparing) return 'prepare';
  if (current.reportView || current.result || current.draft) return 'result';
  return current.preview ? 'review' : 'prepare';
}

export function workspacePrimaryBlock(current, { devices = [], sources = [], loading, entitled, reportBusy } = {}) {
  if (current.busy || reportBusy) return 'busy';
  if (loading) return 'loading';
  if (!current.question.trim()) return 'question';
  if (current.mode === 'task') {
    if (current.deviceId.startsWith('hdc:') && !workspaceDeviceOnline(devices, current.deviceId)) return 'device';
    return entitled ? '' : 'membership';
  }
  if (current.mode === 'diagnose') {
    if (!workspaceDeviceOnline(devices, current.deviceId)) return 'device';
    if (!current.checks.length) return 'checks';
    if (current.checks.some(id => id.startsWith('app_')) && !current.diagnostic.packageName.trim()) return 'package';
  } else {
    if (current.sourceIds.some(id => !sources.some(source => source.id === id))) return 'stale';
    if (!current.sourceIds.length && !current.text.trim() && !current.contextRef && !current.handoffId && !current.basketItems?.length) return 'source';
  }
  return '';
}

function reportDevice(report) {
  const preview = report.preview;
  if (preview?.deviceId) return preview.deviceId;
  if (preview?.handoff?.deviceId) return preview.handoff.deviceId;
  const ids = [...new Set((preview?.entries || []).filter(entry => entry.targetKey && entry.targetKey === preview.targetFingerprint && entry.target).map(entry => entry.target))];
  return ids.length === 1 ? ids[0] : '';
}

export function prepareWorkspaceVerification(current, view, card, availableChecks = []) {
  if (current.busy) return { state: current, reason: 'busy' };
  const ids = card?.checkIds;
  if (!view?.reportRef || !Array.isArray(ids) || !ids.length || ids.length > 3 || new Set(ids).size !== ids.length
    || ids.some(id => !CHECK_IDS.includes(id) || !availableChecks.some(check => check.id === id))) return { state: current, reason: 'checks' };
  const report = view.report, diagnostic = report.preview.diagnostic || { packageName: '', symptom: '' };
  if (ids.some(id => id.startsWith('app_')) && !diagnostic.packageName) return { state: current, reason: 'package' };
  const state = editWorkspaceCase(current, { question: report.preview.question, deviceId: reportDevice(report),
    checks: [...ids], sourceIds: [], text: '', handoffId: '', handoff: null, targets: [], targetSelection: { tokens: [] }, findingIndex: null,
    contextRef: { ...view.reportRef }, context: { question: report.preview.question, summary: report.result.summary,
      verification: { title: card.title, expectedObservation: card.expectedObservation } }, reportView: null });
  return { state: { ...state, diagnostic: { ...diagnostic } }, reason: '' };
}

export function normalizeWorkspaceReportRequest(request) {
  if (!request || typeof request.requestId !== 'string' || !request.requestId || request.requestId.length > 200) return null;
  const keys = Object.keys(request).filter(key => key !== 'requestId');
  for (const key of ['historyId', 'casebookId']) if (keys.length === 1 && keys[0] === key && UUID.test(request[key] || '')) return { [key]: request[key] };
  return keys.length === 2 && keys.includes('caseId') && keys.includes('turnId') && UUID.test(request.caseId || '') && UUID.test(request.turnId || '') ? { caseId: request.caseId, turnId: request.turnId } : null;
}

export function workspaceRelatedTasks(view, snapshot = {}) {
  if (!view?.reportRef) return [];
  const ref = view.reportRef, turnId = ref.turnId || view.report.turnId;
  const matches = origin => origin && (ref.historyId && origin.historyId === ref.historyId || ref.casebookId && origin.casebookId === ref.casebookId
    || turnId && origin.turnId === turnId && (!ref.caseId || origin.caseId === ref.caseId));
  const scripts = (snapshot.scripts || []).filter(item => matches(item.analysisOrigin)).map(item => ({ scriptId: item.id, label: item.name, status: 'draft' }));
  const seen = new Set();
  const runs = [...(snapshot.activeTasks || []), ...(snapshot.history || [])].filter(item => {
    if (!matches(item.analysisOrigin) || seen.has(item.id)) return false;
    seen.add(item.id); return true;
  }).map(item => ({ runId: item.id, label: item.scriptName, status: item.status }));
  return [...scripts, ...runs].slice(0, 12);
}

export async function loadWorkspaceRelatedSnapshot(api) {
  if (typeof api?.taskState !== 'function' || typeof api?.taskScriptsList !== 'function') throw new Error();
  const [state, saved] = await Promise.all([api.taskState(), api.taskScriptsList()]);
  if (state?.ok !== true || saved?.ok !== true || !Array.isArray(saved.scripts) || !Array.isArray(state.activeTasks) || !Array.isArray(state.history)) {
    throw new Error(state?.error || saved?.error || '');
  }
  return { ...state, scripts: saved.scripts };
}

export function mergeWorkspaceRelatedState(previous, incoming) {
  return { ...previous, ...incoming, scripts: Array.isArray(incoming?.scripts) ? incoming.scripts : previous?.scripts || [] };
}
