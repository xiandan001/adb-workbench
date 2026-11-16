const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setLocale, tr } = require('./localization.cjs');
const { normalizeSession } = require('./log-sessions.cjs');
const { compareSessions, exportContents } = require('./log-session-operations.cjs');
setLocale(workerData.locale);
const cancellation = new AbortController();
parentPort.on('message', message => { if (message?.action === 'cancel') cancellation.abort(); });
async function run() {
  const { operation, payload, maxBytes } = workerData;
  if (operation === 'decode') {
    const data = JSON.parse(Buffer.from(payload.bytes).toString('utf8'));
    if (data.schemaVersion !== 1 || data.id !== payload.id || typeof data.savedAt !== 'string' || !Number.isFinite(Date.parse(data.savedAt))) throw Error(tr('不支持的会话格式'));
    return { ...normalizeSession(data), id: data.id, savedAt: data.savedAt };
  }
  if (operation === 'encode') {
    const session = { ...normalizeSession(payload.input), id: payload.id, savedAt: payload.savedAt };
    const bytes = Buffer.from(JSON.stringify(session));
    if (bytes.length > maxBytes) throw Error(tr('会话超过 64 MB 限制，未保存、未截断。请先导出原始日志后拆分分析'));
    return { bytes, summary: { id: session.id, name: session.name, savedAt: session.savedAt, entryCount: session.entries.length,
      deviceId: session.deviceId, source: session.source, markerCount: session.markers.length } };
  }
  if (operation === 'compare') return compareSessions(payload.before, payload.after);
  if (operation === 'export' || operation === 'preview') {
    const session = normalizeSession(payload.input), files = exportContents(session, payload.options);
    const bytes = Buffer.byteLength(files.raw) + Buffer.byteLength(JSON.stringify(files.markers)) + Buffer.byteLength(files.report);
    if (bytes > maxBytes) throw Error(tr('导出超过 64 MiB 限制；未写入或截断。'));
    if (operation === 'preview') return { lines: files.raw.split('\n', 8).map(line => line.slice(0, 2000)), entryCount: session.entries.length, redacted: true };
    cancellation.signal.throwIfAborted();
    if (payload.options.format === 'raw') return { bytes: Buffer.from(files.raw), entryCount: session.entries.length };
    await fs.mkdir(payload.staging, { recursive: false });
    await fs.writeFile(path.join(payload.staging, 'logs.log'), files.raw);
    await fs.writeFile(path.join(payload.staging, 'markers.json'), JSON.stringify(files.markers, null, 2));
    await fs.writeFile(path.join(payload.staging, 'manifest.json'), JSON.stringify(files.manifest, null, 2));
    if (payload.options.includeAi) await fs.writeFile(path.join(payload.staging, 'analysis.md'), files.report);
    await require('./artifact-export.cjs').exportArtifact({ type: 'log-session', title: files.title, rootPath: payload.staging }, payload.bundle,
      { temporaryDirectory: path.dirname(payload.staging), signal: cancellation.signal });
    return { entryCount: session.entries.length, bundle: payload.bundle };
  }
  throw Error(tr('会话操作无效。'));
}
run().then(result => parentPort.postMessage({ ok: true, result }), failure => parentPort.postMessage({ ok: false, error: failure.message }));
