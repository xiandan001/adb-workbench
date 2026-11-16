import { tr } from './i18n.js';
import { createLogQuery, LOG_WORKBENCH_LIMIT } from './logWorkbenchModel.js';
import { boundLogWindow } from './logStream.js';

const empty = () => ({ rows: [], windowRows: [], matchingIds: [], counts: { V: 0, D: 0, I: 0, W: 0, E: 0, F: 0, A: 0 }, issues: [], total: 0,
  pending: false, selectionPending: false, error: '', errorCode: '', pendingCount: 0, timeWarnings: [], unknownTimeCount: 0, ungroupedIssueCount: 0, omittedRows: 0 });
const browserWorker = () => typeof Worker === 'function' ? new Worker(new URL('../workers/log-view-worker.js', import.meta.url), { type: 'module' }) : null;
const querySignature = config => JSON.stringify([config.filter || {}, config.timeRange || { kind: 'all' }, config.rules || []]);
export function createLogViewController({ createWorker = browserWorker, timeoutMs = 1200 } = {}) {
  let state = empty(), worker = null, generation = 0, revision = 0, requestId = 0, timer = null, fallbackTimer = null;
  let indexedRows = [], latestRows = [], lastGoodRows = [], paused = false, scope = null, filter = {}, rules = [], timeRange, queryKey = '', blockedKey = '', dirty = false, inflight = null, disposed = false;
  const rowMap = new Map(), positions = new Map(), listeners = new Set(); let sequence = 0;
  let hasGood = false, acceptedScope = null, acceptedQueryKey = '';
  let sourceOmittedRows = 0;
  const publish = patch => { if (!disposed) { state = { ...state, ...patch }; for (const listener of listeners) listener(); } };
  function stop() {
    clearTimeout(timer); clearTimeout(fallbackTimer); timer = null; fallbackTimer = null; generation++; inflight = null; dirty = false;
    if (worker) { worker.onmessage = null; worker.onerror = null; worker.terminate(); worker = null; }
  }
  function failure(code, message) { blockedKey = queryKey; stop(); publish({ pending: false, errorCode: code, error: message }); }
  function accepted(result, rows) {
    lastGoodRows = rows; hasGood = true; acceptedScope = scope; acceptedQueryKey = queryKey;
    publish({ ...result, omittedRows: Math.max(result.omittedRows || 0, sourceOmittedRows), pending: false, selectionPending: false, error: '', errorCode: '', matchingIds: result.ids, rows: result.ids.map(id => rowMap.get(id)).filter(Boolean), windowRows: rows,
      issues: result.issues.map(group => Object.freeze({ ...group, representative: rowMap.get(group.representativeId), context: Object.freeze(group.contextIds.map(id => rowMap.get(id)).filter(Boolean)) })) });
  }
  function receive(message, owner) {
    if (disposed || owner !== worker || message.generation !== generation || !inflight || message.requestId !== inflight.requestId) return;
    clearTimeout(timer); timer = null; const sent = inflight; inflight = null;
    if (message.type === 'error') { failure(message.code || 'QUERY_FAILED', message.code === 'RULE_INVALID' ? tr('日志诊断规则无效，请修改或停用规则；上一视图已保留。') : tr('日志过滤失败，请修改条件后重试；上一视图已保留。')); return; }
    if (dirty || sent.revision !== revision || sent.queryKey !== queryKey) { dirty = false; dispatch(); return; }
    accepted(message.result, sent.rows);
  }
  function ensureWorker() {
    if (worker) return true;
    try { worker = createWorker(); } catch { worker = null; }
    if (!worker) return false;
    const owner = worker;
    worker.onmessage = event => receive(event.data, owner);
    worker.onerror = () => { if (owner === worker) failure('WORKER_FAILED', tr('日志过滤线程已停止，上一视图已保留，请重试。')); };
    worker.postMessage({ type: 'sync', generation, revision, reset: true, upsertRows: indexedRows, removedIds: [] }); return true;
  }
  function fallback(sent) {
    if (filter.regex || rules.some(rule => rule.enabled === true)) { failure('WORKER_REQUIRED', tr('正则过滤需要独立线程，当前环境不可用；未在界面线程执行。')); return; }
    let query;
    try { query = createLogQuery(sent.rows, { filter, timeRange, rules, allowRegex: false }); }
    catch { failure('QUERY_FAILED', tr('日志过滤失败，请修改条件后重试；上一视图已保留。')); return; }
    let offset = 0;
    const chunk = () => {
      if (disposed || inflight !== sent) return;
      for (const end = Math.min(sent.rows.length, offset + 100); offset < end; offset++) query.visit(sent.rows[offset], offset);
      if (offset < sent.rows.length) { fallbackTimer = setTimeout(chunk, 0); return; }
      clearTimeout(timer); timer = null; inflight = null;
      if (dirty || sent.revision !== revision || sent.queryKey !== queryKey) { dirty = false; dispatch(); return; }
      accepted(query.finish(), sent.rows);
    };
    fallbackTimer = setTimeout(chunk, 0);
  }
  function dispatch() {
    if (disposed || blockedKey === queryKey && blockedKey) return;
    if (inflight) { dirty = true; return; }
    const sent = { requestId: ++requestId, revision, queryKey, rows: indexedRows };
    publish({ pending: true, selectionPending: !hasGood || acceptedScope !== scope || acceptedQueryKey !== queryKey, error: '', errorCode: '' }); inflight = sent;
    timer = setTimeout(() => { if (inflight === sent) {
      const ruleTimeout = !filter.regex && rules.some(rule => rule.enabled === true);
      failure(ruleTimeout ? 'RULE_TIMEOUT' : 'QUERY_TIMEOUT', ruleTimeout ? tr('日志规则匹配超时，已终止独立线程并保留上一视图；请修改或停用相关规则。') : tr('日志过滤超时，已终止独立线程并保留上一视图；请缩小范围或修改正则。'));
    } }, timeoutMs);
    try {
      if (ensureWorker()) worker.postMessage({ type: 'query', generation, revision, requestId: sent.requestId, filter, timeRange, rules });
      else fallback(sent);
    } catch { failure('WORKER_FAILED', tr('日志过滤线程已停止，上一视图已保留，请重试。')); }
  }
  function sync(rows, reset = false) {
    if (reset) {
      rowMap.clear(); positions.clear(); sequence = 0;
      for (const row of rows) { if (!row || !(typeof row.id === 'string' || Number.isFinite(row.id))) continue; positions.set(row.id, sequence++); rowMap.set(row.id, row); }
      indexedRows = rows; revision++;
      if (worker) worker.postMessage({ type: 'sync', generation, revision, reset: true, upsertRows: rows, removedIds: [] });
      return true;
    }
    // The normal ring path retains object identities in order. Check overlap by reference,
    // not by numeric/sorted IDs, then touch only evicted/new records in the maps and IPC.
    if (!reset && indexedRows.length && rows.length) {
      const start = indexedRows.indexOf(rows[0]), retained = start < 0 ? 0 : indexedRows.length - start;
      if (retained > 0 && retained <= rows.length && rows[retained - 1] === indexedRows.at(-1)) {
        let same = true; for (let index = 0; index < retained; index++) if (rows[index] !== indexedRows[start + index]) { same = false; break; }
        if (same) {
          const removedIds = indexedRows.slice(0, start).map(row => row.id), upsertRows = rows.slice(retained);
          if (!removedIds.length && !upsertRows.length) return false;
          for (const id of removedIds) { rowMap.delete(id); positions.delete(id); }
          for (const row of upsertRows) { if (!positions.has(row.id)) positions.set(row.id, sequence++); rowMap.set(row.id, row); }
          indexedRows = rows; revision++;
          if (worker) worker.postMessage({ type: 'sync', generation, revision, reset: false, upsertRows, removedIds });
          return true;
        }
      }
    }
    const upsertRows = [], removedIds = [], keep = new Set(); let lastPosition = -1, newSeen = false, reorder = false;
    for (const row of rows) {
      if (!row || !(typeof row.id === 'string' || Number.isFinite(row.id))) continue;
      keep.add(row.id);
      if (!rowMap.has(row.id)) newSeen = true;
      else { const at = positions.get(row.id); if (newSeen || at < lastPosition) reorder = true; lastPosition = at; }
      if (rowMap.get(row.id) !== row) upsertRows.push(row);
    }
    for (const id of rowMap.keys()) if (!keep.has(id)) removedIds.push(id);
    reset ||= reorder;
    const changed = reset || upsertRows.length > 0 || removedIds.length > 0;
    if (!changed) return false;
    if (reset) { rowMap.clear(); positions.clear(); sequence = 0; }
    for (const id of removedIds) { rowMap.delete(id); positions.delete(id); }
    for (const row of reset ? rows : upsertRows) { if (!positions.has(row.id)) positions.set(row.id, sequence++); rowMap.set(row.id, row); }
    indexedRows = rows; revision++;
    if (worker) worker.postMessage({ type: 'sync', generation, revision, reset, upsertRows: reset ? rows : upsertRows, removedIds: reset ? [] : removedIds });
    return true;
  }
  function update(config) {
    if (disposed) return;
    const rows = Array.isArray(config.entries) ? config.entries : [], bounded = boundLogWindow(rows, { limit: LOG_WORKBENCH_LIMIT }), nextRows = bounded.entries;
    const nextScope = String(config.scopeKey || ''), nextKey = querySignature(config);
    const changedScope = nextScope !== scope, changedQuery = nextKey !== queryKey, nextPaused = config.paused === true;
    if (changedScope) { stop(); rowMap.clear(); positions.clear(); indexedRows = []; latestRows = []; lastGoodRows = []; hasGood = false; acceptedScope = null; acceptedQueryKey = ''; scope = nextScope; paused = false; blockedKey = ''; revision = 0; state = empty(); sourceOmittedRows = 0; }
    sourceOmittedRows = Math.max(sourceOmittedRows, bounded.omittedRows);
    if (changedQuery) { if (inflight) stop(); blockedKey = ''; }
    filter = { ...(config.filter || {}) }; rules = config.rules || []; timeRange = config.timeRange ? { ...config.timeRange } : undefined; queryKey = nextKey;
    if (nextPaused) {
      if (!paused) { stop(); paused = true; if (hasGood) sync(lastGoodRows, true); else sync(nextRows, true); const frozenIds = new Set(indexedRows.map(row => row.id)); publish({ pendingCount: nextRows.filter(row => !frozenIds.has(row.id)).length }); }
      else if (nextRows !== latestRows) { const previousIds = new Set(latestRows.map(row => row.id)); publish({ pendingCount: state.pendingCount + nextRows.filter(row => !previousIds.has(row.id)).length }); }
      latestRows = nextRows;
      if (changedQuery || changedScope || !hasGood) dispatch();
      return;
    }
    const resumed = paused; paused = false; latestRows = nextRows;
    const changedRows = sync(nextRows, changedScope || resumed);
    if (resumed) publish({ pendingCount: 0 });
    if (changedRows || changedQuery || changedScope) dispatch();
  }
  return { update, getSnapshot: () => state, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    isSelectionCurrent: config => hasGood && acceptedScope === String(config.scopeKey || '') && acceptedQueryKey === querySignature(config),
    activate() { if (disposed) { disposed = false; scope = null; blockedKey = ''; } },
    cancel() { blockedKey = queryKey; stop(); publish({ pending: false, errorCode: 'QUERY_CANCELLED', error: tr('已取消过滤，上一视图保持不变。') }); },
    retry() { blockedKey = ''; stop(); dispatch(); }, dispose() { disposed = true; stop(); listeners.clear(); } };
}
