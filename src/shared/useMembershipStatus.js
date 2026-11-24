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
    window.addEventListener('focus', refresh);
    void refresh();
    return () => {
      revision.current += 1;
      unsubscribe?.();
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  useEffect(() => {
    if (!status.activated || status.type !== 'subscription' || !Number.isFinite(status.expiresAt) || status.expiresAt <= 0) return;
    const boundary = (Math.floor(status.expiresAt) + 1) * 1000;
    const delay = Math.min(2_147_483_647, Math.max(1, boundary - Date.now()));
    const timer = setTimeout(refresh, delay);
    return () => clearTimeout(timer);
  }, [status, refresh]);

  return { status, refresh, acceptVerifiedStatus };
}
