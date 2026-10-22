const path = require('node:path');
const { randomUUID } = require('node:crypto');
const policy = require('./ssh-files-policy.cjs');
const io = require('./ssh-files-io.cjs');
const { createTransfers } = require('./ssh-files-transfers.cjs');

function createSshFiles({ getSftp, onChange = () => {}, assertSession = () => {} } = {}) {
  if (typeof getSftp !== 'function') throw new TypeError('getSftp is required');
  const sessions = new Map(); const cursors = new Map(); const documents = new Map(); const plans = new Map(); const mutations = new Set();
  let disposed = false;
  function session(id) {
    if (typeof id !== 'string' || !id || id.length > 200 || disposed) throw policy.fail('SFTP_SESSION_INVALID', 'SSH 会话无效或已结束');
    assertSession(id);
    if (!sessions.has(id)) sessions.set(id, { controller: new AbortController() });
    const state = sessions.get(id);
    if (state.controller.signal.aborted) throw policy.fail('SFTP_SESSION_CLOSED', 'SSH 会话已结束，请重新连接');
    return state;
  }
  async function acquire(id, extraGuard = () => {}) {
    const state = session(id);
    const guard = () => { session(id); extraGuard(); };
    const sftp = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); state.controller.signal.removeEventListener('abort', onAbort); error ? reject(error) : resolve(value); };
      const onAbort = () => finish(policy.fail('SFTP_SESSION_CLOSED', 'SSH 会话已结束，文件操作已停止'));
      const timer = setTimeout(() => finish(policy.fail('SFTP_TIMEOUT', '建立 SFTP 通道超时，请重试')), 30000);
      state.controller.signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve().then(() => { guard(); return getSftp(id); }).then(value => finish(null, value), error => finish(error));
    }); guard();
    return { sftp, signal: state.controller.signal, guard, sessionId: id };
  }
  const emit = event => { try { onChange(event); } catch { /* A view subscriber cannot interrupt file cleanup. */ } };
  function reserveMutation(sessionId, paths) {
    for (const active of mutations) {
      if (active.sessionId === sessionId && active.paths.some(a => paths.some(b => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)))) throw policy.fail('SFTP_PATH_BUSY', '该文件或目录正在被其他操作修改，请稍候重试');
    }
    const entry = { sessionId, paths }; mutations.add(entry); return () => mutations.delete(entry);
  }
  const transfers = createTransfers({ acquire, emit, reserveMutation });
  function remember(map, id, value, max) {
    for (const [key, entry] of map) if (entry.expires < Date.now()) map.delete(key);
    if (map.size >= max) map.delete(map.keys().next().value);
    map.set(id, { ...value, expires: Date.now() + 30 * 60 * 1000 });
  }
  function token(map, id, sessionId) {
    const value = map.get(id);
    if (!value || value.sessionId !== sessionId || value.expires < Date.now()) throw policy.fail('SFTP_TOKEN_INVALID', '操作记录已失效，请重新打开或确认');
    session(sessionId); return value;
  }
  async function resolvePath(ctx, value) {
    return value === undefined || value === '' ? policy.remotePath(await io.call(ctx, 'realpath', '.')) : policy.remotePath(value);
  }
  async function protectedRoot(ctx, p) {
    const home = policy.remotePath(await io.call(ctx, 'realpath', '.'));
    if (p === '/' || p === home || home.startsWith(`${p}/`)) throw policy.fail('SFTP_ROOT_PROTECTED', '不能删除远端根目录、主目录或其上级目录');
  }

  async function list({ sessionId, path: value, cursor, limit = 200 } = {}) {
    session(sessionId);
    let page;
    if (cursor) { page = token(cursors, cursor, sessionId); cursors.delete(cursor); }
    else {
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw policy.fail('SFTP_LIMIT_INVALID', '目录分页大小应为 1 到 500');
      const ctx = await acquire(sessionId); const p = await resolvePath(ctx, value);
      const raw = await io.directoryEntries(ctx, p);
      const entries = raw.map(entry => ({ name: entry.filename, ...policy.metadata(entry.attrs) })).filter(entry => entry.type !== 'special');
      entries.sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name));
      page = { sessionId, path: p, entries, limit };
    }
    const entries = page.entries.slice(0, page.limit); const rest = page.entries.slice(page.limit); let next;
    if (rest.length) { next = randomUUID(); remember(cursors, next, { ...page, entries: rest }, 8); }
    return { sessionId, path: page.path, entries, ...(next ? { cursor: next, truncated: true } : { truncated: false }) };
  }

  async function preview({ sessionId, path: value, offset = 0, limit = policy.PAGE_BYTES } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > policy.PAGE_BYTES) throw policy.fail('SFTP_RANGE_INVALID', '预览范围无效');
    const ctx = await acquire(sessionId); const p = policy.remotePath(value); const stat = await io.noLinkPath(ctx, p);
    if (policy.typeOf(stat) !== 'file') throw policy.fail('SFTP_NOT_FILE', '只能预览普通文件，不能跟随符号链接');
    if (!Number.isSafeInteger(stat.size) || stat.size < offset) throw policy.fail('SFTP_RANGE_INVALID', '文件大小或预览偏移无效，请刷新文件');
    const { bytes } = await io.readBytes(ctx, p, offset, Math.min(limit + 3, stat.size - offset));
    const mime = offset === 0 ? policy.imageMime(bytes) : null;
    const base = { sessionId, path: p, size: stat.size, readOnly: true, offset };
    if (mime) {
      if (stat.size > policy.IMAGE_BYTES) return { ...base, kind: 'binary', reason: '图片超过 12 MiB，请下载后查看', hasMore: false };
      const image = await io.readBytes(ctx, p, 0, policy.IMAGE_BYTES);
      if (image.bytes.length !== stat.size) throw policy.fail('SFTP_CHANGED', '图片读取不完整，请刷新后重试');
      if (policy.imageMime(image.bytes) !== mime || !policy.safeImageDimensions(image.bytes, mime)) return { ...base, kind: 'binary', reason: '图片格式无效或像素过大，请下载后查看', hasMore: false };
      return { ...base, kind: 'image', dataUrl: `data:${mime};base64,${image.bytes.toString('base64')}`, nextOffset: stat.size, hasMore: false };
    }
    let length = Math.min(limit, bytes.length); let text = policy.decodeText(bytes.subarray(0, length));
    for (let trim = 1; text === null && trim <= 3 && length - trim > 0; trim++) {
      const candidate = policy.decodeText(bytes.subarray(0, length - trim));
      if (candidate !== null) { length -= trim; text = candidate; }
    }
    if (text === null && length <= 3) {
      for (let take = length + 1; take <= Math.min(4, bytes.length); take++) {
        const candidate = policy.decodeText(bytes.subarray(0, take));
        if (candidate !== null) { length = take; text = candidate; break; }
      }
    }
    if (text === null) return { ...base, kind: 'binary', reason: '该文件不是有效 UTF-8 文本，请下载后查看', hasMore: false };
    const nextOffset = offset + length;
    return { ...base, kind: 'text', text, nextOffset, hasMore: nextOffset < stat.size };
  }

  async function openDocument(args = {}) {
    const result = await preview(args);
    if (documents.size >= 256) throw policy.fail('SFTP_DOCUMENT_LIMIT', '已打开 256 个编辑文件，请先关闭不再编辑的文件');
    const documentId = randomUUID();
    if (result.kind !== 'text' || result.size > policy.EDIT_BYTES) {
      documents.set(documentId, { sessionId: args.sessionId, path: result.path, readOnly: true, expires: Infinity });
      return { ...result, documentId, readOnly: true };
    }
    const ctx = await acquire(args.sessionId); const read = await io.readBytes(ctx, result.path, 0, policy.EDIT_BYTES);
    const text = policy.decodeText(read.bytes);
    if (text === null) {
      documents.set(documentId, { sessionId: args.sessionId, path: result.path, readOnly: true, expires: Infinity });
      return { ...result, kind: 'binary', text: undefined, documentId, readOnly: true };
    }
    const current = await io.fingerprint(ctx, result.path, policy.EDIT_BYTES);
    if (current.hash !== policy.digest(read.bytes) || read.bytes.length !== current.stat.size) throw policy.fail('SFTP_CONFLICT', '远端文件已变化，请重新打开');
    if (documents.size >= 256) throw policy.fail('SFTP_DOCUMENT_LIMIT', '已打开 256 个编辑文件，请先关闭不再编辑的文件');
    const version = policy.revision(current.stat, current.hash);
    documents.set(documentId, { sessionId: args.sessionId, path: result.path, revision: version, expires: Infinity });
    return { sessionId: args.sessionId, documentId, path: result.path, kind: 'text', text, size: current.stat.size, readOnly: false, revision: version, offset: 0, nextOffset: current.stat.size, hasMore: false };
  }

  async function saveDocument({ sessionId, documentId, revision, text } = {}) {
    const document = token(documents, documentId, sessionId);
    if (document.readOnly) throw policy.fail('SFTP_READ_ONLY', '该文件仅支持只读预览，不能保存分段或二进制内容');
    if (document.saving) throw policy.fail('SFTP_SAVE_BUSY', '该文件正在保存，请稍候');
    if (revision !== document.revision) throw policy.fail('SFTP_CONFLICT', '文件版本已变化，请重新打开');
    const bytes = policy.textBytes(text); const temporary = io.temporaryPath(document.path);
    const release = reserveMutation(sessionId, [document.path]);
    let handle; let created = false; let ctx; document.saving = true;
    try {
      ctx = await acquire(sessionId);
      const original = await io.fingerprint(ctx, document.path, policy.EDIT_BYTES);
      if (policy.revision(original.stat, original.hash) !== revision) throw policy.fail('SFTP_CONFLICT', '远端文件已变化，未覆盖；请重新打开或另存');
      handle = await io.call(ctx, 'open', temporary, 'wx', original.stat.mode & 0o777); created = true;
      for (let offset = 0; offset < bytes.length; offset += policy.CHUNK_BYTES) await io.call(ctx, 'write', handle, bytes, offset, Math.min(policy.CHUNK_BYTES, bytes.length - offset), offset);
      await io.call(ctx, 'fsetstat', handle, { mode: original.stat.mode & 0o777 });
      await io.call(ctx, 'close', handle); handle = null;
      const verify = await io.fingerprint(ctx, temporary, policy.EDIT_BYTES);
      if (verify.hash !== policy.digest(bytes)) throw policy.fail('SFTP_VERIFY_FAILED', '保存数据校验失败，原文件未替换');
      const latest = await io.fingerprint(ctx, document.path, policy.EDIT_BYTES);
      if (policy.revision(latest.stat, latest.hash) !== revision) throw policy.fail('SFTP_CONFLICT', '保存前发现远端文件已变化，原文件未替换');
      await io.commitTemporary(ctx, temporary, document.path, true); created = false;
      const saved = await io.fingerprint(ctx, document.path, policy.EDIT_BYTES);
      if (saved.hash !== policy.digest(bytes)) throw policy.fail('SFTP_VERIFY_FAILED', '提交后文件发生变化，请重新读取确认；本地编辑内容仍可保留');
      document.revision = policy.revision(saved.stat, saved.hash);
      emit({ type: 'files-changed', sessionId, path: path.posix.dirname(document.path) });
      return { revision: document.revision };
    } finally {
      document.saving = false;
      if (handle) await io.cleanupCall(ctx.sftp, 'close', handle);
      if (created) await io.cleanupCall(ctx.sftp, 'unlink', temporary);
      release();
    }
  }

  function closeDocument({ sessionId, documentId } = {}) {
    const document = token(documents, documentId, sessionId);
    if (document.saving) throw policy.fail('SFTP_SAVE_BUSY', '文件正在保存，请稍候再关闭');
    documents.delete(documentId); return { closed: true };
  }

  async function createFile({ sessionId, parent, name } = {}) {
    const p = policy.remotePath(parent); policy.remoteName(name);
    const target = path.posix.join(p, name); const temporary = io.temporaryPath(target);
    const release = reserveMutation(sessionId, [target]); let ctx; let handle; let created = false;
    try {
      ctx = await acquire(sessionId);
      if (policy.typeOf(await io.noLinkPath(ctx, p)) !== 'directory') throw policy.fail('SFTP_NOT_DIRECTORY', '请选择普通目录，不能跟随符号链接');
      if (await io.maybeStat(ctx, target)) throw policy.fail('SFTP_EXISTS', '同名项目已存在，未覆盖');
      handle = await io.call(ctx, 'open', temporary, 'wx', 0o644); created = true;
      await io.call(ctx, 'close', handle); handle = null;
      if (policy.typeOf(await io.noLinkPath(ctx, p)) !== 'directory') throw policy.fail('SFTP_NOT_DIRECTORY', '目标目录已变化，未创建文件');
      if (await io.maybeStat(ctx, target)) throw policy.fail('SFTP_EXISTS', '同名项目已存在，未覆盖');
      await io.commitTemporary(ctx, temporary, target, false); created = false;
      emit({ type: 'files-changed', sessionId, path: p }); return { path: target };
    } finally {
      if (handle) await io.cleanupCall(ctx.sftp, 'close', handle);
      if (created) await io.cleanupCall(ctx.sftp, 'unlink', temporary);
      release();
    }
  }

  async function mkdir({ sessionId, parent, name } = {}) {
    const ctx = await acquire(sessionId); const p = policy.remotePath(parent); policy.remoteName(name);
    const stat = await io.noLinkPath(ctx, p);
    if (policy.typeOf(stat) !== 'directory') throw policy.fail('SFTP_NOT_DIRECTORY', '请选择普通目录');
    const target = path.posix.join(p, name); if (await io.maybeStat(ctx, target)) throw policy.fail('SFTP_EXISTS', '同名项目已存在');
    const release = reserveMutation(sessionId, [target]);
    try { await io.call(ctx, 'mkdir', target, { mode: 0o755 }); emit({ type: 'files-changed', sessionId, path: p }); return { path: target }; } finally { release(); }
  }
  async function move({ sessionId, source, destination } = {}) {
    const ctx = await acquire(sessionId); const from = policy.remotePath(source); const to = policy.remotePath(destination);
    await protectedRoot(ctx, from);
    if (from === to || to.startsWith(`${from}/`)) throw policy.fail('SFTP_MOVE_INVALID', '目标路径与源路径冲突');
    await io.noLinkPath(ctx, from);
    const parent = await io.noLinkPath(ctx, path.posix.dirname(to));
    if (policy.typeOf(parent) !== 'directory') throw policy.fail('SFTP_NOT_DIRECTORY', '目标不是普通目录');
    if (await io.maybeStat(ctx, to)) throw policy.fail('SFTP_EXISTS', '目标已存在，未覆盖；请选择其他名称');
    const release = reserveMutation(sessionId, [from, to]);
    try {
      await io.call(ctx, 'rename', from, to);
      const movedDocuments = [];
      for (const [documentId, document] of documents) {
        if (document.sessionId !== sessionId || (document.path !== from && !document.path.startsWith(`${from}/`))) continue;
        document.path = to + document.path.slice(from.length);
        movedDocuments.push({ documentId, path: document.path });
      }
      emit({ type: 'files-changed', sessionId, path: path.posix.dirname(from) });
      return { source: from, path: to, movedDocuments };
    } finally { release(); }
  }
  async function planDelete({ sessionId, path: value } = {}) {
    const ctx = await acquire(sessionId); const p = policy.remotePath(value); await protectedRoot(ctx, p);
    const entries = await io.walkRemote(ctx, p); const planId = randomUUID();
    remember(plans, planId, { sessionId, path: p, entries }, 16);
    return { sessionId, planId, path: p, count: entries.length, files: entries.filter(x => x.type !== 'directory').length, directories: entries.filter(x => x.type === 'directory').length, bytes: entries.reduce((sum, x) => sum + (x.type === 'file' ? x.size : 0), 0) };
  }
  async function confirmDelete({ sessionId, planId } = {}) {
    const plan = token(plans, planId, sessionId); plans.delete(planId); const ctx = await acquire(sessionId);
    const release = reserveMutation(sessionId, [plan.path]); let removed = 0;
    try {
      await protectedRoot(ctx, plan.path); const current = await io.walkRemote(ctx, plan.path);
      if (current.length !== plan.entries.length || current.some((x, i) => x.path !== plan.entries[i].path || !policy.sameMetadata(x, plan.entries[i]))) throw policy.fail('SFTP_CONFLICT', '目录内容已变化，请重新确认删除');
      for (const entry of [...plan.entries].reverse()) {
        const stat = await io.noLinkPath(ctx, entry.path);
        if (policy.typeOf(stat) !== entry.type || (entry.type !== 'directory' && !policy.sameMetadata(policy.metadata(stat), entry))) throw policy.fail('SFTP_CONFLICT', '删除过程中发现文件变化，已停止');
        await io.call(ctx, entry.type === 'directory' ? 'rmdir' : 'unlink', entry.path); removed++;
      }
    } catch (error) { error.message = `${error.message}（已删除 ${removed} 项，未继续；远端删除无法自动恢复）`; throw error; }
    finally { release(); }
    emit({ type: 'files-changed', sessionId, path: path.posix.dirname(plan.path) }); return { path: plan.path, removed };
  }
  function disposeSession(sessionId) {
    const state = sessions.get(sessionId); state?.controller.abort();
    if (!state && typeof sessionId === 'string') { const controller = new AbortController(); controller.abort(); sessions.set(sessionId, { controller }); }
    for (const map of [cursors, documents, plans]) for (const [id, value] of map) if (value.sessionId === sessionId) map.delete(id);
    transfers.disposeSession(sessionId);
  }
  async function dispose() { disposed = true; for (const id of sessions.keys()) disposeSession(id); await transfers.dispose(); }

  return { list, preview, openDocument, saveDocument, closeDocument, createFile, mkdir, move, planDelete, confirmDelete, ...transfers.api, disposeSession, dispose };
}

module.exports = { createSshFiles };
