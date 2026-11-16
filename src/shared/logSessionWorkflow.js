import { tr } from './i18n.js';

export function freezeLogSnapshot(getSnapshot, name) {
  const snapshot = getSnapshot();
  return { ...snapshot, ...(name === undefined ? {} : { name }), entries: (snapshot.entries || []).map(entry => ({ ...entry })),
    evidence: (snapshot.evidence || []).map(entry => ({ ...entry })), aiTurns: (snapshot.aiTurns || []).map(turn => ({ ...turn, evidenceRefs: [...(turn.evidenceRefs || [])] })),
    markers: (snapshot.markers || []).map(marker => ({ ...marker, entry: { ...marker.entry }, context: (marker.context || []).map(entry => ({ ...entry })) })),
    filter: structuredClone(snapshot.filter || {}), buffers: [...(snapshot.buffers || [])] };
}

export async function saveBeforeRestore({ snapshot, id, requestId, expectedSourceIdentity, saveCurrent, api, isCurrent, onSaved }) {
  if (saveCurrent) {
    const saved = await api.logSessionSave({ ...snapshot, ...(requestId ? { requestId } : {}) });
    if (!saved?.ok) throw new Error(saved?.error || tr('会话保存失败，当前内容未替换。'));
    if (!isCurrent()) return null;
    onSaved?.(snapshot, saved.session);
  }
  if (!isCurrent()) return null;
  const result = await api.logSessionLoad({ id, ...(requestId ? { requestId } : {}), ...(expectedSourceIdentity === undefined ? {} : { expectedSourceIdentity }) });
  if (!result?.ok) throw new Error(result?.error || tr('会话读取失败，当前内容未替换。'));
  if (!isCurrent()) return null;
  if (result.sourceIdentity && typeof api.logGetState === 'function') {
    const actual = await api.logGetState();
    if (!isCurrent()) return null;
    if (actual?.sourceIdentity !== result.sourceIdentity) throw new Error(tr('日志来源已变化，未恢复会话；当前内容保持不变。'));
  }
  return isCurrent() ? result : null;
}
