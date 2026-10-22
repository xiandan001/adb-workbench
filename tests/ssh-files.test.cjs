const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSshFiles } = require('../electron/lib/ssh-files.cjs');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const error = (code, message = code) => Object.assign(new Error(message), { code });

class FakeSftp {
  constructor() {
    this.nodes = new Map(); this.handles = new Set(); this.calls = []; this.renameSupported = true;
    this.put('/', 'directory'); this.put('/home', 'directory'); this.put('/home/test', 'directory');
  }
  put(p, type = 'file', value = '') {
    const node = { type, data: Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value), mtime: 100, mode: type === 'directory' ? 0o40755 : type === 'symlink' ? 0o120777 : 0o100644 };
    this.nodes.set(p, node); return node;
  }
  attrs(node) {
    return { size: node.data.length, mtime: node.mtime, mode: node.mode,
      isFile: () => node.type === 'file', isDirectory: () => node.type === 'directory', isSymbolicLink: () => node.type === 'symlink' };
  }
  run(method, args, callback, work) {
    this.calls.push([method, ...args]);
    const perform = () => { try { const value = work(); callback(null, ...value); } catch (e) { callback(e); } };
    if (this.delay) setTimeout(perform, this.delay); else queueMicrotask(perform);
  }
  node(p) { const node = this.nodes.get(p); if (!node) throw error(2, 'not found'); return node; }
  realpath(p, cb) { this.run('realpath', [p], cb, () => { p = p === '.' ? '/home/test' : path.posix.normalize(p); this.node(p); return [p]; }); }
  lstat(p, cb) { this.run('lstat', [p], cb, () => [this.attrs(this.node(p))]); }
  stat(p, cb) { this.lstat(p, cb); }
  opendir(p, cb) { this.run('opendir', [p], cb, () => { if (this.node(p).type !== 'directory') throw error(4); const h = { path: p, index: 0, kind: 'directory' }; this.handles.add(h); return [h]; }); }
  readdir(h, cb) { this.run('readdir', [h.path], cb, () => {
    const children = [...this.nodes].filter(([p]) => path.posix.dirname(p) === h.path && p !== h.path).map(([p, n]) => ({ filename: path.posix.basename(p), attrs: this.attrs(n) }));
    const list = children.slice(h.index, h.index + 2); h.index += list.length; return [list.length ? list : false];
  }); }
  open(p, flags, attrs, cb) {
    if (typeof attrs === 'function') { cb = attrs; attrs = undefined; }
    this.run('open', [p, flags], cb, () => {
      if (flags === 'wx') { if (this.nodes.has(p)) throw error(4, 'exists'); this.put(p); }
      const n = this.node(p); if (n.type !== 'file') throw error(4, 'not file');
      const h = { path: p, node: n, kind: 'file' }; this.handles.add(h); return [h];
    });
  }
  fstat(h, cb) { this.run('fstat', [h.path], cb, () => [this.attrs(h.node)]); }
  fsetstat(h, attrs, cb) { this.run('fsetstat', [h.path], cb, () => { Object.assign(h.node, attrs); return []; }); }
  read(h, buffer, offset, length, position, cb) { this.run('read', [h.path, position], cb, () => {
    const count = Math.min(length, this.readChunk || 3, Math.max(0, h.node.data.length - position));
    h.node.data.copy(buffer, offset, position, position + count); return [count, buffer, position];
  }); }
  write(h, buffer, offset, length, position, cb) { this.run('write', [h.path, position], cb, () => {
    if (this.failWrite) throw error(4, 'disk full');
    const out = Buffer.alloc(Math.max(h.node.data.length, position + length)); h.node.data.copy(out); buffer.copy(out, position, offset, offset + length); h.node.data = out; return [];
  }); }
  close(h, cb) { this.run('close', [h.path], cb, () => { this.handles.delete(h); return []; }); }
  unlink(p, cb) { this.run('unlink', [p], cb, () => { this.node(p); this.nodes.delete(p); return []; }); }
  mkdir(p, attrs, cb) { if (typeof attrs === 'function') cb = attrs; this.run('mkdir', [p], cb, () => { if (this.nodes.has(p)) throw error(4, 'exists'); this.put(p, 'directory'); return []; }); }
  rmdir(p, cb) { this.run('rmdir', [p], cb, () => { if ([...this.nodes.keys()].some(n => n !== p && path.posix.dirname(n) === p)) throw error(4, 'not empty'); this.node(p); this.nodes.delete(p); return []; }); }
  rename(a, b, cb) { this.run('rename', [a, b], cb, () => {
    if (this.nodes.has(b)) throw error(4, 'exists'); this.node(a);
    const moved = [...this.nodes].filter(([p]) => p === a || p.startsWith(`${a}/`));
    for (const [p, node] of moved) { this.nodes.set(b + p.slice(a.length), node); this.nodes.delete(p); }
    return [];
  }); }
  ext_openssh_rename(a, b, cb) { this.run('posix-rename', [a, b], cb, () => { if (!this.renameSupported) throw error(8, 'unsupported'); this.nodes.set(b, this.node(a)); this.nodes.delete(a); return []; }); }
}

function fixture(t, options = {}) {
  const sftp = new FakeSftp(); const events = []; let connected = true;
  const files = createSshFiles({ getSftp: async () => sftp, assertSession: () => { if (!connected) throw error('STALE', 'session closed'); }, onChange: e => events.push(e), ...options });
  t.after(() => files.dispose());
  return { sftp, files, events, disconnect() { connected = false; files.disposeSession('session-1'); } };
}

async function complete(files, transferId) {
  for (let i = 0; i < 500; i++) {
    const view = files.listTransfers().find(x => x.id === transferId);
    if (['completed', 'failed', 'cancelled', 'conflict'].includes(view.status)) return view;
    await pause(5);
  }
  throw new Error('transfer timeout');
}

