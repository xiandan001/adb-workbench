import { useEffect, useRef, useState } from 'react';
import { currentDeviceRecording, watchDeviceRecordings } from '../shared/recordingWorkspace';

export default function useDeviceRecording(deviceId, onStart, onStop) {
  const [snapshot, setSnapshot] = useState({ sessions: [], loaded: false, error: '' });
  const [pending, setPending] = useState(false);
  const [requestError, setRequestError] = useState('');
  const controller = useRef(null);
  const operationPending = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const subscription = watchDeviceRecordings(window.electronAPI, deviceId, next => {
      setSnapshot(previous => ({ ...previous, ...next }));
    });
    controller.current = subscription;
    return () => {
      mounted.current = false;
      subscription.dispose();
      controller.current = null;
    };
  }, [deviceId]);

  const run = async action => {
    if (operationPending.current) return;
    operationPending.current = true;
    setPending(true);
    setRequestError('');
    try {
      const result = await action();
      if (!result?.success) throw new Error(result?.error || '录屏操作未完成，请重试');
    } catch (error) {
      if (mounted.current) setRequestError(error.message || '录屏操作失败');
    } finally {
      operationPending.current = false;
      if (mounted.current) {
        setPending(false);
        void controller.current?.refresh();
      }
    }
  };

  return {
    ...snapshot,
    session: currentDeviceRecording(snapshot.sessions, deviceId),
    pending,
    requestError,
    dismissRequestError: () => setRequestError(''),
    refresh: () => controller.current?.refresh(),
    start: options => run(() => onStart(deviceId, options)),
    stop: () => run(() => onStop(deviceId)),
    retry: id => run(() => window.electronAPI.recordingRetry(id)),
  };
}
