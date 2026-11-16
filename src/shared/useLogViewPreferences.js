import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { defaultLogViewPreferences, logViewFor, normalizeLogViewPreferences, readLogViewPreferences, saveLogViewPreferences, updateLogView } from './logViewPreferences.js';

export default function useLogViewPreferences(deviceId, source) {
  const [boot] = useState(() => { try { return { value: readLogViewPreferences(), error: '' }; } catch (error) { return { value: defaultLogViewPreferences(), error: error.message }; } });
  const [value, setValue] = useState(boot.value), [error, setError] = useState(boot.error);
  const latest = useRef(value), timer = useRef(null);
  const target = useRef({ deviceId, source });
  useLayoutEffect(() => { target.current = { deviceId, source }; }, [deviceId, source]);
  const persist = useCallback(() => {
    clearTimeout(timer.current); timer.current = null;
    try { saveLogViewPreferences(latest.current); setError(''); }
    catch (failure) { setError(failure.message); }
  }, []);
  const change = useCallback((update, immediate = false) => {
    try {
      const next = normalizeLogViewPreferences(update(latest.current));
      if (JSON.stringify(next) === JSON.stringify(latest.current)) return;
      latest.current = next; setValue(next); clearTimeout(timer.current);
      if (immediate) persist(); else timer.current = setTimeout(persist, 300);
    } catch (failure) { setError(failure.message); }
  }, [persist]);
  const setTargetField = useCallback((selectedDeviceId, selectedSource, field, update) => change(previous => {
    const current = logViewFor(previous, selectedDeviceId, selectedSource);
    return updateLogView(previous, selectedDeviceId, selectedSource, { [field]: typeof update === 'function' ? update(current[field]) : update });
  }, !['colWidths', 'aiPanelHeight', 'filter'].includes(field)), [change]);
  const setField = useCallback((field, update) => setTargetField(target.current.deviceId, target.current.source, field, update), [setTargetField]);
  const setArchive = useCallback(update => change(previous => ({ ...previous, archive: typeof update === 'function' ? update(previous.archive) : update }), true), [change]);
  const forTarget = useCallback((selectedDeviceId, selectedSource) => ({ ...logViewFor(value, selectedDeviceId, selectedSource),
    hasSavedView: value.views.some(view => view.deviceId === selectedDeviceId && view.source === selectedSource) }), [value]);
  useEffect(() => {
    window.addEventListener('beforeunload', persist);
    return () => { window.removeEventListener('beforeunload', persist); clearTimeout(timer.current); };
  }, [persist]);
  return { view: logViewFor(value, deviceId, source), hasSavedView: value.views.some(view => view.deviceId === deviceId && view.source === source),
    forTarget, setTargetField, archive: value.archive, setField, setArchive, error, retry: persist };
}
