const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withLocale } = require('../electron/lib/localization.cjs');
const { writeIpControlSnapshot } = require('../electron/lib/ip-control-export.cjs');

function workspace(t) {
  const base = fs.realpathSync(os.tmpdir());
  const folder = fs.mkdtempSync(path.join(base, 'ip-control-export-test-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(folder)), base);
    assert.ok(path.basename(folder).startsWith('ip-control-export-test-'));
    fs.rmSync(folder, { recursive: true });
  });
  return folder;
}
const now = Date.UTC(2026, 10, 18, 10, 12, 30, 456);
const capture = (entries, mode = 'udp') => ({ mode, sessionId: 'capture-demo', host: '::1', port: 8192,
  localPort: 3001, dropped: 4, entries });
const row = (id, direction, data, extra) => ({ id, at: now + id, direction, data, ...extra });
const expectedHex = data => Array.from(data, value => value.toString(16).toUpperCase().padStart(2, '0')).join(' ');

test('exports every retained network record with full HEX, zero length UDP and session metadata, beyond display and AI limits', async t => {
  const folder = workspace(t), file = path.join(folder, 'capture.log');
  const large = Buffer.alloc(65507, 0xaf); large[0] = 0; large[65506] = 0x80;
  const entries = Array.from({ length: 2100 }, (_, n) => row(n + 1, n % 2 ? 'RX' : 'TX', Buffer.from([n & 255, 0])));
  entries.push(row(2101, 'RX', Buffer.alloc(0)), row(2102, 'TX', large));
  fs.writeFileSync(file, 'old');
  await withLocale('en-US', () => writeIpControlSnapshot(file, capture(entries), { isCurrent: () => true }));
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('capture-demo') && text.includes('[::1]:8192') && text.includes('3001') && text.includes('UDP'));
  assert.ok(text.includes('Evicted from cache: 4') && text.includes(new Date(now + 1).toISOString()));
  assert.doesNotMatch(text, /\r/);
  const hexRows = text.split('\n').filter(line => line.startsWith('HEX:'));
  assert.deepEqual(hexRows, entries.map(e => 'HEX: ' + expectedHex(e.data)));
  assert.deepEqual(fs.readdirSync(folder), ['capture.log']);
});

test('TCP server export preserves the actual peer per record', async t => {
  const file = path.join(workspace(t), 'peer.txt');
  await writeIpControlSnapshot(file, capture([
    row(11, 'RX', Buffer.from([0xde, 0xad]), { peerHost: '127.0.0.1', peerPort: 1100 }),
    row(12, 'TX', Buffer.from([0xff]), { peerHost: '::1', peerPort: 2200 }),
  ], 'tcp-server'));
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /RX.*127\.0\.0\.1:1100/);
  assert.match(text, /TX.*\[::1\]:2200/);
});

test('scope invalidated while exporting: existing file and unrelated records are untouched; private temp is removed', async t => {
  const folder = workspace(t), file = path.join(folder, 'retained.log'), sentinel = path.join(folder, 'serial.log');
  fs.writeFileSync(file, 'prior export'); fs.writeFileSync(sentinel, 'independent');
  await assert.rejects(writeIpControlSnapshot(file, capture([row(1,'TX',Buffer.from([255]))]), {
    isCurrent: () => !fs.readdirSync(folder).some(name => name.endsWith('.tmp')),
  }), { code: 'STALE_RECORDS' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'prior export');
  assert.equal(fs.readFileSync(sentinel,'utf8'),'independent');
  assert.deepEqual(fs.readdirSync(folder).sort(), ['retained.log', 'serial.log']);
});

test('unsupported paths, hard links and destinations replaced during staging do not overwrite user files', async t => {
  const folder = workspace(t), first = path.join(folder, 'first.txt'), second = path.join(folder, 'other.log');
  const snapshot = capture([row(1, 'RX', Buffer.from([1, 2]))]);
  await assert.rejects(writeIpControlSnapshot('relative.txt', snapshot));
  await assert.rejects(writeIpControlSnapshot(path.join(folder, 'bad.exe'), snapshot));
  fs.writeFileSync(first, 'keep'); fs.linkSync(first,second);
  await assert.rejects(writeIpControlSnapshot(second, snapshot));
  assert.equal(fs.readFileSync(first, 'utf8'), 'keep');
  fs.unlinkSync(second);
  let changed = false;
  await assert.rejects(writeIpControlSnapshot(first, snapshot, { isCurrent() {
    if (!changed && fs.readdirSync(folder).some(name => name.endsWith('.tmp'))) {
      changed = true; fs.writeFileSync(first, 'other process saved this');
    }
    return true;
  } }));
  assert.equal(fs.readFileSync(first,'utf8'),'other process saved this');
  assert.deepEqual(fs.readdirSync(folder), ['first.txt']);
});

test('storage failure during atomic replacement cannot erase a previous export or leave a partial result', async t => {
  const folder = workspace(t), target = path.join(folder, 'old.log');
  fs.writeFileSync(target, 'previous file');
  const fault = t.mock.method(fs.promises, 'rename', async (source, destination) => {
    assert.equal(destination, target);
    assert.match(await fs.promises.readFile(source, 'utf8'), /HEX: DE AD/);
    throw Object.assign(new Error('disk error'), { code: 'EIO' });
  });
  await assert.rejects(writeIpControlSnapshot(target, capture([row(1,'TX',Buffer.from([0xde,0xad]))])), {code:'EIO'});
  assert.equal(fault.mock.callCount(), 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'previous file');
  assert.deepEqual(fs.readdirSync(folder), ['old.log']);
});
