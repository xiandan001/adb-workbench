const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { getLocale, tr } = require('./localization.cjs');
const error = (code, message) => Object.assign(new Error(message), { code, safe: true });

function createWorkspaceProcessor({ workerFactory, timeoutMs = 30000 } = {}) {
  let worker, sequence = 0, disposed = false;
  const pending = new Map();
  const inflight = new Set();
  function finish(id, result, failure) {
    const entry = pending.get(id); if (!entry) return;
    pending.delete(id); clearTimeout(entry.timer); entry.signal?.removeEventListener('abort', entry.abort);
    if (!pending.size) worker?.unref();
    failure ? entry.reject(failure) : entry.resolve(result);
  }
  function rejectAll(failure) { inflight.clear(); for (const id of [...pending.keys()]) finish(id, null, failure); }
  function ensureWorker() {
    if (worker) return;
    const filename = path.join(__dirname, 'ai-workspace-worker.cjs').replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
    const instance = workerFactory ? workerFactory(filename) : new Worker(filename, { resourceLimits: { maxOldGenerationSizeMb: 192 } });
    worker = instance;
    instance.on('message', response => { if (worker === instance) { inflight.delete(response.id); finish(response.id, response.result, response.error ? error(response.error.code, response.error.message) : null); } });
    const failed = () => { if (worker === instance) { worker = null; rejectAll(error('AI_WORKER_FAILED', tr('AI 本机后台操作未完成，请重试。'))); } };
    instance.on('error', failed); instance.on('exit', failed); instance.unref();
  }
  function run(command, args, { signal, locale = getLocale() } = {}) {
    if (disposed || signal?.aborted) return Promise.reject(error('CANCELLED', tr('操作已取消')));
    if (inflight.size >= 8) return Promise.reject(error('AI_WORKER_BUSY', tr('AI 本机后台队列已满，请稍后重试。')));
    ensureWorker(); worker.ref();
    return new Promise((resolve, reject) => {
      const id = ++sequence, cancelBuffer = new SharedArrayBuffer(4), flag = new Int32Array(cancelBuffer);
      const abort = () => { Atomics.store(flag, 0, 1); finish(id, null, error('CANCELLED', tr('操作已取消'))); };
      const timer = setTimeout(() => {
        for (const entry of pending.values()) Atomics.store(entry.flag, 0, 1);
        const old = worker; worker = null;
        rejectAll(error('AI_WORKER_TIMEOUT', tr('AI 本机后台处理超时，请缩小范围后重试。'))); void old?.terminate();
      }, timeoutMs);
      inflight.add(id);
      pending.set(id, { resolve, reject, signal, abort, timer, flag }); signal?.addEventListener('abort', abort, { once: true });
      try { worker.postMessage({ id, command, args, locale, cancelBuffer }); } catch { inflight.delete(id); finish(id, null, error('AI_WORKER_FAILED', tr('AI 本机后台操作未完成，请重试。'))); }
      if (signal?.aborted) abort();
    });
  }
  async function dispose() {
    disposed = true;
    for (const entry of pending.values()) Atomics.store(entry.flag, 0, 1);
    const old = worker; worker = null; rejectAll(error('CANCELLED', tr('操作已取消'))); await old?.terminate();
  }
  return { run, dispose };
}
let shared;
function runWorkspaceJob(command, args, options) { shared ||= createWorkspaceProcessor(); return shared.run(command, args, options); }
async function cleanupWorkspaceProcessor() { const current = shared; shared = null; await current?.dispose(); }
function createWorkerReportStore({ directory, casebook = false, processor = runWorkspaceJob }) {
  const prefix = casebook ? 'casebook:' : 'history:';
  const call = (method, args, options) => processor(prefix + method, { directory, ...args }, options);
  return {
    list: (query = {}, options) => call('list', { query }, options),
    load: (id, options) => call('load', { id }, options),
    save: casebook ? (report, name, review, options) => call('save', { report, name, review }, options)
      : (report, name, options) => call('save', { report, name }, options),
    update: (id, revision, review, options) => call('update', { id, revision, review }, options),
    delete: (id, options) => call('delete', { id }, options),
    similar: (report, limit, options) => call('similar', { report, limit }, options),
  };
}
module.exports = { createWorkspaceProcessor, runWorkspaceJob, cleanupWorkspaceProcessor, createWorkerReportStore };
