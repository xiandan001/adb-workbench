const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createLogArchive, normalizeArchiveOptions } = require('../electron/lib/log-archive.cjs');
function directory(t) {
  const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'veylo-log-archive-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), base); assert.ok(path.basename(root).startsWith('veylo-log-archive-')); fs.rmSync(root, { recursive: true, force: false }); });
  return path.join(root, 'log-archives');
}
test('archiving defaults off and accepts only explicit allowed quota settings', () => {
  assert.deepEqual(normalizeArchiveOptions(), { enabled: false, maxBytes: 512 * 1024 * 1024 });
  for (const maxBytes of [128, 256, 512, 1024]) assert.equal(normalizeArchiveOptions({ enabled: true, maxBytes: maxBytes * 1024 * 1024 }).enabled, true);
  for (const value of [{ enabled: true }, { enabled: true, maxBytes: 4 }, { enabled: 'true', maxBytes: 536870912 }, { enabled: true, maxBytes: 536870912, path: 'elsewhere' }]) assert.throws(() => normalizeArchiveOptions(value));
});
test('archive segments preserve exact raw lines and independently flush their own capture', async t => {
  const root = directory(t), options = { enabled: true, maxBytes: 128 * 1024 * 1024 };
  const first = await createLogArchive({ directory: root, captureId: 'one', options }, { segmentBytes: 16 });
  first.append('11-16 A03200/App/Tag: 中文'); first.append('next'); await first.stop();
  const state = first.info(); assert.equal(state.status, 'stopped'); assert.equal(state.partial, false); assert.ok(state.segments > 1);
  const own = path.join(root, state.archiveId), parts = fs.readdirSync(own).filter(name => name.endsWith('.log')).sort();
  assert.equal(Buffer.concat(parts.map(name => fs.readFileSync(path.join(own, name)))).toString(), '11-16 A03200/App/Tag: 中文\nnext\n');
  const second = await createLogArchive({ directory: root, captureId: 'two', options }); second.append('second'); await second.stop();
  assert.notEqual(first.info().archiveId, second.info().archiveId); assert.equal(first.info().captureId, 'one'); assert.equal(second.info().captureId, 'two');
});
test('total archive quota stops only archiving, preserves older evidence and reports partial', async t => {
  const root = directory(t); fs.mkdirSync(root); const old = path.join(root, 'old.log'); fs.writeFileSync(old, 'old'); fs.truncateSync(old, 128 * 1024 * 1024 - 17000);
  const archive = await createLogArchive({ directory: root, captureId: 'quota', options: { enabled: true, maxBytes: 128 * 1024 * 1024 } });
  assert.equal(archive.append('x'.repeat(1000)), false); await archive.stop();
  assert.equal(archive.info().partial, true); assert.equal(archive.info().reason, 'quota'); assert.equal(fs.statSync(old).size, 128 * 1024 * 1024 - 17000);
});
test('pending archive writes stay bounded and queue overflow produces an explicit incomplete state', async t => {
  const states = [], pressures = [];
  const archive = await createLogArchive({ directory: directory(t), captureId: 'disk', options: { enabled: true, maxBytes: 128 * 1024 * 1024 },
    onState: state => states.push(state), onPressure: value => pressures.push(value) },
  { fsOps: { ...fs.promises, open: async () => { throw Error('injected disk failure'); } }, maxPendingBytes: 32 });
  archive.append('x'.repeat(20)); archive.append('x'.repeat(20)); await archive.stop();
  assert.ok(states.every(state => state.pendingBytes <= 32)); assert.equal(archive.info().status, 'partial'); assert.equal(archive.info().partial, true);
  assert.ok(pressures.includes(true)); assert.equal(pressures.at(-1), false);
});
test('an asynchronous disk write failure stops only this archive and reports disk partial', async t => {
  const archive = await createLogArchive({ directory: directory(t), captureId: 'disk-failure', options: { enabled: true, maxBytes: 128 * 1024 * 1024 } },
    { fsOps: { ...fs.promises, open: async () => { throw Error('fixture quota denied'); } } });
  assert.equal(archive.append('still in capture buffer'), true); await archive.stop();
  assert.equal(archive.info().status, 'partial'); assert.equal(archive.info().reason, 'disk'); assert.match(archive.info().error, /fixture quota denied/); assert.equal(archive.info().pendingBytes, 0);
});
test('raw stdout chunk archiving preserves CRLF and split multibyte bytes without reformatting', async t => {
  const root = directory(t), raw = Buffer.from('HiLog A03200/Tag: 中文😀\r\nraw no ending');
  const archive = await createLogArchive({ directory: root, captureId: 'raw', options: { enabled: true, maxBytes: 128 * 1024 * 1024 } });
  archive.appendChunk(raw.subarray(0, 22)); archive.appendChunk(raw.subarray(22)); await archive.stop();
  const file = path.join(root, archive.info().archiveId, 'part-00001.log'); assert.ok(fs.readFileSync(file).equals(raw));
});
