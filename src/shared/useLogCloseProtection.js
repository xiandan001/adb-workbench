import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { tr } from './i18n.js';
import { logDocumentKey } from './logSessionSnapshot.js';

export default function useLogCloseProtection({ documentId, sourceIdentity = '', ready = true, reviewKey, dirty, getSnapshot, getCaptureIdentity, onStop, onStopAi, onSaved, paused, onMessage }) {
  const latest = useRef(null), revision = useRef(0), pending = useRef(null), saving = useRef(null);
  const [request, setRequest] = useState(null), [approved, setApproved] = useState(false);
  useLayoutEffect(() => { latest.current = { documentId, sourceIdentity, ready, dirty, getSnapshot, getCaptureIdentity, onStop, onStopAi, onSaved, paused, onMessage }; });
  useLayoutEffect(() => {
    revision.current++;
    void window.electronAPI?.logDocumentState?.({ documentId, revision: revision.current, dirty, sourceIdentity, ready }).catch(() => {});
    // Ingress alone does not revoke a review that explicitly covers incoming logs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, reviewKey, sourceIdentity, ready]);
  useEffect(() => {
    if (!pending.current) void window.electronAPI?.logDocumentState?.({ documentId, revision: revision.current, dirty, sourceIdentity, ready }).catch(() => {});
  }, [documentId, dirty, request, sourceIdentity, ready]);
  useEffect(() => {
    const api = window.electronAPI;
    const offRequest = api?.onLogCloseRequested?.(value => {
      if (!value || typeof value.requestId !== 'string' || typeof value.documentId !== 'string' || !Number.isSafeInteger(value.revision)) return;
      if (value.documentId !== latest.current.documentId || value.revision !== revision.current) {
        void api.logCloseDecision?.({ requestId: value.requestId, documentId: value.documentId, revision: value.revision, action: 'cancel' }).catch(() => {}); return;
      }
      pending.current = value; setApproved(false); setRequest(value);
    });
    const offCancel = api?.onLogCloseCancelled?.(value => {
      if (pending.current?.requestId !== value?.requestId) return;
      pending.current = null; setApproved(false); setRequest(null);
      if (saving.current) void api.logSessionCancel?.({ requestId: saving.current }).catch(() => {});
    });
    return () => { offRequest?.(); offCancel?.(); if (saving.current) void api?.logSessionCancel?.({ requestId: saving.current }).catch(() => {}); pending.current = null; };
  }, []);
  const stillCurrent = value => pending.current?.requestId === value.requestId && latest.current.documentId === value.documentId && revision.current === value.revision;
  const save = async value => {
    if (!stillCurrent(value)) throw new Error(tr('日志内容已切换，关闭操作已取消；当前内容保持不变。'));
    const current = latest.current, identity = current.getCaptureIdentity?.();
    await current.onStopAi?.();
    if (!stillCurrent(value)) throw new Error(tr('日志内容已切换，关闭操作已取消；当前内容保持不变。'));
    await current.onStop?.({ captureId: identity?.captureId, deviceId: identity?.deviceId, sourceIdentity: current.sourceIdentity });
    if (!stillCurrent(value)) throw new Error(tr('日志内容已切换，关闭操作已取消；当前内容保持不变。'));
    let snapshot = latest.current.getSnapshot('loaded');
    const actual = await window.electronAPI.logGetState();
    if (!stillCurrent(value) || actual?.source !== snapshot.source || actual?.deviceId !== snapshot.deviceId
      || current.sourceIdentity && actual.sourceIdentity !== current.sourceIdentity
      || identity?.source === 'realtime' && identity.captureId && actual.captureId !== identity.captureId) throw new Error(tr('日志内容已切换，关闭操作已取消；当前内容保持不变。'));
    if (!current.paused) {
      snapshot = { ...snapshot, entries: actual.entries || [], truncated: actual.truncated === true };
      snapshot.uiRevision = logDocumentKey({ ...snapshot, documentId: value.documentId });
    }
    const requestId = crypto.randomUUID(); saving.current = requestId;
    try {
      const result = await window.electronAPI.logSessionSave({ ...snapshot, requestId });
      if (!result?.ok) throw new Error(result?.error || tr('日志保存失败，当前窗口和内容已保留。'));
      if (!stillCurrent(value)) throw new Error(tr('快照已保存，但日志内容已切换；当前窗口未关闭。'));
      latest.current.onSaved?.(snapshot, result.session);
      const response = await window.electronAPI.logDocumentState({ documentId: value.documentId, revision: value.revision, dirty: false, sourceIdentity: current.sourceIdentity, ready: true });
      if (!response?.accepted) throw new Error(tr('快照已保存，但日志内容已切换；当前窗口未关闭。'));
    } finally { if (saving.current === requestId) saving.current = null; }
  };
  const resolve = async (value, action) => {
    if (action !== 'cancel' && !stillCurrent(value)) throw new Error(tr('日志内容已切换，关闭操作已取消；当前内容保持不变。'));
    const result = await window.electronAPI.logCloseDecision({ requestId: value.requestId, documentId: value.documentId, revision: value.revision, action });
    if (action === 'cancel') { if (pending.current?.requestId === value.requestId) { pending.current = null; setRequest(null); setApproved(false); } return; }
    if (!result?.accepted) throw new Error(tr('日志内容已切换，关闭操作已取消；当前内容保持不变。'));
    if (!stillCurrent(value)) throw new Error(tr('日志内容已切换，关闭操作已取消；当前内容保持不变。'));
    if (value.intent === 'quit') setApproved(true);
    else { pending.current = null; setRequest(null); setApproved(false); }
  };
  return { request, approved, save, resolve };
}
