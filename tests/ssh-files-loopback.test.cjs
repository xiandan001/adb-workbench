const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Client } = require('ssh2');
const { startTestServer } = require('./helpers/ssh-test-server.cjs');
const { createSshFiles } = require('../electron/lib/ssh-files.cjs');

async function connect(t, options = {}) {
  const server = await startTestServer(options); const client = new Client(); client.on('error', () => {});
  t.after(async () => { client.destroy(); await server.close(); });
  await new Promise((resolve, reject) => { client.once('ready', resolve); client.once('error', reject); client.connect({ host: server.host, port: server.port, username: server.username, password: server.password, hostVerifier: () => true, readyTimeout: 3000 }); });
  const sftp = await new Promise((resolve, reject) => client.sftp((e, value) => e ? reject(e) : resolve(value)));
  const files = createSshFiles({ getSftp: async () => sftp }); t.after(() => files.dispose());
  return { server, client, sftp, files };
}
async function finish(files, transferId) {
  for (let i = 0; i < 1000; i++) {
    const result = files.listTransfers().find(item => item.id === transferId);
    if (['completed', 'failed', 'conflict', 'cancelled'].includes(result.status)) return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Protocol transfer timeout');
}

test('real SSH/SFTP protocol browses, edits with atomic rename, transfers and deletes in sandbox', async t => {
  const { server, files } = await connect(t, { readChunkSize: 7, directoryPageSize: 2 });
  await server.writeFile('config.txt', 'original 中文\n');
  const listing = await files.list({ sessionId: 'loopback', path: '' }); assert.equal(listing.path, '/home/test'); assert.equal(listing.entries[0].name, 'config.txt');
  const doc = await files.openDocument({ sessionId: 'loopback', path: '/home/test/config.txt' });
  assert.equal(doc.text, 'original 中文\n');
  const saved = await files.saveDocument({ sessionId: 'loopback', documentId: doc.documentId, revision: doc.revision, text: 'saved 中文\r\n' });
  assert.equal(await fs.readFile(path.join(server.root, 'home', 'test', 'config.txt'), 'utf8'), 'saved 中文\r\n');
  await files.mkdir({ sessionId: 'loopback', parent: '/home/test', name: 'new-folder' });
  await files.createFile({ sessionId: 'loopback', parent: '/home/test/new-folder', name: 'empty.txt' });
  assert.equal((await fs.stat(path.join(server.root, 'home', 'test', 'new-folder', 'empty.txt'))).size, 0);
  await assert.rejects(files.createFile({ sessionId: 'loopback', parent: '/home/test/new-folder', name: 'empty.txt' }), { code: 'SFTP_EXISTS' });
  await files.move({ sessionId: 'loopback', source: '/home/test/config.txt', destination: '/home/test/new-folder/config.txt' });
  await files.saveDocument({ sessionId: 'loopback', documentId: doc.documentId, revision: saved.revision, text: 'saved after rename 中文\r\n' });
  await assert.rejects(fs.stat(path.join(server.root, 'home', 'test', 'config.txt')), { code: 'ENOENT' });
  const local = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-protocol-local-')); t.after(() => fs.rm(local, { recursive: true, force: true }));
  await fs.writeFile(path.join(local, 'upload.txt'), 'upload\0binary');
  let started = await files.startTransfer({ sessionId: 'loopback', direction: 'upload', sources: [path.join(local, 'upload.txt')], destination: '/home/test' });
  let result = await finish(files, started.transferId); assert.equal(result.status, 'completed', result.error);
  await fs.mkdir(path.join(local, 'download'));
  started = await files.startTransfer({ sessionId: 'loopback', direction: 'download', sources: ['/home/test/new-folder'], destination: path.join(local, 'download') });
  result = await finish(files, started.transferId); assert.equal(result.status, 'completed', result.error);
  assert.equal(await fs.readFile(path.join(local, 'download', 'new-folder', 'config.txt'), 'utf8'), 'saved after rename 中文\r\n');
  const plan = await files.planDelete({ sessionId: 'loopback', path: '/home/test/new-folder' }); await files.confirmDelete({ sessionId: 'loopback', planId: plan.planId });
  await assert.rejects(fs.stat(path.join(server.root, 'home', 'test', 'new-folder')), { code: 'ENOENT' });
});

test('real non-OpenSSH server safely refuses replacement while independent PTYs still echo', async t => {
  const { server, client, files } = await connect(t, { atomicRename: false, banner: false });
  await server.writeFile('keep.txt', 'original');
  const doc = await files.openDocument({ sessionId: 'loopback', path: '/home/test/keep.txt' });
  await assert.rejects(files.saveDocument({ sessionId: 'loopback', documentId: doc.documentId, revision: doc.revision, text: 'draft' }), { code: 'SFTP_ATOMIC_UNSUPPORTED' });
  assert.equal(await fs.readFile(path.join(server.root, 'home', 'test', 'keep.txt'), 'utf8'), 'original');
  const shell = () => new Promise((resolve, reject) => client.shell({ term: 'xterm-256color', cols: 90, rows: 30 }, (e, stream) => e ? reject(e) : resolve(stream)));
  const first = await shell(); const second = await shell(); const responses = ['', '']; first.on('data', data => { responses[0] += data; }); second.on('data', data => { responses[1] += data; });
  first.write('first\r'); second.write('second\t');
  for (let i = 0; i < 100 && (!responses[0] || !responses[1]); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(responses, ['first\r', 'second\t']); assert.equal(server.shells.length, 2);
  first.close(); second.close();
});
