const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { CHUNK_BYTES, MAX_ENTRIES, MAX_DEPTH, fail, remotePath, remoteName, typeOf, metadata, sameMetadata, isMissing } = require('./ssh-files-policy.cjs');

function cleanupCall(sftp, method, ...args) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, 2000); timer.unref?.();
    try { sftp[method](...args, () => { clearTimeout(timer); resolve(); }); } catch { clearTimeout(timer); resolve(); }
  });
}

function call(ctx, method, ...args) {
  ctx.guard();
  return new Promise((resolve, reject) => {
    let settled = false;
    const releaseLateHandle = async handle => {
      await cleanupCall(ctx.sftp, 'close', handle);
      // wx succeeded but cancellation prevented its caller from learning that it owns this temporary file.
      if (method === 'open' && args[1] === 'wx' && /^\.adb-workbench-[\da-f-]+\.tmp$/.test(path.posix.basename(args[0]))) await cleanupCall(ctx.sftp, 'unlink', args[0]);
    };
    const finish = (error, values = []) => {
      if (settled) {
        if (!error && ['open', 'opendir'].includes(method) && values[0]) void releaseLateHandle(values[0]);
        return;
      }
      settled = true; clearTimeout(timer); ctx.signal.removeEventListener('abort', onAbort);
      if (!error) { try { ctx.guard(); } catch (e) { error = e; if (['open', 'opendir'].includes(method) && values[0]) { void releaseLateHandle(values[0]).then(() => reject(error)); return; } } }
      if (error) reject(error); else resolve(values.length > 1 ? values : values[0]);
    };
    const onAbort = () => finish(fail('SFTP_SESSION_CLOSED', 'SSH 会话已结束，文件操作已停止'));
    const timer = setTimeout(() => finish(fail('SFTP_TIMEOUT', 'SFTP 操作超时，请检查连接后重试')), 30000);
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    try { ctx.sftp[method](...args, (error, ...values) => finish(error, values)); } catch (error) { finish(error); }
  });
}

async function maybeStat(ctx, p) { try { return await call(ctx, 'lstat', p); } catch (error) { if (isMissing(error)) return null; throw error; } }
async function noLinkPath(ctx, p, { missingLeaf = false } = {}) {
  p = remotePath(p);
  const parts = p.split('/').filter(Boolean); let current = '/'; let stat;
  for (let i = 0; i < parts.length; i++) {
    current = path.posix.join(current, parts[i]);
    stat = await maybeStat(ctx, current);
    if (!stat && missingLeaf && i === parts.length - 1) return null;
    if (!stat) throw fail('SFTP_NOT_FOUND', '远端文件或目录不存在');
    if (typeOf(stat) === 'symlink' && i < parts.length - 1) throw fail('SFTP_LINK_PATH', '操作路径经过符号链接，请选择真实目录');
    if (i < parts.length - 1 && typeOf(stat) !== 'directory') throw fail('SFTP_NOT_DIRECTORY', '路径中的项目不是目录');
  }
  return stat || await call(ctx, 'lstat', '/');
}

async function readBytes(ctx, p, offset, length) {
  const handle = await call(ctx, 'open', p, 'r');
  try {
    const stat = await call(ctx, 'fstat', handle);
    if (typeOf(stat) !== 'file') throw fail('SFTP_NOT_FILE', '只能读取普通文件');
    const output = Buffer.alloc(Math.min(length, Math.max(0, stat.size - offset))); let count = 0;
    while (count < output.length) {
      const [read] = await call(ctx, 'read', handle, output, count, Math.min(CHUNK_BYTES, output.length - count), offset + count);
      if (!Number.isInteger(read) || read < 0 || read > output.length - count) throw fail('SFTP_READ_INVALID', '服务器返回了无效的文件数据');
      if (read === 0) break;
      count += read;
    }
    return { bytes: output.subarray(0, count), stat };
  } finally { await cleanupCall(ctx.sftp, 'close', handle); }
}

