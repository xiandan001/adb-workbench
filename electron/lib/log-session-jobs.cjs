const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { getLocale, tr } = require('./localization.cjs');
const queue = [], pending = new Set(); let active = null;
const cancelled = () => Object.assign(new Error(tr('会话操作已取消；当前内容保持不变。')), { code: 'CANCELLED' });
function advance() {
  if (active || !queue.length) return;
  const job = active = queue.shift();
  if (job.signal?.aborted) { job.finish(cancelled()); return; }
  const filename = path.join(__dirname, 'log-session-worker.cjs').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  let worker;
  try { worker = new Worker(filename, { workerData: { operation: job.operation, payload: job.payload, maxBytes: job.maxBytes, locale: job.locale }, resourceLimits: { maxOldGenerationSizeMb: 512 } }); }
  catch (failure) { job.finish(failure); return; }
  job.worker = worker;
  job.timer = setTimeout(() => job.operation === 'export' ? job.cancel() : job.finish(new Error(tr('会话操作超时，请缩小范围后重试。'))), job.operation === 'export' ? 240000 : 120000);
  worker.once('message', message => job.cancelRequested ? job.finish(cancelled()) : message.ok ? job.finish(null, message.result) : job.finish(new Error(tr(message.error))));
  worker.once('error', failure => job.finish(failure));
  worker.once('exit', code => { if (!job.done) job.finish(new Error(tr('会话处理进程意外结束，请重试。') + ` (${code})`)); });
}
function runSessionJob(operation, payload, { signal, maxBytes = 64 * 1024 * 1024 } = {}) {
  if (signal?.aborted) return Promise.reject(cancelled());
  if (queue.length + Number(Boolean(active)) >= 4) return Promise.reject(new Error(tr('会话操作队列已满，请等待当前操作完成。')));
  const completion = new Promise((resolve, reject) => {
    const job = { operation, payload, signal, maxBytes, locale: getLocale(), finish(failure, result) {
      if (job.done) return; job.done = true; clearTimeout(job.timer); signal?.removeEventListener('abort', abort);
      const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1);
      const termination = job.worker?.terminate();
      const settle = () => { if (active === job) active = null; failure ? reject(failure) : resolve(result); advance(); };
      Promise.resolve(termination).then(settle, settle);
    } };
    const abort = job.cancel = () => {
      job.cancelRequested = true;
      // ZIP owns a native child. Let its AbortSignal close the child and run cleanup before terminating its worker.
      if (job.operation === 'export' && job.worker && !job.done) job.worker.postMessage({ action: 'cancel' });
      else job.finish(cancelled());
    };
    signal?.addEventListener('abort', abort, { once: true });
    queue.push(job); advance();
  });
  pending.add(completion); completion.then(() => pending.delete(completion), () => pending.delete(completion));
  return completion;
}
async function cleanupSessionJobs() {
  for (const job of [active, ...queue].filter(Boolean)) job.cancel();
  await Promise.allSettled([...pending]);
}
module.exports = { runSessionJob, cleanupSessionJobs };
