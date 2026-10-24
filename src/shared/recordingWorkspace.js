import { tr } from './i18n.js';
const ACTIVE_STATUSES = new Set(['starting', 'recording', 'stopping', 'saving']);

export function deviceRecordingSessions(sessions, deviceId) {
  return (Array.isArray(sessions) ? sessions : [])
    .filter(session => session?.deviceId === deviceId)
    .sort((left, right) => Number(right.startedAt || 0) - Number(left.startedAt || 0));
}

export function currentDeviceRecording(sessions, deviceId) {
  const matching = deviceRecordingSessions(sessions, deviceId);
  return matching.find(session => ACTIVE_STATUSES.has(session.status)) || matching[0] || null;
}

export function recordingButtonState(session, { loaded, pending, isOnline }) {
  const status = session?.status;
  const busy = pending || ['starting', 'stopping', 'saving'].includes(status);
  const labels = { starting: tr("启动中..."), recording: tr("停止并保存"), stopping: tr("停止中..."), saving: tr("保存中...") };
  return {
    label: !loaded ? tr("读取录屏状态...") : pending && !ACTIVE_STATUSES.has(status) ? tr("处理中...") : labels[status] || tr("录屏"),
    recording: status === 'recording',
    busy,
    disabled: !loaded || busy || !isOnline,
  };
}

export function recordingDuration(session, now) {
  if (!session) return 0;
  if (session.status !== 'recording' && Number.isFinite(session.durationMs)) return Math.max(0, session.durationMs);
  return Math.max(0, Number(session.endedAt || now) - Number(session.startedAt || now));
}

export function formatMediaDuration(milliseconds) {
  const seconds = Math.floor(Math.max(0, Number(milliseconds) || 0) / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function savedRecordingVisible(session, now) {
  const savedAt = Number(session?.savedAt || session?.endedAt);
  return session?.status === 'saved' && Number.isFinite(savedAt) && now < savedAt + 10000;
}

// Listen first so a delayed initial IPC reply cannot replace a newer recording event.
export function watchDeviceRecordings(api, deviceId, onSnapshot) {
  let disposed = false;
  let revision = 0;
  const unsubscribe = api?.onRecordingState?.(payload => {
    if (disposed || !Array.isArray(payload?.sessions)) return;
    revision += 1;
    onSnapshot({ sessions: deviceRecordingSessions(payload.sessions, deviceId), loaded: true, error: '' });
  });
  const refresh = async () => {
    const requestedRevision = ++revision;
    try {
      if (!api?.recordingSessionsList) throw new Error(tr("录屏服务不可用，请重启软件后重试"));
      const result = await api.recordingSessionsList({ deviceId });
      if (disposed || requestedRevision !== revision) return;
      if (!result?.success) throw new Error(result?.error || tr("无法读取录屏状态"));
      onSnapshot({ sessions: deviceRecordingSessions(result.sessions, deviceId), loaded: true, error: '' });
    } catch (error) {
      if (!disposed && requestedRevision === revision) onSnapshot({ loaded: false, error: error.message || tr("无法读取录屏状态") });
    }
  };
  void refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      unsubscribe?.();
    },
  };
}
