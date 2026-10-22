const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const policy = require('./ssh-files-policy.cjs');
const io = require('./ssh-files-io.cjs');

const finalStates = new Set(['completed', 'failed', 'cancelled', 'conflict']);
const localMetadata = stat => ({ type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'special', size: stat.size, mtime: stat.mtimeMs, mode: stat.mode, ino: stat.ino });
const sameLocal = (a, b) => policy.sameMetadata(a, b) && a.ino === b.ino;
async function maybeLocal(p) { try { return await fs.lstat(p); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }

async function safeLocal(root, target, { missing = false } = {}) {
  if (!policy.within(root, target)) throw policy.fail('SFTP_LOCAL_ESCAPE', '本地目标超出所选目录');
  const components = path.relative(root, target).split(path.sep).filter(Boolean); let current = root; let stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw policy.fail('SFTP_LOCAL_LINK', '本地目标目录已变化或包含链接');
  for (let index = 0; index < components.length; index++) {
    policy.localName(components[index]); current = path.join(current, components[index]); stat = await maybeLocal(current);
    if (!stat && missing) return null;
    if (!stat) throw policy.fail('SFTP_LOCAL_MISSING', '本地文件已移动或删除');
    if (stat.isSymbolicLink() || (index < components.length - 1 && !stat.isDirectory())) throw policy.fail('SFTP_LOCAL_LINK', '本地路径包含链接或非目录项目');
  }
  return stat;
}

async function localFingerprint(p, guard) {
  guard(); const before = await fs.lstat(p); guard();
  if (!before.isFile() || before.isSymbolicLink()) throw policy.fail('SFTP_LOCAL_FILE', '本地文件不是普通文件');
  const handle = await fs.open(p, 'r');
  try {
    const initial = await handle.stat();
    if (!sameLocal(localMetadata(before), localMetadata(initial))) throw policy.fail('SFTP_CONFLICT', '本地文件已变化');
    const hash = createHash('sha256'); const buffer = Buffer.alloc(policy.CHUNK_BYTES); let offset = 0;
    while (offset < initial.size) {
      guard(); const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, initial.size - offset), offset); guard();
      if (!bytesRead) throw policy.fail('SFTP_CONFLICT', '本地文件读取不完整或已变化');
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await handle.stat(); const current = await fs.lstat(p); guard();
    if (!sameLocal(localMetadata(initial), localMetadata(after)) || !sameLocal(localMetadata(initial), localMetadata(current))) throw policy.fail('SFTP_CONFLICT', '本地文件已变化');
    return { stat: localMetadata(current), hash: hash.digest('hex') };
  } finally { await handle.close(); }
}

