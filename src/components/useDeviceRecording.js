import { useEffect, useRef, useState } from 'react';
import { currentDeviceRecording, recordingErrorText, watchDeviceRecordings } from '../shared/recordingWorkspace';
import { tr, useLocale } from '../shared/i18n.js';

export default function useDeviceRecording(deviceId, onStart, onStop) {
  useLocale();
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
      if (!result?.success) throw new Error(result?.error || tr('录屏操作未完成，请重试'));
    } catch (error) {
      if (mounted.current) setRequestError(recordingErrorText(error.message) || tr('录屏操作失败'));
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
    requestError: requestError ? tr(requestError) : '',
    dismissRequestError: () => setRequestError(''),
    refresh: () => controller.current?.refresh(),
    start: options => run(() => onStart(deviceId, options)),
    stop: () => run(() => onStop(deviceId)),
    retry: id => run(() => window.electronAPI.recordingRetry(id)),
  };
}