test('lists home with bounded pages and closes directory handles', async t => {
  const { sftp, files } = fixture(t);
  for (let i = 0; i < 5; i++) sftp.put(`/home/test/file-${i}`, 'file', 'abc');
  let result = await files.list({ sessionId: 'session-1', path: '', limit: 2 }); const entries = [...result.entries];
  assert.equal(result.path, '/home/test');
  while (result.cursor) { result = await files.list({ sessionId: 'session-1', cursor: result.cursor }); entries.push(...result.entries); }
  assert.equal(entries.length, 5); assert.equal(sftp.handles.size, 0);
});

test('UTF8 preview pages do not split characters; unsupported bytes remain readonly', async t => {
  const { sftp, files } = fixture(t); sftp.put('/home/test/你好.txt', 'file', 'ab中文cd');
  const first = await files.preview({ sessionId: 'session-1', path: '/home/test/你好.txt', limit: 5 });
  assert.equal(first.text, 'ab中'); assert.equal(first.nextOffset, 5); assert.equal(first.hasMore, true);
  const second = await files.preview({ sessionId: 'session-1', path: first.path, offset: first.nextOffset, limit: 5 });
  assert.equal(first.text + second.text, 'ab中文cd');
  sftp.put('/home/test/data.bin', 'file', Buffer.from([0xff, 0x00, 0x80]));
  assert.equal((await files.openDocument({ sessionId: 'session-1', path: '/home/test/data.bin' })).kind, 'binary');
  assert.equal(sftp.handles.size, 0);
});

test('document save checks full content fingerprint even when size and mtime match', async t => {
  const { sftp, files } = fixture(t); sftp.put('/home/test/a.txt', 'file', 'old');
  const doc = await files.openDocument({ sessionId: 'session-1', path: '/home/test/a.txt' });
  sftp.node(doc.path).data = Buffer.from('new');
  await assert.rejects(files.saveDocument({ sessionId: 'session-1', documentId: doc.documentId, revision: doc.revision, text: 'mine' }), /变化|冲突/);
  assert.equal(sftp.node(doc.path).data.toString(), 'new');
  const fresh = await files.openDocument({ sessionId: 'session-1', path: doc.path });
  const saved = await files.saveDocument({ sessionId: 'session-1', documentId: fresh.documentId, revision: fresh.revision, text: 'saved 中文' });
  assert.notEqual(saved.revision, fresh.revision); assert.equal(sftp.node(doc.path).data.toString(), 'saved 中文');
  assert.equal(sftp.handles.size, 0); assert.equal([...sftp.nodes.keys()].some(x => x.includes('.adb-workbench-')), false);
});

test('write failure and missing atomic-rename support preserve original file', async t => {
  const { sftp, files } = fixture(t); sftp.put('/home/test/a.txt', 'file', 'old');
  const doc = await files.openDocument({ sessionId: 'session-1', path: '/home/test/a.txt' });
  sftp.failWrite = true;
  await assert.rejects(files.saveDocument({ sessionId: 'session-1', documentId: doc.documentId, revision: doc.revision, text: 'mine' }), /disk full/);
  sftp.failWrite = false; sftp.renameSupported = false;
  await assert.rejects(files.saveDocument({ sessionId: 'session-1', documentId: doc.documentId, revision: doc.revision, text: 'mine' }), /原子|覆盖/);
  assert.equal(sftp.node(doc.path).data.toString(), 'old');
  assert.equal(sftp.calls.some(([method, p]) => method === 'unlink' && p === doc.path), false);
  assert.equal(sftp.handles.size, 0); assert.equal([...sftp.nodes.keys()].some(x => x.includes('.adb-workbench-')), false);
});

test('delete requires one-use unchanged plan, prohibits root/home and unlinks symlinks only', async t => {
  const { sftp, files } = fixture(t);
  for (const p of ['/', '/home/test', '/home/test/..']) await assert.rejects(files.planDelete({ sessionId: 'session-1', path: p }), /根目录|主目录|路径/);
  sftp.put('/home/test/dir', 'directory'); sftp.put('/home/test/dir/link', 'symlink', '/outside'); sftp.put('/outside', 'file', 'keep');
  const plan = await files.planDelete({ sessionId: 'session-1', path: '/home/test/dir' });
  await files.confirmDelete({ sessionId: 'session-1', planId: plan.planId });
  assert.equal(sftp.nodes.has('/home/test/dir'), false); assert.equal(sftp.node('/outside').data.toString(), 'keep');
  await assert.rejects(files.confirmDelete({ sessionId: 'session-1', planId: plan.planId }), /失效|确认/);
  sftp.put('/home/test/a', 'file', 'old'); const changed = await files.planDelete({ sessionId: 'session-1', path: '/home/test/a' });
  sftp.node('/home/test/a').mtime++;
  await assert.rejects(files.confirmDelete({ sessionId: 'session-1', planId: changed.planId }), /变化|冲突/);
  assert.equal(sftp.nodes.has('/home/test/a'), true);
});

test('mkdir and move validate names, never overwrite implicitly', async t => {
  const { sftp, files } = fixture(t);
  await files.mkdir({ sessionId: 'session-1', parent: '/home/test', name: 'new' });
  await assert.rejects(files.mkdir({ sessionId: 'session-1', parent: '/home/test', name: '../escape' }), /名称|路径/);
  sftp.put('/home/test/a', 'file', 'a'); sftp.put('/home/test/b', 'file', 'b');
  await assert.rejects(files.move({ sessionId: 'session-1', source: '/home/test/a', destination: '/home/test/b' }), /存在|覆盖/);
  await files.move({ sessionId: 'session-1', source: '/home/test/a', destination: '/home/test/c' });
  assert.equal(sftp.node('/home/test/c').data.toString(), 'a');
});

