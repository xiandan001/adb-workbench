import { useEffect, useState } from 'react';
import { tr } from './i18n.js';

export default function useMirrorSessions(api = globalThis.window?.electronAPI) {
  const [sessions, setSessions] = useState({}), [error, setError] = useState('');
  useEffect(() => {
    let alive = true, received = false;
    const accept = value => {
      if (!alive || !Array.isArray(value?.sessions)) return;
      received = true;
      setSessions(Object.fromEntries(value.sessions.slice(0, 100).filter(row => row && typeof row.deviceId === 'string' && typeof row.id === 'string').map(row => [row.deviceId, row])));
      setError('');
    };
    const off = api?.onMirrorStateChanged?.(accept);
    if (typeof api?.mirrorGetState === 'function') void api.mirrorGetState().then(value => { if (!received) accept(value); }).catch(() => {
      if (alive) setError(tr('投屏会话状态暂未读取，仍可手动开始投屏。'));
    });
    return () => { alive = false; off?.(); };
  }, [api]);
  return { sessions, error };
}
