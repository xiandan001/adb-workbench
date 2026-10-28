const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { tr, getLocale } = require('./localization.cjs');

function transformRunManifest(filename, { WorkerClass = Worker, timeoutMs = 15000 } = {}) {
  const original = path.join(__dirname, 'artifact-export-transform-worker.cjs');
  const unpacked = original.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  const workerPath = unpacked !== original && fs.existsSync(unpacked) ? unpacked : original;
  return new Promise((resolve, reject) => {
    let worker, timer, settled = false;
    const finish = async result => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { await worker?.terminate(); } catch { /* The worker may already be gone. */ }
      if (result?.ok === true && Number.isSafeInteger(result.bytes) && result.bytes >= 0 && result.bytes <= 8 * 1024 * 1024) resolve({ bytes: result.bytes, excludedFields: result.excludedFields || [] });
      else reject(new Error(tr('无法安全排除私有任务快照，证据包未导出；原文件保持不变。')));
    };
    try {
      worker = new WorkerClass(workerPath, { workerData: { path: filename, locale: getLocale() }, resourceLimits: { maxOldGenerationSizeMb: 96 } });
      worker.once('message', finish); worker.once('error', () => finish()); worker.once('exit', () => finish());
      timer = setTimeout(() => finish(), timeoutMs);
    } catch { void finish(); }
  });
}

module.exports = { transformRunManifest };
