const { parentPort, workerData } = require('node:worker_threads');
const { compileLogFilter } = require('./log-filter-policy.cjs');
const filter = compileLogFilter(workerData.filter), { offset, limit, tail } = workerData;
let total = 0, next = 0, filled = 0;
const indices = [], levels = Object.assign(Object.create(null), { V: 0, D: 0, I: 0, W: 0, E: 0, F: 0, A: 0 });
if (filter.invalidRegex) { parentPort.postMessage({ type: 'error', code: 'LOG_FILTER_INVALID_REGEX' }); parentPort.close(); }
else {
  parentPort.on('message', message => {
    try {
      if (message.type === 'batch') {
        for (const row of message.rows) {
          if (!filter.predicate(row)) continue;
          total++; if (row.level) levels[row.level] = (levels[row.level] ?? 0) + 1;
          if (!limit) continue;
          if (tail) { indices[next] = row.index; next = (next + 1) % limit; filled = Math.min(limit, filled + 1); }
          else if (total > offset && indices.length < limit) indices.push(row.index);
        }
        parentPort.postMessage({ type: 'ack', batchId: message.batchId });
      } else if (message.type === 'finish') {
        const output = tail && filled === limit ? Array.from({ length: filled }, (_, index) => indices[(next + index) % limit]) : indices;
        parentPort.postMessage({ type: 'result', total, levels: { ...levels }, indices: output }); parentPort.close();
      }
    } catch { parentPort.postMessage({ type: 'error', code: 'LOG_FILTER_INPUT' }); parentPort.close(); }
  });
  parentPort.postMessage({ type: 'ready' });
}
