import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createQuotaPoller } from './aiQuotaPolling.js';

export default function useQuotaPolling({ elementRef, provider, revision = 0, active = true, result, error, busy, canQuery, onQuery, autoRefresh, onAutoRefresh }) {
  const controllerRef = useRef(null); const queryRef = useRef(onQuery); const optionsRef = useRef(null);
  const [mountedAt] = useState(Date.now);
  const [cardVisible, setCardVisible] = useState(false);
  const [documentVisible, setDocumentVisible] = useState(() => typeof document !== 'undefined' && document.visibilityState === 'visible');
  const [localAuto, setLocalAuto] = useState(true); const [pollState, setPollState] = useState(null);
  const automatic = autoRefresh === undefined ? localAuto : autoRefresh;
  const configured = Boolean(provider.quota?.adapter && (provider.hasCredential || provider.hasQuotaCredential));
  const key = JSON.stringify([provider.id, provider.baseUrl, provider.quota, provider.hasCredential, provider.hasQuotaCredential, revision]);
  const outcome = useMemo(() => error ? { status: 'error', reason: error, retryAt: result?.retryAt } : result?.providerId === provider.id ? result : null, [error, result, provider.id]);
  const options = useMemo(() => ({ key, configured, canQuery, active, documentVisible, cardVisible, autoRefresh: automatic, busy, result: outcome }), [key, configured, canQuery, active, documentVisible, cardVisible, automatic, busy, outcome]);
  useLayoutEffect(() => { queryRef.current = onQuery; }, [onQuery]);
  useLayoutEffect(() => { optionsRef.current = options; controllerRef.current?.update(options); }, [options]);
  useEffect(() => {
    const controller = createQuotaPoller({ query: () => queryRef.current?.(), onState: value => { if (controllerRef.current === controller) setPollState(value); } });
    controllerRef.current = controller; controller.update(optionsRef.current);
    return () => { if (controllerRef.current === controller) controllerRef.current = null; controller.dispose(); };
  }, []);
  useEffect(() => {
    let disposed = false; const node = elementRef.current;
    const visibility = () => {
      if (disposed) return; const visible = document.visibilityState === 'visible';
      controllerRef.current?.update({ documentVisible: visible }); setDocumentVisible(visible);
    };
    const seen = visible => { if (!disposed) { controllerRef.current?.update({ cardVisible: visible }); setCardVisible(visible); } };
    document.addEventListener('visibilitychange', visibility); visibility();
    let observer;
    if (node && typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver(entries => { const entry = entries.find(item => item.target === node); if (entry) seen(entry.isIntersecting && entry.intersectionRatio > 0); }, { threshold: [0, 0.01] });
      observer.observe(node);
    } else seen(Boolean(node));
    return () => { disposed = true; observer?.disconnect(); document.removeEventListener('visibilitychange', visibility); };
  }, [provider.id, elementRef]);
  const state = pollState?.key === key ? pollState : { pending: false, retryAt: 0, now: mountedAt };
  const retryAt = Math.max(state.retryAt || 0, Number.isFinite(outcome?.retryAt) ? outcome.retryAt : 0);
  const cooling = retryAt > state.now;
  return {
    automatic, configured, pending: state.pending, cooling, retryAt,
    canRefresh: configured && canQuery && active && documentVisible && cardVisible && !busy && !state.pending && !cooling,
    setAutomatic(value) { setLocalAuto(value); onAutoRefresh?.(value); },
    refresh: () => controllerRef.current?.refresh(),
  };
}
