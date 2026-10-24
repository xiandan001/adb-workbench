const { tr, getLocale } = require('./localization.cjs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { fail } = require('./ai-tools-file-safety.cjs');
const { createAiToolsSessionArchives } = require('./ai-tools-session-archives.cjs');

function createAiToolsSessions({ home, directory, canEncrypt, encrypt, decrypt, timeoutMs = 60000 } = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw fail('AI_TOOLS_SESSION_PATH', tr("会话根目录无效"));
  const archives = directory ? createAiToolsSessionArchives({ directory, home, canEncrypt, encrypt, decrypt }) : null;
  let worker; let disposed = false; let sequence = 0; let generation = 0; let scanning = false; let scanAbort; const pending = new Map(); const archiveIndex = new Map();
  function rejectAll(error) { for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error); } pending.clear(); scanning = false; }
  function initialize() {
    if (worker) return;
    const workerPath = path.join(__dirname, 'ai-tools-sessions-worker.cjs').replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
    const instance = new Worker(workerPath, { workerData: { home, locale: getLocale() }, resourceLimits: { maxOldGenerationSizeMb: 192 } });
    worker = instance;
    instance.on('message', reply => { if (worker !== instance) return; const task = pending.get(reply.id); if (!task) return; pending.delete(reply.id); clearTimeout(task.timer); reply.error ? task.reject(fail(reply.error.code, reply.error.message)) : task.resolve(reply.result); });
    instance.on('error', () => { if (worker === instance) { worker = null; rejectAll(fail('AI_TOOLS_SESSION_FAILED', tr("会话后台任务失败，源文件未修改"))); } });
    instance.on('exit', () => { if (worker === instance) { worker = null; rejectAll(fail('AI_TOOLS_SESSION_EXIT', tr("会话后台任务已退出，请重新扫描"))); } });
  }
  function request(command, args = {}, internal = false, transfer = []) {
    if (disposed) return Promise.reject(fail('AI_TOOLS_DISPOSED', tr("会话管理已退出")));
    if (!internal && scanning || pending.size >= 4) return Promise.reject(fail('AI_TOOLS_BUSY', tr("会话后台正在读取，请稍后重试")));
    initialize();
    return new Promise((resolve, reject) => {
      const id = ++sequence; const timer = setTimeout(() => { const current = worker; worker = null; rejectAll(fail('AI_TOOLS_SESSION_TIMEOUT', tr("会话读取超时，任务已停止；源文件未修改"))); void current?.terminate(); }, timeoutMs);
      pending.set(id, { command, resolve, reject, timer });
      try { worker.postMessage({ id, command, args, locale: getLocale() }, transfer); }
      catch { pending.delete(id); clearTimeout(timer); reject(fail('AI_TOOLS_SESSION_FAILED', tr("会话后台数据传输失败，请重新扫描"))); }
    });
  }
  async function cancelPending() {
    generation++; scanAbort?.abort(); scanAbort = null; archiveIndex.clear();
    const current = worker; worker = null;
    rejectAll(fail('AI_TOOLS_CANCELLED', tr("会话读取已取消"))); await current?.terminate();
  }
  function rawTransfer(raw) { const copy = new Uint8Array(raw.length); copy.set(raw); return copy.buffer; }
  async function scan() {
    if (disposed) throw fail('AI_TOOLS_DISPOSED', tr("会话管理已退出"));
    if (scanning || pending.size) throw fail('AI_TOOLS_BUSY', tr("会话后台正在读取，请稍后重试"));
    scanning = true; const current = ++generation; const abort = new AbortController(); scanAbort = abort; archiveIndex.clear();
    try {
      await request('scan', {}, true);
      if (archives) await archives.visitArchives(async ({ record, raw, hash }) => {
        if (current !== generation || abort.signal.aborted) throw fail('AI_TOOLS_CANCELLED', tr("会话读取已取消"));
        const buffer = rawTransfer(raw); const metadata = { id: record.id, toolId: record.toolId, format: record.format, sourceName: record.sourceName, modifiedAt: record.modifiedAt, bytes: record.bytes };
        const result = await request('archive-index', { metadata, raw: buffer }, true, [buffer]);
        if (result.indexed && current === generation) archiveIndex.set(record.id, hash);
      }, { signal: abort.signal });
      if (current !== generation || abort.signal.aborted) throw fail('AI_TOOLS_CANCELLED', tr("会话读取已取消"));
      return await request('scan-finish', {}, true);
    } catch (error) { if (current === generation) await cancelPending(); throw error; }
    finally { if (current === generation) { scanning = false; scanAbort = null; } }
  }
  function open(args = {}) {
    if (disposed) return Promise.reject(fail('AI_TOOLS_DISPOSED', tr("会话管理已退出")));
    if (scanning || pending.size >= 4) return Promise.reject(fail('AI_TOOLS_BUSY', tr("会话后台正在读取，请稍后重试")));
    if (!archiveIndex.has(args.id)) return request('open', args);
    try { const source = archives.readForViewer({ id: args.id, expectedHash: archiveIndex.get(args.id) }); const buffer = rawTransfer(source.raw); return request('open', { id: args.id, offset: args.offset, raw: buffer }, false, [buffer]); }
    catch (error) { return Promise.reject(error); }
  }
  return { scan, list: args => request('list', args), open,
    cancelPending,
    async dispose() { disposed = true; archives?.dispose(); await cancelPending(); } };
}

module.exports = { createAiToolsSessions };