test('session disposal invalidates documents and pending reads without stale success', async t => {
  const f = fixture(t); f.sftp.put('/home/test/a', 'file', 'hello');
  const doc = await f.files.openDocument({ sessionId: 'session-1', path: '/home/test/a' });
  f.sftp.delay = 5;
  const pending = f.files.preview({ sessionId: 'session-1', path: doc.path });
  f.disconnect();
  await assert.rejects(pending, /session|会话|连接/);
  await assert.rejects(f.files.saveDocument({ sessionId: 'session-1', documentId: doc.documentId, revision: doc.revision, text: 'stale' }), /session|会话|连接|失效/);
  assert.equal(f.sftp.node(doc.path).data.toString(), 'hello');
});

test('directory upload/download uses temporary files and reports confirmed bytes', async t => {
  const { sftp, files } = fixture(t); const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-files-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source'); await fs.mkdir(source); await fs.writeFile(path.join(source, 'hello.txt'), '你好'); await fs.mkdir(path.join(source, 'empty'));
  const up = await files.startTransfer({ sessionId: 'session-1', direction: 'upload', sources: [source], destination: '/home/test', overwrite: false });
  const uploaded = await complete(files, up.transferId); assert.equal(uploaded.status, 'completed', uploaded.error); assert.equal(uploaded.bytes, 6);
  assert.equal(sftp.node('/home/test/source/hello.txt').data.toString(), '你好'); assert.equal(sftp.node('/home/test/source/empty').type, 'directory');
  const downloads = path.join(dir, 'downloads'); await fs.mkdir(downloads);
  const down = await files.startTransfer({ sessionId: 'session-1', direction: 'download', sources: ['/home/test/source'], destination: downloads, overwrite: false });
  const downloaded = await complete(files, down.transferId); assert.equal(downloaded.status, 'completed', downloaded.error);
  assert.equal(await fs.readFile(path.join(downloads, 'source', 'hello.txt'), 'utf8'), '你好');
  assert.equal(sftp.handles.size, 0);
});

test('transfer collision changes nothing until explicit retry with overwrite', async t => {
  const { sftp, files } = fixture(t); const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-files-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'a.txt'); await fs.writeFile(source, 'replacement'); sftp.put('/home/test/a.txt', 'file', 'original');
  const { transferId } = await files.startTransfer({ sessionId: 'session-1', direction: 'upload', sources: [source], destination: '/home/test', overwrite: false });
  assert.equal((await complete(files, transferId)).status, 'conflict'); assert.equal(sftp.node('/home/test/a.txt').data.toString(), 'original');
  await files.retryTransfer({ transferId, overwrite: true });
  assert.equal((await complete(files, transferId)).status, 'completed'); assert.equal(sftp.node('/home/test/a.txt').data.toString(), 'replacement');
});

test('cancel transfer closes owned handles, removes only temporary file, retains original', async t => {
  const { sftp, files } = fixture(t); const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-files-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'a.txt'); await fs.writeFile(source, Buffer.alloc(100000, 65)); sftp.delay = 2;
  const { transferId } = await files.startTransfer({ sessionId: 'session-1', direction: 'upload', sources: [source], destination: '/home/test', overwrite: false });
  await pause(10); await files.cancelTransfer({ transferId });
  assert.equal((await complete(files, transferId)).status, 'cancelled'); assert.equal(sftp.nodes.has('/home/test/a.txt'), false);
  await pause(20); assert.equal([...sftp.nodes.keys()].some(x => x.includes('.adb-workbench-')), false); assert.equal(sftp.handles.size, 0);
});

test('downloads reject remote root, Windows path escapes and symlinks', async t => {
  const { sftp, files } = fixture(t); const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-files-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await assert.rejects(files.startTransfer({ sessionId: 'session-1', direction: 'download', sources: ['/'], destination: dir }), /根目录/);
  sftp.put('/home/test/bad', 'directory'); sftp.put('/home/test/bad/evil:ads', 'file', 'x');
  let result = await files.startTransfer({ sessionId: 'session-1', direction: 'download', sources: ['/home/test/bad'], destination: dir });
  assert.equal((await complete(files, result.transferId)).status, 'failed'); assert.deepEqual(await fs.readdir(dir), []);
  sftp.put('/home/test/link', 'symlink', '/outside'); result = await files.startTransfer({ sessionId: 'session-1', direction: 'download', sources: ['/home/test/link'], destination: dir });
  assert.equal((await complete(files, result.transferId)).status, 'failed');
});

test('cancelling during wx callback removes the owned late-created temporary file', async t => {
  const { sftp, files } = fixture(t); const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-files-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'late.txt'); await fs.writeFile(source, 'late'); sftp.delay = 3;
  const { transferId } = await files.startTransfer({ sessionId: 'session-1', direction: 'upload', sources: [source], destination: '/home/test' });
  for (let i = 0; i < 300 && !sftp.calls.some(([method, , flags]) => method === 'open' && flags === 'wx'); i++) await pause(1);
  assert.equal(sftp.calls.some(([method, , flags]) => method === 'open' && flags === 'wx'), true);
  await files.cancelTransfer({ transferId }); await pause(15);
  assert.equal([...sftp.nodes.keys()].some(x => x.includes('.adb-workbench-')), false); assert.equal(sftp.handles.size, 0);
  assert.equal(sftp.nodes.has('/home/test/late.txt'), false);
});

test('retry verifies and skips files already committed instead of replaying them', async t => {
  const { sftp, files } = fixture(t); const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-files-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'a.txt'), 'first'); await fs.writeFile(path.join(dir, 'b.txt'), 'second');
  const originalRename = sftp.rename.bind(sftp); let failSecond = true;
  sftp.rename = (a, b, cb) => b.endsWith('/b.txt') && failSecond ? queueMicrotask(() => cb(error(4, 'injected failure'))) : originalRename(a, b, cb);
  const { transferId } = await files.startTransfer({ sessionId: 'session-1', direction: 'upload', sources: [path.join(dir, 'a.txt'), path.join(dir, 'b.txt')], destination: '/home/test' });
  assert.equal((await complete(files, transferId)).status, 'failed'); assert.equal(sftp.node('/home/test/a.txt').data.toString(), 'first');
  failSecond = false; await files.retryTransfer({ transferId }); assert.equal((await complete(files, transferId)).status, 'completed');
  assert.equal(sftp.calls.filter(([method, , dest]) => method === 'rename' && dest === '/home/test/a.txt').length, 1);
  assert.equal(sftp.node('/home/test/b.txt').data.toString(), 'second');
});

