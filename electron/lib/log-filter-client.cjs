const path = require('node:path'), { Worker } = require('node:worker_threads');
const { normalizeFilter } = require('./log-filter-policy.cjs');
const { tr } = require('./localization.cjs');
const FILTER_LIMITS = Object.freeze({ tasks: 2, inputRows: 200000, inputBytes: 120 * 1024 * 1024, batchRows: 500, batchBytes: 2 * 1024 * 1024,
  outputRows: 50000, outputBytes: 16 * 1024 * 1024, deadlineMs: 250, totalMs: 30000 });
const fault = code => Object.assign(new Error(code === 'LOG_FILTER_CANCELLED' ? tr('日志筛选已取消，原始日志保持不变。')
  : code === 'LOG_FILTER_INVALID_REGEX' ? tr('日志筛选正则表达式无效，请检查后重试。')
    : code === 'LOG_FILTER_TIMEOUT' ? tr('日志筛选执行超时，已停止后台任务；原始日志保持不变。')
      : code === 'LOG_FILTER_BUSY' ? tr('后台日志筛选正忙，请稍后重试。') : tr('日志筛选超过安全限制或未完成，请缩小范围后重试。')), { code });
function projectEntry(entry, filter, index) {
  if (!entry || typeof entry !== 'object') throw fault('LOG_FILTER_INPUT');
  const row = { index };
  const keys = ['level', ...(typeof filter.pid === 'number' ? ['pid'] : []), ...(filter.pkg ? ['pkg', 'processName'] : []),
    ...(filter.tag ? ['tag'] : []), ...(filter.domain ? ['domain'] : []), ...(filter.text || filter.excludeText || filter.regex ? ['raw'] : [])];
  let bytes = 64;
  for (const key of keys) {
    if (entry[key] === undefined) continue;
    const value = entry[key];
    if (typeof value !== 'string' && typeof value !== 'number') throw fault('LOG_FILTER_INPUT');
    row[key] = value; bytes += typeof value === 'string' ? Buffer.byteLength(value) + 16 : 16;
  }
  return { row, bytes };
}
function createLogFilterClient({ WorkerClass = Worker, deadlineMs = FILTER_LIMITS.deadlineMs, maxTasks = FILTER_LIMITS.tasks } = {}) {
  let active = 0;
  function query(entries, filterInput = {}, { offset = 0, limit = 1000, tail = false, signal, owner } = {}) {
    if (active >= maxTasks) return Promise.reject(fault('LOG_FILTER_BUSY'));
    let filter;
    try { filter = normalizeFilter(filterInput); } catch { return Promise.reject(fault('LOG_FILTER_INPUT')); }
    if (!Array.isArray(entries) || entries.length > FILTER_LIMITS.inputRows || !Number.isSafeInteger(offset) || offset < 0
      || !Number.isSafeInteger(limit) || limit < 0 || limit > FILTER_LIMITS.outputRows || typeof tail !== 'boolean') return Promise.reject(fault('LOG_FILTER_INPUT'));
    if (signal?.aborted || owner?.isDestroyed?.()) return Promise.reject(fault('LOG_FILTER_CANCELLED'));
    const snapshot = [...entries]; active++;
    return new Promise((resolve, reject) => {
      let worker, settled = false, cursor = 0, inputBytes = 0, batchId = 0, timer, totalTimer, immediate;
      const abort = () => finish(fault('LOG_FILTER_CANCELLED'));
      const navigate = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) abort(); };
      function finish(error, result) {
        if (settled) return; settled = true; active--; clearTimeout(timer); clearTimeout(totalTimer); clearImmediate(immediate);
        signal?.removeEventListener('abort', abort); owner?.removeListener?.('destroyed', abort); owner?.removeListener?.('did-start-navigation', navigate);
        worker?.unref?.(); if (worker) Promise.resolve(worker.terminate()).catch(() => {});
        if (error) reject(error); else resolve(result);
      }
      function arm() { clearTimeout(timer); timer = setTimeout(() => finish(fault('LOG_FILTER_TIMEOUT')), deadlineMs); }
      function send() {
        if (settled) return;
        try {
          const rows = []; let bytes = 0;
          while (cursor < snapshot.length && rows.length < FILTER_LIMITS.batchRows) {
            const projected = projectEntry(snapshot[cursor], filter, cursor);
            if (projected.bytes > FILTER_LIMITS.batchBytes) throw fault('LOG_FILTER_INPUT');
            if (rows.length && bytes + projected.bytes > FILTER_LIMITS.batchBytes) break;
            rows.push(projected.row); bytes += projected.bytes; cursor++;
          }
          inputBytes += bytes; if (inputBytes > FILTER_LIMITS.inputBytes) throw fault('LOG_FILTER_INPUT');
          arm(); worker.postMessage(rows.length ? { type: 'batch', batchId: ++batchId, rows } : { type: 'finish' });
        } catch (error) { finish(error); }
      }
      signal?.addEventListener('abort', abort, { once: true });
      owner?.once?.('destroyed', abort); owner?.on?.('did-start-navigation', navigate);
      try {
        const filename = path.join(__dirname, 'log-filter-worker.cjs').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
        worker = new WorkerClass(filename, { workerData: { filter, offset, limit, tail } });
        timer = setTimeout(() => finish(fault('LOG_FILTER_TIMEOUT')), 10000);
        totalTimer = setTimeout(() => finish(fault('LOG_FILTER_TIMEOUT')), FILTER_LIMITS.totalMs);
        worker.on('message', message => {
          if (settled) return;
          if (message.type === 'ready') { clearTimeout(timer); immediate = setImmediate(send); }
          else if (message.type === 'ack') {
            if (message.batchId !== batchId) { finish(fault('LOG_FILTER_INPUT')); return; }
            clearTimeout(timer); immediate = setImmediate(send);
          } else if (message.type === 'error') finish(fault(message.code));
          else if (message.type === 'result') {
            try {
              if (!Array.isArray(message.indices) || message.indices.length > limit || message.indices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= snapshot.length)
                || !Number.isSafeInteger(message.total) || message.total < message.indices.length || message.total > snapshot.length) throw fault('LOG_FILTER_INPUT');
              const selected = message.indices.map(index => snapshot[index]); let bytes = 0;
              for (const entry of selected) {
                for (const value of Object.values(entry)) bytes += typeof value === 'string' ? Buffer.byteLength(value) : 16;
                if (bytes > FILTER_LIMITS.outputBytes) throw fault('LOG_FILTER_RESULT_LIMIT');
              }
              finish(null, { entries: selected, total: message.total, levels: message.levels, offset, limit });
            } catch (error) { finish(error); }
          }
        });
        worker.on('error', () => finish(fault('LOG_FILTER_WORKER')));
        worker.on('exit', () => { if (!settled) finish(fault('LOG_FILTER_WORKER')); });
      } catch { finish(fault('LOG_FILTER_WORKER')); }
    });
  }
  return { query, state: () => ({ active, maxTasks }) };
}
const shared = createLogFilterClient();
module.exports = { FILTER_LIMITS, createLogFilterClient, queryLogEntries: (...args) => shared.query(...args) };
