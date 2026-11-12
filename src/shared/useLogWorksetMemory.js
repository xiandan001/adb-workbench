import { useCallback, useEffect, useRef, useState } from 'react';
import { tr } from './i18n.js';
import { normalizeLogFilter, normalizeLogBuffers } from './logWorkspace.js';

export default function useLogWorksetMemory({ deviceId, filter, buffers }) {
  const [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const latest = useRef(null), epoch = useRef(0), timer = useRef(null);
  const advanceRequest = useCallback(() => ++epoch.current, []);
  latest.current = { deviceId, filter: normalizeLogFilter(filter), buffers: normalizeLogBuffers(buffers) };
  const persist = useCallback(async () => {
    clearTimeout(timer.current); timer.current = null;
    const remember = window.electronAPI?.worksetRemember;
    if (!remember) return;
    const ticket = advanceRequest();
    setSaving(true);
    try {
      const result = await remember({ part: 'logs', value: latest.current });
      if (ticket !== epoch.current) return;
      if (!result?.ok) throw new Error(result?.error || tr('工作集日志配置未能保存，已保留当前过滤条件。'));
      setError('');
    } catch (failure) {
      if (ticket === epoch.current) setError(failure.message || tr('工作集日志配置未能保存，已保留当前过滤条件。'));
    } finally { if (ticket === epoch.current) setSaving(false); }
  }, [advanceRequest]);
  useEffect(() => {
    advanceRequest();
    timer.current = setTimeout(() => { void persist(); }, 300);
    return () => { advanceRequest(); clearTimeout(timer.current); };
  }, [deviceId, filter, buffers, persist, advanceRequest]);
  return { error, saving, retry: persist };
}