function createTransfers({ acquire, emit, reserveMutation }) {
  const jobs = new Map(); const queue = []; let running = 0; let disposed = false;
  const canClear = job => job.settled === true && finalStates.has(job.status) && !job.retrying && !job.committing;
  function view(job) {
    return { id: job.id, sessionId: job.sessionId, direction: job.direction, source: job.sources.join('\n'), target: job.destination, bytes: job.bytes, total: job.total, status: job.status,
      canClear: canClear(job),
      speed: job.started ? Math.round(job.bytes * 1000 / Math.max(1, Date.now() - job.started)) : 0,
      ...(job.error ? { error: job.error, errorCode: job.errorCode } : {}), ...(job.conflicts?.length ? { conflicts: [...job.conflicts] } : {}), completedFiles: [...job.completed.values()].filter(item => item.hash).length };
  }
  function changed(job, force = false) {
    if (jobs.get(job.id) !== job) return;
    const now = Date.now();
    if (force || now - job.lastEvent >= 100) { job.lastEvent = now; emit({ type: 'transfer', transfer: view(job) }); }
  }
  function guard(job) { if (job.cancelled || disposed) throw policy.fail('SFTP_CANCELLED', '传输已取消'); }
  function get(id) { const job = jobs.get(id); if (!job) throw policy.fail('SFTP_TRANSFER_INVALID', '传输记录不存在或已移出列表'); return job; }
  function settle(job) { job.resolveDone(); job.settled = true; changed(job, true); }
  async function validateLocalSource(p) {
    const stat = await fs.lstat(p);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw policy.fail('SFTP_LOCAL_LINK', '上传不支持符号链接或特殊文件');
    const canonical = await fs.realpath(p);
    if (canonical === path.parse(canonical).root) throw policy.fail('SFTP_ROOT_PROTECTED', '不能上传整个本地根目录，请选择其中的文件夹');
    return canonical;
  }
  async function buildPlan(job, ctx) {
    const items = []; const targets = new Set();
    const add = item => {
      guard(job);
      if (items.length >= policy.MAX_ENTRIES) throw policy.fail('SFTP_TREE_LIMIT', '传输文件数量超过限制，请分批传输');
      const identity = job.direction === 'download' ? item.target.toLowerCase() : item.target;
      if (targets.has(identity)) throw policy.fail('SFTP_COLLISION', '所选文件包含同名目标，请分批传输');
      targets.add(identity); items.push(item);
    };
    if (job.direction === 'upload') {
      async function visit(source, target, root, depth) {
        ctx.guard();
        if (depth > policy.MAX_DEPTH) throw policy.fail('SFTP_TREE_LIMIT', '目录层数超过限制');
        const stat = await fs.lstat(source); ctx.guard();
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw policy.fail('SFTP_LOCAL_LINK', '上传目录包含符号链接或特殊文件，未开始传输');
        if (!policy.within(root, await fs.realpath(source))) throw policy.fail('SFTP_LOCAL_ESCAPE', '上传路径已变化');
        add({ source, target, type: stat.isDirectory() ? 'directory' : 'file', sourceMeta: localMetadata(stat), sourceRoot: root });
        if (stat.isDirectory()) {
          for (const name of await fs.readdir(source)) { policy.remoteName(name); await visit(path.join(source, name), path.posix.join(target, name), root, depth + 1); }
        }
      }
      for (const source of job.sources) {
        const root = (await fs.lstat(source)).isDirectory() ? source : path.dirname(source);
        await visit(source, path.posix.join(job.destination, path.basename(source)), root, 0);
      }
    } else {
      for (const source of job.sources) {
        const entries = await io.walkRemote(ctx, source);
        for (const entry of entries) {
          if (entry.type === 'symlink') throw policy.fail('SFTP_REMOTE_LINK', '下载不跟随符号链接，请选择真实文件');
          const segments = [path.posix.basename(source), ...path.posix.relative(source, entry.path).split('/').filter(Boolean)]; segments.forEach(policy.localName);
          const target = path.join(job.destination, ...segments);
          if (!policy.within(job.destination, target)) throw policy.fail('SFTP_LOCAL_ESCAPE', '下载目标超出所选目录');
          add({ source: entry.path, target, type: entry.type, sourceMeta: entry });
        }
      }
    }
    job.total = items.reduce((sum, item) => sum + (item.type === 'file' ? item.sourceMeta.size : 0), 0);
    if (!Number.isSafeInteger(job.total)) throw policy.fail('SFTP_SIZE_INVALID', '传输文件大小无效');
    job.conflicts = [];
    for (const item of items) {
      ctx.guard();
      const stat = job.direction === 'upload' ? await io.maybeStat(ctx, item.target) : await safeLocal(job.destination, item.target, { missing: true });
      item.existing = stat ? (job.direction === 'upload' ? policy.metadata(stat) : localMetadata(stat)) : null;
      if (stat && (item.existing.type !== item.type || item.existing.type === 'symlink' || (job.direction === 'download' && stat.nlink > 1 && item.type === 'file'))) throw policy.fail('SFTP_TARGET_TYPE', '目标类型不匹配或是链接，未覆盖');
      if (job.completed.has(item.target)) {
        const saved = job.completed.get(item.target);
        if (item.type !== 'file') { if (!stat) throw policy.fail('SFTP_CONFLICT', '已完成的目录已变化，请新建传输'); item.skip = true; continue; }
        const source = job.direction === 'upload' ? await localFingerprint(item.source, ctx.guard) : await io.fingerprint(ctx, item.source);
        const target = job.direction === 'upload' ? (stat ? await io.fingerprint(ctx, item.target) : null) : (stat ? await localFingerprint(item.target, ctx.guard) : null);
        if (!target || source.hash !== saved.hash || target.hash !== saved.hash) throw policy.fail('SFTP_CONFLICT', '已完成的文件已变化，未重新覆盖；请新建传输');
        item.skip = true; continue;
      }
      if (stat && !job.createdDirectories.has(item.target)) {
        if (!job.overwrite) job.conflicts.push(item.target);
        else if (item.type === 'file') item.existingHash = (job.direction === 'upload' ? await io.fingerprint(ctx, item.target) : await localFingerprint(item.target, ctx.guard)).hash;
      }
    }
    if (job.conflicts.length) throw policy.fail('SFTP_CONFLICT_CONFIRM', `发现 ${job.conflicts.length} 个同名项目，请确认覆盖后重试`);
    return items;
  }

  async function upload(job, ctx, item) {
    const release = reserveMutation(job.sessionId, [item.target]);
    try { await uploadFile(job, ctx, item); } finally { release(); }
  }
  async function uploadFile(job, ctx, item) {
    const stat = await safeLocal(item.sourceRoot, item.source); ctx.guard();
    if (!sameLocal(localMetadata(stat), item.sourceMeta)) throw policy.fail('SFTP_CONFLICT', '上传源文件已变化，请新建传输');
    const parent = await io.noLinkPath(ctx, path.posix.dirname(item.target));
    if (policy.typeOf(parent) !== 'directory') throw policy.fail('SFTP_REMOTE_LINK', '远端目标路径已变化');
    const temporary = io.temporaryPath(item.target); let remote; let local; let created = false;
    const hash = createHash('sha256');
    try {
      local = await fs.open(item.source, 'r'); ctx.guard();
      if (!sameLocal(localMetadata(await local.stat()), item.sourceMeta)) throw policy.fail('SFTP_CONFLICT', '上传源文件已变化');
      remote = await io.call(ctx, 'open', temporary, 'wx', 0o600); created = true;
      const buffer = Buffer.alloc(policy.CHUNK_BYTES); let offset = 0;
      while (offset < item.sourceMeta.size) {
        ctx.guard(); const { bytesRead } = await local.read(buffer, 0, Math.min(buffer.length, item.sourceMeta.size - offset), offset); ctx.guard();
        if (!bytesRead) throw policy.fail('SFTP_SOURCE_CHANGED', '上传源文件读取不完整');
        await io.call(ctx, 'write', remote, buffer, 0, bytesRead, offset); hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead; job.bytes += bytesRead; changed(job);
      }
      if (!sameLocal(localMetadata(await local.stat()), item.sourceMeta)) throw policy.fail('SFTP_CONFLICT', '上传过程中文件已变化，未提交');
      await io.call(ctx, 'fsetstat', remote, { mode: item.existing ? item.existing.mode & 0o777 : 0o644 });
      await io.call(ctx, 'close', remote); remote = null; const expected = hash.digest('hex');
      const verified = await io.fingerprint(ctx, temporary);
      if (verified.hash !== expected || verified.stat.size !== item.sourceMeta.size) throw policy.fail('SFTP_VERIFY_FAILED', '上传数据校验失败，未提交');
      if ((await localFingerprint(item.source, ctx.guard)).hash !== expected) throw policy.fail('SFTP_SOURCE_CHANGED', '上传期间本地内容已变化，未提交');
      const latest = await io.maybeStat(ctx, item.target);
      if (Boolean(latest) !== Boolean(item.existing) || (latest && (!policy.sameMetadata(policy.metadata(latest), item.existing) || (await io.fingerprint(ctx, item.target)).hash !== item.existingHash))) throw policy.fail('SFTP_CONFLICT', '上传前目标文件已变化，未覆盖');
      // Once rename is submitted, cancellation cannot undo it. Finish this commit before stopping the next item.
      const commitCtx = await acquire(job.sessionId);
      ctx.guard(); job.committing = true;
      try {
        await io.commitTemporary(commitCtx, temporary, item.target, Boolean(latest)); created = false;
        if ((await io.fingerprint(commitCtx, item.target)).hash !== expected) throw policy.fail('SFTP_VERIFY_FAILED', '提交后远端内容已变化，请检查目标文件');
        job.completed.set(item.target, { hash: expected, size: item.sourceMeta.size });
      }
      finally { job.committing = false; }
    } finally {
      if (local) await local.close();
      if (remote) await io.cleanupCall(ctx.sftp, 'close', remote);
      if (created) await io.cleanupCall(ctx.sftp, 'unlink', temporary);
    }
  }

  async function download(job, ctx, item) {
    const release = reserveMutation('@local', [item.target.replace(/\\/g, '/').toLowerCase()]);
    try { await downloadFile(job, ctx, item); } finally { release(); }
  }
  async function downloadFile(job, ctx, item) {
    const before = await io.noLinkPath(ctx, item.source);
    if (!policy.sameMetadata(policy.metadata(before), item.sourceMeta)) throw policy.fail('SFTP_CONFLICT', '下载源文件已变化，请新建传输');
    await safeLocal(job.destination, path.dirname(item.target)); ctx.guard();
    const temporary = path.join(path.dirname(item.target), `.adb-workbench-${randomUUID()}.tmp`); let local; let remote; let created = false; let committed = false;
    const hash = createHash('sha256');
    try {
      local = await fs.open(temporary, 'wx', 0o600); created = true; ctx.guard();
      remote = await io.call(ctx, 'open', item.source, 'r');
      const initial = await io.call(ctx, 'fstat', remote);
      if (!policy.sameMetadata(policy.metadata(initial), item.sourceMeta)) throw policy.fail('SFTP_CONFLICT', '下载源文件已变化');
      const buffer = Buffer.alloc(policy.CHUNK_BYTES); let offset = 0;
      while (offset < item.sourceMeta.size) {
        const [count] = await io.call(ctx, 'read', remote, buffer, 0, Math.min(buffer.length, item.sourceMeta.size - offset), offset);
        if (!Number.isInteger(count) || count <= 0 || count > Math.min(buffer.length, item.sourceMeta.size - offset)) throw policy.fail('SFTP_SOURCE_CHANGED', '远端文件读取不完整，未保存部分文件');
        let written = 0;
        while (written < count) { ctx.guard(); const result = await local.write(buffer, written, count - written, offset + written); if (result.bytesWritten <= 0) throw policy.fail('SFTP_WRITE_FAILED', '本地写入不完整'); written += result.bytesWritten; }
        hash.update(buffer.subarray(0, count)); offset += count; job.bytes += count; changed(job);
      }
      const after = await io.call(ctx, 'fstat', remote);
      if (!policy.sameMetadata(policy.metadata(after), item.sourceMeta)) throw policy.fail('SFTP_CONFLICT', '下载期间远端文件已变化，未提交');
      await io.call(ctx, 'close', remote); remote = null;
      await local.sync(); await local.close(); local = null; const expected = hash.digest('hex');
      if ((await io.fingerprint(ctx, item.source)).hash !== expected) throw policy.fail('SFTP_CONFLICT', '下载期间远端内容已变化，未提交');
      const existing = await safeLocal(job.destination, item.target, { missing: true }); ctx.guard();
      if (Boolean(existing) !== Boolean(item.existing) || (existing && (!sameLocal(localMetadata(existing), item.existing) || (await localFingerprint(item.target, ctx.guard)).hash !== item.existingHash))) throw policy.fail('SFTP_CONFLICT', '本地目标文件已变化，未覆盖');
      job.committing = true;
      try {
        if (existing) await fs.rename(temporary, item.target);
        else { await fs.link(temporary, item.target); await fs.unlink(temporary); }
        created = false; committed = true;
      } finally { job.committing = false; }
      job.completed.set(item.target, { hash: expected, size: item.sourceMeta.size });
    } finally {
      if (remote) await io.cleanupCall(ctx.sftp, 'close', remote);
      if (local) await local.close();
      if (created) await fs.unlink(temporary).catch(() => {});
      if (committed) emit({ type: 'files-changed', sessionId: job.sessionId, path: path.posix.dirname(item.source) });
    }
  }

  async function execute(job) {
    job.status = 'planning'; job.started = Date.now(); changed(job, true);
    try {
      const ctx = await acquire(job.sessionId, () => guard(job));
      const plan = await buildPlan(job, ctx); ctx.guard();
      job.bytes = [...job.completed.values()].reduce((sum, item) => sum + (item.size || 0), 0); job.status = 'running'; changed(job, true);
      for (const item of plan) {
        ctx.guard(); if (item.skip) continue;
        if (item.type === 'directory') {
          const release = reserveMutation(job.direction === 'upload' ? job.sessionId : '@local', [job.direction === 'upload' ? item.target : item.target.replace(/\\/g, '/').toLowerCase()]);
          try {
          if (job.direction === 'upload') {
            const parent = await io.noLinkPath(ctx, path.posix.dirname(item.target));
            if (policy.typeOf(parent) !== 'directory') throw policy.fail('SFTP_REMOTE_LINK', '远端目标目录已变化');
            const existing = await io.maybeStat(ctx, item.target);
            if (!existing) { await io.call(ctx, 'mkdir', item.target, { mode: 0o755 }); job.createdDirectories.add(item.target); }
            else if (policy.typeOf(existing) !== 'directory') throw policy.fail('SFTP_CONFLICT', '远端目标目录已变化');
          } else {
            const existing = await safeLocal(job.destination, item.target, { missing: true });
            if (!existing) { await safeLocal(job.destination, path.dirname(item.target)); ctx.guard(); await fs.mkdir(item.target); job.createdDirectories.add(item.target); }
            else if (!existing.isDirectory()) throw policy.fail('SFTP_CONFLICT', '本地目标目录已变化');
          }
          job.completed.set(item.target, { size: 0 });
          } finally { release(); }
        } else if (job.direction === 'upload') await upload(job, ctx, item);
        else await download(job, ctx, item);
      }
      ctx.guard(); job.status = 'completed'; job.bytes = job.total;
      emit({ type: 'files-changed', sessionId: job.sessionId, path: job.direction === 'upload' ? job.destination : path.posix.dirname(job.sources[0]) });
    } catch (error) {
      job.status = job.cancelled || error.code === 'SFTP_CANCELLED' || error.code === 'SFTP_SESSION_CLOSED' ? 'cancelled' : error.code === 'SFTP_CONFLICT_CONFIRM' ? 'conflict' : 'failed';
      job.error = error.message; job.errorCode = error.code;
    } finally { changed(job, true); }
  }
  function pump() {
    while (running < 2 && queue.length) {
      const job = queue.shift();
      if (job.cancelled) { job.status = 'cancelled'; settle(job); continue; }
      running++;
      void execute(job).finally(() => { running--; settle(job); pump(); });
    }
  }
  function enqueue(job) {
    job.settled = false; job.done = new Promise(resolve => { job.resolveDone = resolve; }); queue.push(job); job.status = 'queued'; changed(job, true); queueMicrotask(pump);
  }
  async function startTransfer({ sessionId, direction, sources, destination, overwrite = false } = {}) {
    if (disposed || !['upload', 'download'].includes(direction) || !Array.isArray(sources) || !sources.length || sources.length > 100 || typeof overwrite !== 'boolean') throw policy.fail('SFTP_TRANSFER_INVALID', '传输参数无效');
    if ([...jobs.values()].filter(job => !finalStates.has(job.status)).length >= 20) throw policy.fail('SFTP_TRANSFER_LIMIT', '等待传输的任务过多，请等待部分完成');
    const ctx = await acquire(sessionId); let selected; let target;
    if (direction === 'upload') {
      selected = [];
      for (const source of sources) { selected.push(await validateLocalSource(policy.localPath(source))); ctx.guard(); }
      target = policy.remotePath(destination);
      if (policy.typeOf(await io.noLinkPath(ctx, target)) !== 'directory') throw policy.fail('SFTP_NOT_DIRECTORY', '远端目标不是普通目录');
    } else {
      selected = sources.map(policy.remotePath); const home = policy.remotePath(await io.call(ctx, 'realpath', '.'));
      if (selected.some(p => p === '/' || p === home || home.startsWith(`${p}/`))) throw policy.fail('SFTP_ROOT_PROTECTED', '不能下载整个根目录或主目录，请选择其中的文件夹');
      const chosen = policy.localPath(destination); const stat = await fs.lstat(chosen); ctx.guard();
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw policy.fail('SFTP_LOCAL_DIRECTORY', '本地保存位置必须是普通目录');
      target = await fs.realpath(chosen); ctx.guard();
    }
    if ([...jobs.values()].filter(job => !finalStates.has(job.status)).length >= 20) throw policy.fail('SFTP_TRANSFER_LIMIT', '等待传输的任务过多，请等待部分完成');
    for (const [id, existing] of jobs) if (jobs.size >= 100 && canClear(existing)) jobs.delete(id);
    const id = randomUUID();
    const job = { id, sessionId, direction, sources: selected, destination: target, overwrite, bytes: 0, total: 0, status: 'queued', completed: new Map(), createdDirectories: new Set(), lastEvent: 0, cancelled: false };
    jobs.set(id, job); enqueue(job); return { transferId: id };
  }
  async function cancelTransfer({ transferId } = {}) {
    const job = get(transferId);
    if (finalStates.has(job.status)) return { cancelled: job.status === 'cancelled' };
    job.cancelled = true; job.status = 'cancelling'; changed(job, true);
    const queued = queue.indexOf(job);
    if (queued !== -1) { queue.splice(queued, 1); job.status = 'cancelled'; settle(job); }
    await job.done; return { cancelled: true };
  }
  async function retryTransfer({ transferId, overwrite = false } = {}) {
    const job = get(transferId);
    if (!canClear(job) || job.status === 'completed' || typeof overwrite !== 'boolean') throw policy.fail('SFTP_RETRY_INVALID', '当前传输不能重试');
    if ([...jobs.values()].filter(item => !finalStates.has(item.status)).length >= 20) throw policy.fail('SFTP_TRANSFER_LIMIT', '等待传输的任务过多，请稍后重试');
    const previous = job.status; job.retrying = true; job.cancelled = false; job.status = 'planning'; changed(job, true);
    try {
      await acquire(job.sessionId);
      if (job.cancelled) { job.status = 'cancelled'; changed(job, true); return { transferId: job.id }; }
      job.error = undefined; job.errorCode = undefined; job.overwrite = overwrite; job.conflicts = []; enqueue(job); return { transferId: job.id };
    } catch (error) { job.status = job.cancelled ? 'cancelled' : previous; changed(job, true); throw error; }
    finally { job.retrying = false; changed(job, true); }
  }
  function listTransfers({ sessionId } = {}) { return [...jobs.values()].filter(job => sessionId === undefined || job.sessionId === sessionId).map(view); }
  function clearTransfer({ transferId } = {}) {
    const job = get(transferId);
    if (!canClear(job)) throw policy.fail('SFTP_TRANSFER_BUSY', '传输仍在进行或正在收尾，请稍候再清除记录');
    jobs.delete(transferId); emit({ type: 'transfer-records-cleared', removedIds: [transferId] });
    return { removedIds: [transferId] };
  }
  function clearTransfers() {
    const removedIds = [];
    for (const [id, job] of jobs) if (canClear(job)) { jobs.delete(id); removedIds.push(id); }
    if (removedIds.length) emit({ type: 'transfer-records-cleared', removedIds: [...removedIds] });
    return { removedIds };
  }
  async function getTransferLocation({ transferId } = {}) {
    const job = get(transferId);
    if (job.status !== 'completed' || !canClear(job)) throw policy.fail('SFTP_TRANSFER_NOT_COMPLETED', '请等待传输完成后打开所在目录');
    if (job.direction === 'upload') return { kind: 'remote', sessionId: job.sessionId, path: job.destination };
    // A completed download remains local evidence even after its SSH session
    // has closed. Never reacquire SFTP, create a directory or follow a new link.
    try {
      const stat = await fs.lstat(job.destination);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not ordinary directory');
      const canonical = await fs.realpath(job.destination);
      const unchanged = process.platform === 'win32' ? canonical.toLowerCase() === job.destination.toLowerCase() : canonical === job.destination;
      if (!unchanged) throw new Error('destination redirected');
    } catch { throw policy.fail('SFTP_LOCAL_DIRECTORY', '下载目录已移动、删除或不再是原来的普通目录，请检查本地保存位置'); }
    if (jobs.get(transferId) !== job) throw policy.fail('SFTP_TRANSFER_INVALID', '传输记录已清除，无法再从列表定位目录');
    return { kind: 'local', sessionId: job.sessionId, path: job.destination };
  }
  function disposeSession(sessionId) { for (const job of jobs.values()) if (job.sessionId === sessionId && !finalStates.has(job.status)) { job.cancelled = true; changed(job, true); } }
  async function dispose() { disposed = true; for (const job of jobs.values()) job.cancelled = true; await Promise.allSettled([...jobs.values()].map(job => job.done)); }
  return { api: { startTransfer, cancelTransfer, retryTransfer, listTransfers, clearTransfer, clearTransfers, getTransferLocation }, disposeSession, dispose };
}

module.exports = { createTransfers };
