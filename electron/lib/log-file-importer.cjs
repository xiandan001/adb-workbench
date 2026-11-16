const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { createLogCaptureBuffer } = require('./log-capture-buffer.cjs');
const { FILE_LIMITS } = require('./log-file-reader.cjs');
const { tr } = require('./localization.cjs');

const idleImportState = () => ({ requestId: '', status: 'idle', readBytes: 0, totalBytes: 0, lineCount: 0,
  keptCount: 0, keptBytes: 0, omittedLines: 0, omittedBytes: 0, fileName: '', error: '' });
const importFailure = error => error.message === 'LOG_FILE_CHANGED'
  ? tr('读取期间文件发生变化，原视图已保留；请重新导入。') : error.message === 'LOG_FILE_NOT_REGULAR'
    ? tr('请选择普通日志文件，原视图已保留。') : tr('日志文件读取失败：{0}', { 0: error.message });
function createLogFileImporter({ onState = () => {}, onCommit, WorkerClass = Worker } = {}) {
  let active = null, state = idleImportState();
  const publish = changes => { state = { ...state, ...changes }; onState({ ...state }); };
  const current = operation => active === operation && !operation.owner?.isDestroyed?.();
  function detach(operation) {
    operation.owner?.removeListener?.('destroyed', operation.lost);
    operation.owner?.removeListener?.('did-start-navigation', operation.navigation);
  }
  function end(operation, changes) {
    if (active !== operation) return;
    detach(operation); active = null; publish(changes);
    Promise.resolve(operation.worker.terminate()).catch(() => {});
  }
  function cancel(requestId, owner, reason = 'cancelled') {
    if (!active || active.requestId !== requestId || owner && active.owner !== owner) return false;
    end(active, { status: 'cancelled', reason }); return true;
  }
  function start(filePath, owner) {
    if (active) cancel(active.requestId, null, 'superseded');
    const filename = path.join(__dirname, 'log-file-worker.cjs').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
    const requestId = randomUUID(), worker = new WorkerClass(filename, { workerData: { filePath, requestId } });
    const operation = { requestId, owner, worker, filePath, sequence: 0, store: createLogCaptureBuffer(FILE_LIMITS) };
    operation.lost = () => cancel(requestId, owner, 'owner-lost');
    operation.navigation = (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) operation.lost(); };
    active = operation; state = { ...idleImportState(), requestId, status: 'reading', fileName: path.basename(filePath) };
    owner?.once?.('destroyed', operation.lost); owner?.on?.('did-start-navigation', operation.navigation); onState({ ...state });
    worker.on('message', message => {
      if (!current(operation)) { if (active === operation) operation.lost(); return; }
      try {
        if (message.type === 'progress') {
          const stats = message.stats;
          if (stats.requestId !== requestId || ['readBytes', 'totalBytes', 'lineCount', 'keptCount', 'keptBytes', 'omittedLines', 'omittedBytes'].some(key => !Number.isSafeInteger(stats[key]) || stats[key] < 0)
            || stats.keptCount > FILE_LIMITS.maxEntries || stats.keptBytes > FILE_LIMITS.maxBytes || stats.readBytes < state.readBytes || stats.readBytes > stats.totalBytes) throw Error('LOG_IMPORT_INVALID_PROGRESS');
          publish(stats);
        } else if (message.type === 'chunk') {
          if (message.sequence !== operation.sequence++ || !Array.isArray(message.entries) || message.entries.length > 1000) throw Error('LOG_IMPORT_INVALID_CHUNK');
          for (const entry of message.entries) {
            if (!entry || typeof entry.raw !== 'string' || Buffer.byteLength(entry.raw) > FILE_LIMITS.maxLineBytes) throw Error('LOG_IMPORT_INVALID_ENTRY');
            operation.store.push(entry);
          }
          worker.postMessage({ type: 'ack', sequence: message.sequence });
        } else if (message.type === 'done') {
          if (operation.store.length !== message.stats.keptCount || operation.store.bytes !== message.stats.keptBytes || operation.store.truncated) throw Error('LOG_IMPORT_INCOMPLETE');
          onCommit(operation.store.toArray(), { ...message.stats, filePath });
          end(operation, { ...message.stats, status: 'completed' });
        } else if (message.type === 'error') throw Error(message.error);
      } catch (error) { end(operation, { status: 'failed', error: importFailure(error) }); }
    });
    worker.on('error', error => end(operation, { status: 'failed', error: importFailure(error) }));
    worker.on('exit', () => { if (active === operation) end(operation, { status: 'failed', error: tr('日志文件读取未完成，原视图已保留。') }); });
    return { requestId, filePath };
  }
  return { start, cancel, cancelCurrent: reason => active && cancel(active.requestId, null, reason), getState: () => ({ ...state }),
    getProtectedPaths: () => active ? [active.filePath] : [] };
}
module.exports = { createLogFileImporter, idleImportState };
