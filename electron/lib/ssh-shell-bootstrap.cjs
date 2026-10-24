const { tr } = require('./localization.cjs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const failure = () => Object.assign(new Error(tr("无法准备 Bash 命令识别，请检查 SFTP 写入权限或重新打开终端")), { code: 'SSH_SHELL_BOOTSTRAP_FAILED' });

async function installBashIntegration({ getSftp, signal, assertCurrent, script, write, launch, waitReady, timeoutMs = 15000, cleanupTimeoutMs = 2000 }) {
  let sftp;
  let ownedPath;
  let targetPath;
  let handle;
  let openPending = false;
  let finishOpen;
  let cleanupFinalized = false;
  const openFinished = new Promise(resolve => { finishOpen = resolve; });
  function check() { assertCurrent(); if (signal?.aborted) throw failure(); }
  function cleanupCall(method, ...args) {
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), cleanupTimeoutMs);
      try { sftp[method](...args, error => { clearTimeout(timer); resolve(!error || error.code === 2); }); }
      catch { clearTimeout(timer); resolve(false); }
    });
  }
  function call(method, args, late, completed) {
    return new Promise((resolve, reject) => {
      let settled = false; let cancelled = false;
      const finish = (error, result) => {
        if (settled) { if (cancelled && !error) late?.(result); return; }
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(failure()); else { try { check(); resolve(result); } catch { late?.(result); reject(failure()); } }
      };
      const abort = () => { cancelled = true; finish(failure()); };
      const timer = setTimeout(abort, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      let answered = false;
      const callback = (error, result) => { if (!answered) { answered = true; completed?.(); } finish(error, result); };
      try { check(); sftp[method](...args, callback); } catch { callback(failure()); }
    });
  }
  function abortable(promise) {
    return new Promise((resolve, reject) => {
      const abort = () => reject(failure());
      if (signal?.aborted) { Promise.resolve(promise).catch(() => {}); reject(failure()); return; }
      signal?.addEventListener('abort', abort, { once: true });
      Promise.resolve(promise).then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
    });
  }
  let cleanupFailed = false;
  let operationError;
  try {
    check(); sftp = await abortable(getSftp()); check();
    const home = await call('realpath', ['.']);
    if (typeof home !== 'string' || !home.startsWith('/') || home.length > 3000
      || Array.from(home).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw failure();
    const target = targetPath = path.posix.join(home, `.adb-workbench-shell-${randomUUID()}.bash`);
    openPending = true;
    handle = await call('open', [target, 'wx', { mode: 0o600 }], lateHandle => {
      // Only a successful O_EXCL callback owns this exact randomly named file.
      if (!cleanupFinalized) { handle = lateHandle; ownedPath = target; }
      else void cleanupCall('close', lateHandle).then(() => cleanupCall('unlink', target));
    }, () => { openPending = false; finishOpen(); });
    ownedPath = target;
    const bytes = Buffer.from(script, 'utf8');
    if (!bytes.length || bytes.length > 32 * 1024) throw failure();
    await call('write', [handle, bytes, 0, bytes.length, 0]);
    await call('close', [handle]); handle = null;
    check();
    await abortable(launch ? launch(target) : write(` . '${target.replaceAll("'", "'\\''")}'\r`));
    await abortable(waitReady);
    check();
  } catch (error) { operationError = error?.code?.startsWith('SSH_') ? error : failure(); }
  finally {
    if (openPending) {
      let timer;
      await Promise.race([openFinished, new Promise(resolve => { timer = setTimeout(resolve, cleanupTimeoutMs); })]);
      clearTimeout(timer);
      if (openPending) cleanupFailed = true;
    }
    if (handle) await cleanupCall('close', handle);
    if (ownedPath && !await cleanupCall('unlink', ownedPath)) cleanupFailed = true;
    cleanupFinalized = true;
  }
  if (cleanupFailed) throw Object.assign(new Error(tr("命令识别临时脚本可能未清理，请在服务器检查：{0}", { 0: ownedPath || targetPath })),
    { code: 'SSH_SHELL_CLEANUP_FAILED', temporaryPath: ownedPath || targetPath });
  if (operationError) throw operationError;
}

module.exports = { installBashIntegration };