test('retry refuses to replay a previously committed file changed externally', async t => {
  const { sftp, files } = fixture(t); const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-files-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'a.txt'), 'first'); await fs.writeFile(path.join(dir, 'b.txt'), 'second');
  const originalRename = sftp.rename.bind(sftp);
  sftp.rename = (a, b, cb) => b.endsWith('/b.txt') ? queueMicrotask(() => cb(error(4, 'failure'))) : originalRename(a, b, cb);
  const { transferId } = await files.startTransfer({ sessionId: 'session-1', direction: 'upload', sources: [path.join(dir, 'a.txt'), path.join(dir, 'b.txt')], destination: '/home/test' });
  assert.equal((await complete(files, transferId)).status, 'failed'); sftp.node('/home/test/a.txt').data = Buffer.from('other');
  await files.retryTransfer({ transferId, overwrite: true }); const result = await complete(files, transferId);
  assert.equal(result.status, 'failed'); assert.match(result.error, /已完成的文件已变化/); assert.equal(sftp.node('/home/test/a.txt').data.toString(), 'other');
});

test('real READDIR EOF status and filtered empty pages are supported', async t => {
  const { sftp, files } = fixture(t); let page = 0;
  sftp.readdir = (_handle, callback) => queueMicrotask(() => page++ === 0 ? callback(null, []) : callback(error(1, 'End of file')));
  assert.deepEqual((await files.list({ sessionId: 'session-1', path: '' })).entries, []); assert.equal(sftp.handles.size, 0);
});

test('editor tokens survive long edits, close explicitly and preserve independent documents', async t => {
  const { sftp, files } = fixture(t); sftp.put('/home/test/a', 'file', 'old');
  const doc = await files.openDocument({ sessionId: 'session-1', path: '/home/test/a' });
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 24 * 60 * 60 * 1000);
  await files.saveDocument({ sessionId: 'session-1', documentId: doc.documentId, revision: doc.revision, text: 'day later' });
  assert.equal(sftp.node(doc.path).data.toString(), 'day later');
  assert.deepEqual(files.closeDocument({ sessionId: 'session-1', documentId: doc.documentId }), { closed: true });
  await assert.rejects(files.saveDocument({ sessionId: 'session-1', documentId: doc.documentId, revision: doc.revision, text: 'closed' }), /失效/);
});

test('large text and binary documents are bounded and cannot save truncated content', async t => {
  const { sftp, files } = fixture(t); sftp.readChunk = 65536;
  sftp.put('/home/test/large.txt', 'file', Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  const large = await files.openDocument({ sessionId: 'session-1', path: '/home/test/large.txt' });
  assert.equal(large.readOnly, true); assert.equal(large.text.length, 256 * 1024); assert.equal(large.hasMore, true);
  await assert.rejects(files.saveDocument({ sessionId: 'session-1', documentId: large.documentId, text: 'truncated' }), /只读/);
  assert.deepEqual(files.closeDocument({ sessionId: 'session-1', documentId: large.documentId }), { closed: true });
  sftp.put('/home/test/binary', 'file', Buffer.from([255, 0, 1]));
  const binary = await files.openDocument({ sessionId: 'session-1', path: '/home/test/binary' });
  assert.equal(binary.kind, 'binary'); files.closeDocument({ sessionId: 'session-1', documentId: binary.documentId });
});

test('concurrent editors for one remote path cannot overwrite each other inside this process', async t => {
  const { sftp, files } = fixture(t); sftp.put('/home/test/a', 'file', 'old');
  const first = await files.openDocument({ sessionId: 'session-1', path: '/home/test/a' });
  const second = await files.openDocument({ sessionId: 'session-1', path: '/home/test/a' }); sftp.delay = 1;
  const saving = files.saveDocument({ sessionId: 'session-1', documentId: first.documentId, revision: first.revision, text: 'first' });
  await assert.rejects(files.saveDocument({ sessionId: 'session-1', documentId: second.documentId, revision: second.revision, text: 'second' }), { code: 'SFTP_PATH_BUSY' });
  await saving; assert.equal(sftp.node('/home/test/a').data.toString(), 'first');
  await assert.rejects(files.saveDocument({ sessionId: 'session-1', documentId: second.documentId, revision: second.revision, text: 'second' }), { code: 'SFTP_CONFLICT' });
});

test('download replacement is explicit and preserves local originals on write failure', async t => {
  const { sftp, files } = fixture(t); sftp.readChunk = 65536;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-files-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  sftp.put('/home/test/a.txt', 'file', 'remote'); await fs.writeFile(path.join(dir, 'a.txt'), 'local');
  const { transferId } = await files.startTransfer({ sessionId: 'session-1', direction: 'download', sources: ['/home/test/a.txt'], destination: dir });
  assert.equal((await complete(files, transferId)).status, 'conflict'); assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'local');
  await files.retryTransfer({ transferId, overwrite: true }); const done = await complete(files, transferId);
  assert.equal(done.status, 'completed', done.error); assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'remote');
});

test('invalid ranges, unpaired text and disallowed local file names fail without mutation', async t => {
  const { sftp, files } = fixture(t); sftp.put('/home/test/a', 'file', 'old');
  for (const offset of [-1, Infinity, 0.5]) await assert.rejects(files.preview({ sessionId: 'session-1', path: '/home/test/a', offset }), /范围/);
  const doc = await files.openDocument({ sessionId: 'session-1', path: '/home/test/a' });
  await assert.rejects(files.saveDocument({ sessionId: 'session-1', documentId: doc.documentId, revision: doc.revision, text: '\ud800' }), /文本/);
  for (const name of ['CON', 'LPT1.txt', 'trailing.', 'trailing ', '..', 'a\\escape', 'a:b']) {
    const { localName } = require('../electron/lib/ssh-files-policy.cjs'); assert.throws(() => localName(name));
  }
  assert.equal(sftp.node('/home/test/a').data.toString(), 'old');
});

