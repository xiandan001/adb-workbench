import { tr } from '../../shared/i18n.js';
export const QUOTA_REFRESH_MS = 60000;
const MAX_BACKOFF = 300000;
const signature = result => result ? JSON.stringify([result.status, result.observedAt, result.retryAt, result.reason]) : '';

export function quotaMetricRatio(metric) {
  if (!Number.isFinite(metric.total) || metric.total <= 0) return null;
  const kind = Number.isFinite(metric.remaining) ? 'remaining' : 'used'; const value = metric[kind];
  return Number.isFinite(value) && value >= 0 && value <= metric.total ? { value: value / metric.total * 100, kind } : null;
}

export function createQuotaPoller({ query, clock = { now: Date.now, setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: timer => clearTimeout(timer) }, onState = () => {} }) {
  let options = {}; let timer = null; let inFlight = null; let generation = 0; let disposed = false;
  let due = null; let retryAt = 0; let failures = 0; let observed = ''; let latestFreshAt = null;
  const visible = () => options.configured && options.canQuery && options.active && options.documentVisible && options.cardVisible;
  const snapshot = () => ({ key: options.key, pending: Boolean(inFlight), nextAt: due, retryAt, now: clock.now() });
  const emit = () => { if (!disposed) onState(snapshot()); };
  const clear = () => { if (timer !== null) clock.clearTimeout(timer); timer = null; };
  function schedule() {
    clear(); emit();
    if (disposed || !visible() || inFlight) return;
    const now = clock.now(); let at;
    if (options.autoRefresh) at = options.busy ? now + 1000 : Math.max(due ?? now, retryAt);
    else if (retryAt > now) at = retryAt;
    else return;
    timer = clock.setTimeout(() => {
      timer = null;
      if (options.autoRefresh) { if (options.busy) schedule(); else void run(false); }
      else schedule();
    }, Math.max(0, Math.min(2147483647, at - now)));
  }
  function observe(result) {
    const next = signature(result); if (next === observed) return; observed = next;
    if (!result) return;
    if (result.status === 'fresh' && Number.isFinite(result.observedAt) && latestFreshAt !== null && result.observedAt <= latestFreshAt) return;
    retryAt = Number.isFinite(result.retryAt) && result.retryAt > clock.now() ? result.retryAt : 0;
    if (result.status === 'fresh' && Number.isFinite(result.observedAt)) {
      latestFreshAt = result.observedAt;
      failures = 0; due = Math.max(clock.now(), Math.min(clock.now() + QUOTA_REFRESH_MS, result.observedAt + QUOTA_REFRESH_MS));
    }
    if (retryAt) due = Math.max(due ?? clock.now(), retryAt);
  }
  async function run(manual) {
    if (disposed || !visible() || inFlight || options.busy || !manual && !options.autoRefresh) return { skipped: true };
    if (retryAt > clock.now()) { schedule(); return { skipped: true, retryAt }; }
    clear(); const operation = { generation }; inFlight = operation; emit();
    let result;
    try { result = await query(); }
    catch (failure) { result = { status: 'error', reason: failure.message || tr("额度查询失败") }; }
    finally {
      if (!disposed && operation.generation === generation) {
        if (result?.skipped || result?.cancelled || !result) due = clock.now() + 1000;
        else {
          if (result.status === 'fresh') failures = 0; else failures++;
          due = clock.now() + (failures ? Math.min(MAX_BACKOFF, QUOTA_REFRESH_MS * 2 ** Math.min(failures - 1, 3)) : QUOTA_REFRESH_MS);
          retryAt = Number.isFinite(result.retryAt) && result.retryAt > clock.now() ? result.retryAt : 0;
          due = Math.max(due, retryAt);
        }
      }
      if (inFlight === operation) inFlight = null;
      if (!disposed) schedule();
    }
    return result;
  }
  return {
    update(next) {
      if (disposed) return;
      if (Object.hasOwn(next, 'key') && next.key !== options.key) { generation++; clear(); due = null; retryAt = 0; failures = 0; observed = ''; latestFreshAt = null; }
      options = { ...options, ...next }; observe(options.result); schedule();
    },
    refresh: () => run(true), snapshot,
    dispose() { disposed = true; generation++; clear(); },
  };
}
