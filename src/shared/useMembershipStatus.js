import { useCallback, useEffect, useRef, useState } from 'react';

const initialStatus = {
  activated: false, scope: 'free', type: null,
  issuedAt: null, expiresAt: null, machineId: null, reason: 'loading'
};

export default function useMembershipStatus() {
  const [status, setStatus] = useState(initialStatus);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    let next;
    try {
      next = await window.electronAPI?.vipGetStatus?.();
    } catch { /* Retry is available from the status card. */ }
    if (request !== revision.current) return;
    setStatus(typeof next?.activated === 'boolean' ? next : { ...initialStatus, reason: 'vip_status_failed' });
  }, []);

  const acceptVerifiedStatus = useCallback((next) => {
    if (next?.activated !== true) return false;
    revision.current += 1;
    setStatus(next);
    return true;
  }, []);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onVipStatusChanged?.(refresh);
    void refresh();
    return () => {
      revision.current += 1;
      unsubscribe?.();
    };
  }, [refresh]);

  return { status, refresh, acceptVerifiedStatus };
}