test('dispose aborts a pending SFTP acquisition without waiting for a native callback', async () => {
  let started = false;
  const files = createSshFiles({ getSftp: () => { started = true; return new Promise(() => {}); } });
  const pending = files.list({ sessionId: 'waiting', path: '' });
  await pause(1); assert.equal(started, true); files.disposeSession('waiting');
  await assert.rejects(pending, /会话已结束/); await files.dispose();
});

test('double retry cannot enqueue a second worker for the same failed transfer', async t => {
  const { sftp, files } = fixture(t); const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-files-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'a.txt'); await fs.writeFile(source, 'new'); sftp.put('/home/test/a.txt', 'file', 'old');
  const { transferId } = await files.startTransfer({ sessionId: 'session-1', direction: 'upload', sources: [source], destination: '/home/test' });
  assert.equal((await complete(files, transferId)).status, 'conflict');
  const first = files.retryTransfer({ transferId, overwrite: true });
  await assert.rejects(files.retryTransfer({ transferId, overwrite: true }), /不能重试/); await first;
  assert.equal((await complete(files, transferId)).status, 'completed');
  assert.equal(sftp.calls.filter(([method]) => method === 'posix-rename').length, 1);
});

test('an upload cannot run while an editor is committing the same path', async t => {
  const { sftp, files } = fixture(t); const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-files-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'a.txt'); await fs.writeFile(source, 'upload'); sftp.put('/home/test/a.txt', 'file', 'old');
  const document = await files.openDocument({ sessionId: 'session-1', path: '/home/test/a.txt' });
  const open = sftp.open.bind(sftp); let unlock; let entered;
  const held = new Promise(resolve => { entered = resolve; });
  sftp.open = (p, flags, ...args) => {
    if (flags === 'wx' && !unlock) { unlock = () => open(p, flags, ...args); entered(); } else open(p, flags, ...args);
  };
  const save = files.saveDocument({ sessionId: 'session-1', documentId: document.documentId, revision: document.revision, text: 'editor' }); await held;
  const { transferId } = await files.startTransfer({ sessionId: 'session-1', direction: 'upload', sources: [source], destination: '/home/test', overwrite: true });
  const result = await complete(files, transferId); assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'SFTP_PATH_BUSY');
  unlock(); await save; assert.equal(sftp.node('/home/test/a.txt').data.toString(), 'editor');
});

