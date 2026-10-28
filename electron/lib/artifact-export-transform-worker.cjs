const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const { tr, setLocale, normalizeLocale } = require('./localization.cjs');
setLocale(normalizeLocale(workerData.locale));
const failure = () => new Error(tr('无法安全排除私有任务快照，证据包未导出；原文件保持不变。'));

async function transform() {
  const stat = await fs.lstat(workerData.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw failure();
  const text = await fs.readFile(workerData.path, 'utf8');
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw failure();
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure();
  if (!Object.hasOwn(data, 'rerunSnapshot')) return { bytes: stat.size, excludedFields: [] };
  delete data.rerunSnapshot;
  const safe = JSON.stringify(data) + '\n';
  const bytes = Buffer.byteLength(safe);
  if (bytes > 8 * 1024 * 1024) throw failure();
  await fs.writeFile(workerData.path, safe, 'utf8');
  return { bytes, excludedFields: ['rerunSnapshot'] };
}
transform().then(result => parentPort.postMessage({ ok: true, ...result }), () => parentPort.postMessage({ ok: false }));
