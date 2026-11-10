const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { writeApplicationLogExport, observeWebContents } = require('../electron/lib/application-log.cjs');

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'veylo-log-export-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
test('atomic export writes LF bytes, replaces only chosen regular file, leaves no temporary files', async t => {
  const root = await directory(t), file = path.join(root, 'chosen.log');
  await fs.writeFile(file, 'previous content');
  await writeApplicationLogExport(file, '{"source":"session"}\n');
  assert.equal(await fs.readFile(file, 'utf8'), '{"source":"session"}\n');
  assert.deepEqual(await fs.readdir(root), ['chosen.log']);
});
test('failed disk write preserves existing user file and removes only owned temporary output', async t => {
  const root = await directory(t), file = path.join(root, 'chosen.log'); await fs.writeFile(file, 'preserve original');
  const io = Object.create(fs);
  io.open = async (...args) => {
    const handle = await fs.open(...args);
    return { stat: () => handle.stat(), close: () => handle.close(), sync: () => handle.sync(),
      writeFile: async () => { throw Object.assign(Error('full disk'), { code: 'ENOSPC' }); } };
  };
  await assert.rejects(writeApplicationLogExport(file, 'new', { io }));
  assert.equal(await fs.readFile(file, 'utf8'), 'preserve original'); assert.deepEqual(await fs.readdir(root), ['chosen.log']);
});
test('reject hard-linked export target and preserve both links', async t => {
  const root = await directory(t), file = path.join(root, 'chosen.log'), other = path.join(root, 'other.txt');
  await fs.writeFile(other, 'keep'); await fs.link(other, file);
  await assert.rejects(writeApplicationLogExport(file, 'replace'));
  assert.equal(await fs.readFile(other, 'utf8'), 'keep');
});
test('Electron console details are the first parameter, arbitrary text never enters records', () => {
  const contents = new EventEmitter(), rows = []; observeWebContents(contents, row => rows.push(row));
  contents.emit('console-message', { level: 'error', message: 'net::ERR_TIMED_OUT token=SECRET' }, 3, 'ignored legacy message');
  contents.emit('console-message', { level: 'warning', message: 'C:\\Users\\private\\file' }, 2);
  contents.emit('console-message', { level: 'info', message: 'do not record noise' }, 1);
  assert.equal(rows.length, 2); assert.equal(rows[0].errorCode, 'TIMEOUT');
  assert.doesNotMatch(JSON.stringify(rows), /SECRET|Users|private|legacy|message/);
});