test('image preview is signature-based, bounded and refuses oversized decoded dimensions', async t => {
  const { sftp, files } = fixture(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  sftp.put('/home/test/image.bin', 'file', png);
  const image = await files.openDocument({ sessionId: 'session-1', path: '/home/test/image.bin' });
  assert.equal(image.kind, 'image'); assert.equal(image.readOnly, true); assert.match(image.dataUrl, /^data:image\/png;base64,/);
  files.closeDocument({ sessionId: 'session-1', documentId: image.documentId });
  const huge = Buffer.from(png); huge.writeUInt32BE(100000, 16); huge.writeUInt32BE(100000, 20); sftp.put('/home/test/huge.png', 'file', huge);
  assert.equal((await files.preview({ sessionId: 'session-1', path: '/home/test/huge.png' })).kind, 'binary');
  sftp.put('/home/test/fake.png', 'file', '<script>alert(1)</script>');
  assert.equal((await files.openDocument({ sessionId: 'session-1', path: '/home/test/fake.png' })).kind, 'text');
});

test('createFile atomically creates an empty ordinary file and never replaces an existing entry', async t => {
  const { sftp, files } = fixture(t);
  const result = await files.createFile({ sessionId: 'session-1', parent: '/home/test', name: 'new.txt' });
  assert.deepEqual(result, { path: '/home/test/new.txt' }); assert.equal(sftp.node(result.path).type, 'file'); assert.equal(sftp.node(result.path).data.length, 0);
  sftp.node(result.path).data = Buffer.from('keep');
  await assert.rejects(files.createFile({ sessionId: 'session-1', parent: '/home/test', name: 'new.txt' }), { code: 'SFTP_EXISTS' });
  assert.equal(sftp.node(result.path).data.toString(), 'keep');
  for (const name of ['..', '../bad', 'bad/name', '', 'bad\0name']) await assert.rejects(files.createFile({ sessionId: 'session-1', parent: '/home/test', name }), /名称/);
  sftp.put('/home/test/link', 'symlink', '/outside');
  await assert.rejects(files.createFile({ sessionId: 'session-1', parent: '/home/test/link', name: 'bad' }), /目录|链接/);
  assert.equal(sftp.handles.size, 0); assert.equal([...sftp.nodes.keys()].some(x => x.includes('.adb-workbench-')), false);
});

test('createFile late wx cancellation cleans only its temporary, not a user-created target', async t => {
  const { sftp, files } = fixture(t); const nativeOpen = sftp.open.bind(sftp); let finishOpen; let entered;
  const held = new Promise(resolve => { entered = resolve; });
  sftp.open = (p, flags, ...args) => {
    if (flags === 'wx') { finishOpen = () => nativeOpen(p, flags, ...args); entered(); } else nativeOpen(p, flags, ...args);
  };
  const creating = files.createFile({ sessionId: 'session-1', parent: '/home/test', name: 'late.txt' });
  await held; files.disposeSession('session-1'); sftp.put('/home/test/late.txt', 'file', 'external'); finishOpen();
  await assert.rejects(creating, /会话/); await pause(10);
  assert.equal(sftp.node('/home/test/late.txt').data.toString(), 'external');
  assert.equal(sftp.handles.size, 0); assert.equal([...sftp.nodes.keys()].some(x => x.includes('.adb-workbench-')), false);
});

test('createFile detects a target appearing before final rename and preserves it', async t => {
  const { sftp, files } = fixture(t); const close = sftp.close.bind(sftp);
  sftp.close = (handle, callback) => { if (handle.path.includes('.adb-workbench-')) sftp.put('/home/test/race.txt', 'file', 'external'); close(handle, callback); };
  await assert.rejects(files.createFile({ sessionId: 'session-1', parent: '/home/test', name: 'race.txt' }), /存在|覆盖/);
  assert.equal(sftp.node('/home/test/race.txt').data.toString(), 'external');
  assert.equal([...sftp.nodes.keys()].some(x => x.includes('.adb-workbench-')), false);
});

test('rename updates an open document token and saves only to its new path', async t => {
  const { sftp, files } = fixture(t); sftp.put('/home/test/old.txt', 'file', 'original');
  const document = await files.openDocument({ sessionId: 'session-1', path: '/home/test/old.txt' });
  const moved = await files.move({ sessionId: 'session-1', source: document.path, destination: '/home/test/new.txt' });
  assert.deepEqual(moved, { source: '/home/test/old.txt', path: '/home/test/new.txt', movedDocuments: [{ documentId: document.documentId, path: '/home/test/new.txt' }] });
  await files.saveDocument({ sessionId: 'session-1', documentId: document.documentId, revision: document.revision, text: 'edited after rename' });
  assert.equal(sftp.node('/home/test/new.txt').data.toString(), 'edited after rename'); assert.equal(sftp.nodes.has('/home/test/old.txt'), false);
});

test('moving a directory updates descendants but not similarly prefixed documents', async t => {
  const { sftp, files } = fixture(t); sftp.put('/home/test/folder', 'directory'); sftp.put('/home/test/folder/nested', 'directory'); sftp.put('/home/test/folder-more', 'directory');
  sftp.put('/home/test/folder/a.txt', 'file', 'a'); sftp.put('/home/test/folder/nested/b.txt', 'file', 'b'); sftp.put('/home/test/folder-more/c.txt', 'file', 'c');
  const a = await files.openDocument({ sessionId: 'session-1', path: '/home/test/folder/a.txt' });
  const b = await files.openDocument({ sessionId: 'session-1', path: '/home/test/folder/nested/b.txt' });
  const c = await files.openDocument({ sessionId: 'session-1', path: '/home/test/folder-more/c.txt' });
  const result = await files.move({ sessionId: 'session-1', source: '/home/test/folder', destination: '/home/test/renamed' });
  assert.deepEqual(result.movedDocuments, [{ documentId: a.documentId, path: '/home/test/renamed/a.txt' }, { documentId: b.documentId, path: '/home/test/renamed/nested/b.txt' }]);
  for (const document of [a, b, c]) await files.saveDocument({ sessionId: 'session-1', documentId: document.documentId, revision: document.revision, text: 'updated' });
  assert.equal(sftp.node('/home/test/renamed/a.txt').data.toString(), 'updated'); assert.equal(sftp.node('/home/test/renamed/nested/b.txt').data.toString(), 'updated');
  assert.equal(sftp.node(c.path).data.toString(), 'updated'); assert.equal(sftp.nodes.has('/home/test/folder'), false);
});

test('rename never changes document paths in another SSH session', async t => {
  const first = new FakeSftp(); const second = new FakeSftp();
  first.put('/home/test/shared.txt', 'file', 'host one'); second.put('/home/test/shared.txt', 'file', 'host two');
  const files = createSshFiles({ getSftp: async id => id === 'first' ? first : second }); t.after(() => files.dispose());
  const a = await files.openDocument({ sessionId: 'first', path: '/home/test/shared.txt' });
  const b = await files.openDocument({ sessionId: 'second', path: '/home/test/shared.txt' });
  const result = await files.move({ sessionId: 'first', source: a.path, destination: '/home/test/renamed.txt' });
  assert.deepEqual(result.movedDocuments, [{ documentId: a.documentId, path: '/home/test/renamed.txt' }]);
  await files.saveDocument({ sessionId: 'second', documentId: b.documentId, revision: b.revision, text: 'host two edited' });
  assert.equal(second.node(b.path).data.toString(), 'host two edited'); assert.equal(second.nodes.has('/home/test/renamed.txt'), false);
  assert.equal(first.node('/home/test/renamed.txt').data.toString(), 'host one');
});

test('delete returns its exact target without discarding an open draft token', async t => {
  const { sftp, files } = fixture(t); sftp.put('/home/test/draft.txt', 'file', 'original');
  const document = await files.openDocument({ sessionId: 'session-1', path: '/home/test/draft.txt' });
  const plan = await files.planDelete({ sessionId: 'session-1', path: document.path });
  assert.deepEqual(await files.confirmDelete({ sessionId: 'session-1', planId: plan.planId }), { path: document.path, removed: 1 });
  await assert.rejects(files.saveDocument({ sessionId: 'session-1', documentId: document.documentId, revision: document.revision, text: 'unsaved draft' }), /不存在/);
  assert.equal(sftp.nodes.has(document.path), false);
  assert.deepEqual(files.closeDocument({ sessionId: 'session-1', documentId: document.documentId }), { closed: true });
});

async function transferRecordDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-transfer-records-'));
  t.after(async () => {
    const target = await fs.realpath(directory);
    assert.equal(path.dirname(target), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('ssh-transfer-records-'));
    await fs.rm(target, { recursive: true, force: true });
  });
  return directory;
}
async function settledTransfer(files, transferId) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const value = files.listTransfers().find(item => item.id === transferId);
    if (value?.canClear) return value;
    await pause(2);
  }
  throw new Error('Transfer did not settle');
}
test('transfer record clear keeps downloaded bytes and resolves its directory after SSH disconnect', async t => {
  const h = fixture(t); const directory = await transferRecordDirectory(t); h.sftp.put('/home/test/a.txt', 'file', 'downloaded bytes');
  const { transferId } = await h.files.startTransfer({ sessionId: 'session-1', direction: 'download', sources: ['/home/test/a.txt'], destination: directory });
  assert.equal((await complete(h.files, transferId)).canClear, true);
  h.disconnect(); const calls = h.sftp.calls.length;
  assert.deepEqual(await h.files.getTransferLocation({ transferId, path: 'ignored-renderer-path' }), { kind: 'local', sessionId: 'session-1', path: await fs.realpath(directory) });
  assert.deepEqual(h.files.clearTransfer({ transferId }), { removedIds: [transferId] });
  assert.equal(await fs.readFile(path.join(directory, 'a.txt'), 'utf8'), 'downloaded bytes');
  assert.equal(h.sftp.node('/home/test/a.txt').data.toString(), 'downloaded bytes'); assert.equal(h.sftp.calls.length, calls);
  assert.deepEqual(h.files.listTransfers(), []);
  assert.throws(() => h.files.clearTransfer({ transferId }), /不存在|移出/);
  await assert.rejects(h.files.getTransferLocation({ transferId }), /不存在|移出/);
});
test('transfer location uses the recorded upload destination and clearing never deletes either copy', async t => {
  const h = fixture(t); const directory = await transferRecordDirectory(t); const source = path.join(directory, 'upload.txt'); await fs.writeFile(source, 'keep both');
  const { transferId } = await h.files.startTransfer({ sessionId: 'session-1', direction: 'upload', sources: [source], destination: '/home/test' });
  assert.equal((await complete(h.files, transferId)).canClear, true);
  assert.deepEqual(await h.files.getTransferLocation({ transferId, destination: '/forged' }), { kind: 'remote', sessionId: 'session-1', path: '/home/test' });
  const calls = h.sftp.calls.length;
  assert.deepEqual(h.files.clearTransfers(), { removedIds: [transferId] });
  assert.equal(await fs.readFile(source, 'utf8'), 'keep both'); assert.equal(h.sftp.node('/home/test/upload.txt').data.toString(), 'keep both'); assert.equal(h.sftp.calls.length, calls);
  assert.deepEqual(h.files.clearTransfers(), { removedIds: [] });
});
test('settling transfer records cannot clear or retry before the worker promise has finished', async t => {
  const observed = []; const retries = []; let files;
  const h = fixture(t, { onChange: event => {
    if (event.type !== 'transfer' || event.transfer.status !== 'conflict') return;
    const record = event.transfer;
    if (record.canClear === false) retries.push(assert.rejects(files.retryTransfer({ transferId: record.id }), { code: 'SFTP_RETRY_INVALID' }));
    let clearError;
    try { files.clearTransfer({ transferId: record.id }); } catch (failure) { clearError = failure.code; }
    observed.push({ canClear: record.canClear, clearError });
  } }); files = h.files;
  assert.equal(typeof files.clearTransfer, 'function');
  const directory = await transferRecordDirectory(t); const source = path.join(directory, 'a.txt'); await fs.writeFile(source, 'new'); h.sftp.put('/home/test/a.txt', 'file', 'old');
  await files.startTransfer({ sessionId: 'session-1', direction: 'upload', sources: [source], destination: '/home/test' });
  for (let attempt = 0; !observed.some(item => item.canClear) && attempt < 500; attempt++) await pause(2);
  assert.deepEqual(observed, [{ canClear: false, clearError: 'SFTP_TRANSFER_BUSY' }, { canClear: true, clearError: undefined }]);
  await Promise.all(retries);
  assert.deepEqual(files.listTransfers(), []); assert.equal(h.sftp.node('/home/test/a.txt').data.toString(), 'old');
});
test('transfer record bulk clear removes failed cancelled and conflict records while active work continues', async t => {
  const h = fixture(t); assert.equal(typeof h.files.clearTransfers, 'function');
  const directory = await transferRecordDirectory(t); const start = async name => {
    const source = path.join(directory, name); await fs.writeFile(source, name);
    return h.files.startTransfer({ sessionId: 'session-1', direction: 'upload', sources: [source], destination: '/home/test' });
  };
  h.sftp.put('/home/test/conflict.txt', 'file', 'old'); const conflict = await start('conflict.txt'); assert.equal((await settledTransfer(h.files, conflict.transferId)).status, 'conflict');
  h.sftp.failWrite = true; const failed = await start('failed.txt'); assert.equal((await settledTransfer(h.files, failed.transferId)).status, 'failed'); h.sftp.failWrite = false;
  const cancelled = await start('cancelled.txt'); await h.files.cancelTransfer(cancelled); assert.equal((await settledTransfer(h.files, cancelled.transferId)).status, 'cancelled');
  let release; let entered; const held = new Promise(resolve => { entered = resolve; }); const nativeWrite = h.sftp.write.bind(h.sftp);
  h.sftp.write = (...args) => { release = () => nativeWrite(...args); entered(); };
  const active = await start('active.txt'); await held;
  try {
    assert.equal(h.files.listTransfers().find(item => item.id === active.transferId).canClear, false);
    assert.throws(() => h.files.clearTransfer(active), { code: 'SFTP_TRANSFER_BUSY' });
    await assert.rejects(h.files.getTransferLocation(active), /完成/);
    assert.deepEqual(new Set(h.files.clearTransfers().removedIds), new Set([conflict.transferId, failed.transferId, cancelled.transferId]));
    assert.deepEqual(h.files.listTransfers().map(item => item.id), [active.transferId]);
    await assert.rejects(h.files.retryTransfer(conflict), /不存在|移出/);
  } finally { h.sftp.write = nativeWrite; release(); }
  assert.equal((await settledTransfer(h.files, active.transferId)).status, 'completed'); assert.equal(h.sftp.node('/home/test/active.txt').data.toString(), 'active.txt');
  assert.equal(h.sftp.node('/home/test/conflict.txt').data.toString(), 'old');
});
test('retrying transfer records remain protected through failed acquisition and become clearable only afterwards', async t => {
  let sftp; let held = false; let rejectAcquire; const events = [];
  const h = fixture(t, { getSftp: () => held ? new Promise((_resolve, reject) => { rejectAcquire = reject; }) : Promise.resolve(sftp), onChange: event => events.push(event) }); sftp = h.sftp;
  assert.equal(typeof h.files.clearTransfer, 'function');
  const directory = await transferRecordDirectory(t); const source = path.join(directory, 'a.txt'); await fs.writeFile(source, 'new'); sftp.put('/home/test/a.txt', 'file', 'old');
  const job = await h.files.startTransfer({ sessionId: 'session-1', direction: 'upload', sources: [source], destination: '/home/test' }); await settledTransfer(h.files, job.transferId);
  held = true; const retry = h.files.retryTransfer({ ...job, overwrite: true }); const rejected = assert.rejects(retry, /fixture failure/); await pause(1);
  try {
    assert.throws(() => h.files.clearTransfer(job), { code: 'SFTP_TRANSFER_BUSY' }); assert.deepEqual(h.files.clearTransfers(), { removedIds: [] });
  } finally { rejectAcquire(new Error('fixture failure')); }
  await rejected;
  const final = events.filter(event => event.transfer?.id === job.transferId && event.transfer.status === 'conflict').slice(-2);
  assert.deepEqual(final.map(event => event.transfer.canClear), [false, true]);
  assert.deepEqual(h.files.clearTransfer(job), { removedIds: [job.transferId] }); assert.equal(sftp.node('/home/test/a.txt').data.toString(), 'old');
});
test('transfer location rejects missing or replaced local directories without contacting SSH', async t => {
  const h = fixture(t); const directory = await transferRecordDirectory(t); const target = path.join(directory, 'download'); await fs.mkdir(target);
  h.sftp.put('/home/test/a.txt', 'file', 'keep'); const job = await h.files.startTransfer({ sessionId: 'session-1', direction: 'download', sources: ['/home/test/a.txt'], destination: target });
  assert.equal((await complete(h.files, job.transferId)).canClear, true); h.disconnect(); const calls = h.sftp.calls.length;
  await fs.rename(target, path.join(directory, 'moved'));
  await assert.rejects(h.files.getTransferLocation(job), /目录|移动|删除/);
  await fs.writeFile(target, 'not a directory'); await assert.rejects(h.files.getTransferLocation(job), /目录/);
  assert.equal(h.sftp.calls.length, calls); assert.equal(await fs.readFile(path.join(directory, 'moved', 'a.txt'), 'utf8'), 'keep');
});
test('transfer location rejects a completed destination redirected by a directory junction', async t => {
  const h = fixture(t); const directory = await transferRecordDirectory(t); const target = path.join(directory, 'download'); const moved = path.join(directory, 'original'); await fs.mkdir(target);
  h.sftp.put('/home/test/a.txt', 'file', 'keep'); const job = await h.files.startTransfer({ sessionId: 'session-1', direction: 'download', sources: ['/home/test/a.txt'], destination: target }); await settledTransfer(h.files, job.transferId);
  await fs.rename(target, moved);
  try { await fs.symlink(moved, target, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (failure) { if (failure.code === 'EPERM' || failure.code === 'EACCES') { t.skip('Directory links unavailable'); return; } throw failure; }
  await assert.rejects(h.files.getTransferLocation(job), { code: 'SFTP_LOCAL_DIRECTORY' });
  assert.equal(await fs.readFile(path.join(moved, 'a.txt'), 'utf8'), 'keep');
});
test('transfer location detects parent junction redirection even when the destination leaf is a directory', async t => {
  const h = fixture(t); const directory = await transferRecordDirectory(t); const parent = path.join(directory, 'parent'); const target = path.join(parent, 'download'); const moved = path.join(directory, 'original'); await fs.mkdir(target, { recursive: true });
  h.sftp.put('/home/test/a.txt', 'file', 'keep'); const job = await h.files.startTransfer({ sessionId: 'session-1', direction: 'download', sources: ['/home/test/a.txt'], destination: target }); await settledTransfer(h.files, job.transferId);
  await fs.rename(parent, moved);
  try { await fs.symlink(moved, parent, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (failure) { if (failure.code === 'EPERM' || failure.code === 'EACCES') { t.skip('Directory links unavailable'); return; } throw failure; }
  assert.equal((await fs.lstat(target)).isSymbolicLink(), false);
  await assert.rejects(h.files.getTransferLocation(job), { code: 'SFTP_LOCAL_DIRECTORY' });
  assert.equal(await fs.readFile(path.join(moved, 'download', 'a.txt'), 'utf8'), 'keep');
});
test('transfer location does not return a removed record after asynchronous filesystem validation', async t => {
  const h = fixture(t); const directory = await transferRecordDirectory(t); h.sftp.put('/home/test/a.txt', 'file', 'keep');
  const job = await h.files.startTransfer({ sessionId: 'session-1', direction: 'download', sources: ['/home/test/a.txt'], destination: directory }); const record = await settledTransfer(h.files, job.transferId);
  const nativeLstat = fs.lstat; let release;
  fs.lstat = async target => target === record.target ? new Promise((resolve, reject) => { release = () => nativeLstat(target).then(resolve, reject); }) : nativeLstat(target);
  try {
    const location = h.files.getTransferLocation(job); const rejected = assert.rejects(location, { code: 'SFTP_TRANSFER_INVALID' });
    assert.equal(typeof release, 'function'); h.files.clearTransfer(job); release(); await rejected;
  } finally { fs.lstat = nativeLstat; }
  assert.equal(await fs.readFile(path.join(directory, 'a.txt'), 'utf8'), 'keep'); assert.deepEqual(h.files.listTransfers(), []);
});

module.exports = { FakeSftp, fixture, complete };