async function fingerprint(ctx, p, maxBytes = Infinity) {
  const stat = await noLinkPath(ctx, p);
  if (typeOf(stat) !== 'file' || stat.size > maxBytes) throw fail('SFTP_NOT_EDITABLE', '文件不是普通文件或超过可编辑大小');
  const handle = await call(ctx, 'open', p, 'r'); const hash = createHash('sha256'); let offset = 0;
  try {
    const initial = await call(ctx, 'fstat', handle);
    if (!sameMetadata(metadata(stat), metadata(initial))) throw fail('SFTP_CONFLICT', '远端文件已变化，请重新打开');
    const buffer = Buffer.alloc(CHUNK_BYTES);
    while (offset < initial.size) {
      const [count] = await call(ctx, 'read', handle, buffer, 0, Math.min(buffer.length, initial.size - offset), offset);
      if (!Number.isInteger(count) || count <= 0 || count > Math.min(buffer.length, initial.size - offset)) throw fail('SFTP_CHANGED', '远端文件读取不完整或已变化');
      hash.update(buffer.subarray(0, count)); offset += count;
    }
    const after = await call(ctx, 'fstat', handle);
    const current = await noLinkPath(ctx, p);
    if (!sameMetadata(metadata(initial), metadata(after)) || !sameMetadata(metadata(initial), metadata(current))) throw fail('SFTP_CONFLICT', '远端文件已变化，请重新打开');
    return { stat: current, hash: hash.digest('hex') };
  } finally { await cleanupCall(ctx.sftp, 'close', handle); }
}

async function directoryEntries(ctx, p) {
  const stat = await noLinkPath(ctx, p);
  if (typeOf(stat) !== 'directory') throw fail('SFTP_NOT_DIRECTORY', '目标不是普通目录，不能跟随符号链接');
  const handle = await call(ctx, 'opendir', p); const result = []; const seen = new Set(); let emptyPages = 0;
  try {
    while (true) {
      let entries;
      try { entries = await call(ctx, 'readdir', handle); } catch (error) { if (error.code === 1) break; throw error; }
      if (entries === false) break;
      if (!Array.isArray(entries) || result.length + entries.length > MAX_ENTRIES) throw fail('SFTP_DIRECTORY_LIMIT', '目录项目过多或服务器目录数据无效');
      const before = result.length;
      for (const entry of entries) {
        if (entry.filename === '.' || entry.filename === '..') continue;
        remoteName(entry.filename);
        if (seen.has(entry.filename)) throw fail('SFTP_DIRECTORY_INVALID', '服务器目录包含重复项目，请刷新后重试');
        seen.add(entry.filename); result.push(entry);
      }
      if (result.length === before) { if (++emptyPages > 16) throw fail('SFTP_DIRECTORY_LIMIT', '服务器连续返回空目录页，请重试'); } else emptyPages = 0;
    }
    return result;
  } finally { await cleanupCall(ctx.sftp, 'close', handle); }
}

async function walkRemote(ctx, root) {
  const result = [];
  async function visit(p, depth) {
    if (depth > MAX_DEPTH || result.length >= MAX_ENTRIES) throw fail('SFTP_TREE_LIMIT', '目录层数或文件数量超过安全限制，请分批操作');
    const stat = await noLinkPath(ctx, p); result.push({ path: p, ...metadata(stat) });
    if (typeOf(stat) === 'directory') {
      const entries = await directoryEntries(ctx, p);
      entries.sort((a, b) => a.filename.localeCompare(b.filename));
      for (const entry of entries) await visit(path.posix.join(p, entry.filename), depth + 1);
    } else if (!['file', 'symlink'].includes(typeOf(stat))) throw fail('SFTP_SPECIAL_FILE', '不支持设备节点、管道等特殊文件');
  }
  await visit(root, 0); return result;
}

async function commitTemporary(ctx, temporary, destination, existing) {
  ctx.guard();
  if (existing && typeof ctx.sftp.ext_openssh_rename !== 'function') throw fail('SFTP_ATOMIC_UNSUPPORTED', '服务器不支持原子覆盖，请下载编辑内容以保留草稿');
  try { await call(ctx, existing ? 'ext_openssh_rename' : 'rename', temporary, destination); }
  catch (error) {
    if (existing && (error.code === 8 || /(?:not support|unsupported)/i.test(error.message))) throw fail('SFTP_ATOMIC_UNSUPPORTED', '服务器不支持原子覆盖，请下载编辑内容以保留草稿');
    if (['SFTP_TIMEOUT', 'SFTP_SESSION_CLOSED', 'ECONNRESET'].includes(error.code)) throw fail('SFTP_COMMIT_UNKNOWN', '提交时连接中断，保存结果不确定，请重新连接后核对远端文件');
    throw error;
  }
}

function temporaryPath(destination) { return path.posix.join(path.posix.dirname(destination), `.adb-workbench-${randomUUID()}.tmp`); }

module.exports = { call, cleanupCall, maybeStat, noLinkPath, readBytes, fingerprint, directoryEntries, walkRemote, commitTemporary, temporaryPath };
