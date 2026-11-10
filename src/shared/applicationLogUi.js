import { tr } from './i18n.js';

const REASONS = new Set(['idle', 'manual', 'time-limit', 'size-limit', 'interrupted', 'io-error']);
export function normalizeApplicationLogState(value) {
  const invalid = () => new Error(tr('应用日志状态格式无效，请重新读取。'));
  if (!value || typeof value !== 'object' || typeof value.recording !== 'boolean' || typeof value.available !== 'boolean'
    || !REASONS.has(value.reason) || typeof value.error !== 'string' || value.error.length > 2000) throw invalid();
  for (const key of ['bytes', 'records', 'dropped']) if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw invalid();
  for (const key of ['startedAt', 'stoppedAt']) if (value[key] !== null && (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 8640000000000000)) throw invalid();
  return { recording: value.recording, available: value.available, startedAt: value.startedAt, stoppedAt: value.stoppedAt,
    bytes: value.bytes, records: value.records, dropped: value.dropped, reason: value.reason, error: value.error };
}

export function createApplicationLogUi({ api, onChange, clock = globalThis }) {
  let view = { capture: null, busy: '', loading: true, error: '', readError: '', notice: '' };
  let active = false, generation = 0, reading = 0, timer;
  const snapshot = () => ({ ...view, capture: view.capture ? { ...view.capture } : null });
  const publish = patch => { view = { ...view, ...patch }; if (active) onChange(snapshot()); };
  const clearTimer = () => { if (timer !== undefined) clock.clearTimeout(timer); timer = undefined; };
  const current = ticket => active && generation === ticket;
  function schedule() {
    clearTimer();
    if (active && view.capture?.recording && !view.busy) timer = clock.setTimeout(() => { timer = undefined; void refresh(); }, 2000);
  }
  async function request(method, ticket) {
    if (typeof api?.[method] !== 'function') throw new Error(tr('当前环境不支持应用日志，请在桌面应用中使用。'));
    let result;
    try { result = await api[method](); }
    catch { throw new Error(tr('应用日志操作未完成，请重试。')); }
    if (!current(ticket)) return null;
    if (result?.state) publish({ capture: normalizeApplicationLogState(result.state), readError: '' });
    if (result?.success !== true) throw new Error(typeof result?.error === 'string' && result.error.length <= 2000
      ? result.error : view.capture?.error || tr('应用日志操作未完成，请重试。'));
    if (!result.state) throw new Error(tr('应用日志状态格式无效，请重新读取。'));
    return { cancelled: result.cancelled === true };
  }
  async function refresh() {
    if (!active || view.busy || reading) return;
    clearTimer(); const ticket = ++generation; reading = ticket;
    try { await request('appLogStatus', ticket); if (current(ticket)) publish({ readError: '' }); }
    catch (error) { if (current(ticket)) publish({ readError: error.message }); }
    finally { if (reading === ticket) reading = 0; if (current(ticket)) { publish({ loading: false }); schedule(); } }
  }
  async function run(action) {
    if (!active || view.busy || view.loading || !view.capture) return;
    if (action === 'start' ? view.capture.recording : action === 'stop-export' ? !view.capture.recording : view.capture.recording || !view.capture.available) return;
    clearTimer(); const ticket = ++generation; reading = 0;
    publish({ busy: action, error: '', notice: '' });
    try {
      if (action === 'start') await request('appLogStart', ticket);
      else {
        if (action === 'stop-export') {
          if (!await request('appLogStop', ticket)) return;
          if (view.capture.recording) throw new Error(tr('请先停止应用日志记录。'));
        }
        if (!current(ticket)) return;
        const result = await request('appLogExport', ticket);
        if (result && current(ticket)) publish({ notice: result.cancelled ? 'cancelled' : 'exported' });
      }
    } catch (error) { if (current(ticket)) publish({ error: error.message }); }
    finally { if (current(ticket)) { publish({ busy: '' }); schedule(); } }
  }
  return { snapshot, refresh, start: () => run('start'), stopAndExport: () => run('stop-export'), export: () => run('export'),
    activate() { active = true; generation++; reading = 0; publish({ busy: '', loading: true }); void refresh(); },
    deactivate() { active = false; generation++; reading = 0; clearTimer(); }
  };
}
