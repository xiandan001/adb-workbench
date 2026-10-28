const path = require('node:path');
const fs = require('node:fs');
const { Worker } = require('node:worker_threads');
const { tr } = require('./localization.cjs');

function outboundWorkerPath(directory = __dirname, exists = fs.existsSync) {
  const candidate = path.join(directory, 'ai-outbound-worker.cjs').replace(/([\\/])app\.asar([\\/])/i, '$1app.asar.unpacked$2');
  if (!exists(candidate)) throw Object.assign(new Error(tr('AI 预览处理器异常，未发送。')), { code: 'AI_SEND_WORKER' });
  return candidate;
}

function runOutboundJob(data, { locale, signal } = {}) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error(tr('AI 发送已取消。')), { code: 'AI_SEND_CANCELLED', name: 'AbortError' }));
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(outboundWorkerPath(), { workerData: { ...data, locale }, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    const finish = (error, value) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(Object.assign(new Error(tr('AI 发送已取消。')), { code: 'AI_SEND_CANCELLED', name: 'AbortError' }));
    const timer = setTimeout(() => finish(Object.assign(new Error(tr('AI 预览准备超时，未发送。')), { code: 'AI_SEND_TIMEOUT' })), 30000);
    worker.once('message', value => value.ok ? finish(null, value.result) : finish(Object.assign(new Error(value.error), { code: value.code })));
    worker.once('error', () => finish(Object.assign(new Error(tr('AI 预览处理器异常，未发送。')), { code: 'AI_SEND_WORKER' })));
    worker.once('exit', () => { if (!settled) finish(Object.assign(new Error(tr('AI 预览处理器异常，未发送。')), { code: 'AI_SEND_WORKER' })); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
const prepareOutbound = (bodies, options) => runOutboundJob({ operation: 'requests', bodies, contentFormat: options?.contentFormat }, options);
function sanitizeTaskArtifact(artifact, options) {
  if (typeof artifact?.text !== 'string' || artifact.text.length > 512 * 1024) return Promise.reject(Object.assign(new Error(tr('任务结果文件不完整或格式无效，不能安全排除私有脚本；请使用任务结果分析入口。')), { code: 'AI_HANDOFF_PRIVATE_REPORT' }));
  return runOutboundJob({ operation: 'artifact', artifact }, options);
}
module.exports = { prepareOutbound, outboundWorkerPath, sanitizeTaskArtifact };
