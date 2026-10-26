const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const localization = require('../electron/lib/localization.cjs');

const file = path.resolve(__dirname, '../electron/lib/serial-export.cjs');
const source = fs.readFileSync(file, 'utf8');
const FIXED_TIME = 1760000000000;
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [FIXED_TIME])); } }
function load({ filesystem = fs, uuid, onYield = () => {} } = {}) {
  const module = { exports: {} }; const localRequire = createRequire(file);
  vm.runInThisContext(`(function(require,module,exports,Date,setImmediate){${source}\n})`)(name => {
    if (name === 'node:fs') return filesystem;
    if (name === 'node:crypto' && uuid) return { randomUUID: () => uuid };
    return localRequire(name);
  }, module, module.exports, FixedDate, callback => { onYield(); return setImmediate(callback); });
  return module.exports;
}
function snapshot(count = 300, bytes = 20) {
  const raw = Buffer.alloc(bytes, 0x61); raw[bytes - 1] = 10;
  const config = { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' };
  return { workspace: 'terminal', rxBytes: count * bytes, txBytes: 0, evicted: 0,
    entries: Array.from({ length: count }, (_, id) => ({ id, time: FIXED_TIME + id, endTime: FIXED_TIME + id,
      path: 'synthetic-port', sessionId: 'synthetic-session', config, direction: 'RX', kind: 'raw', parts: 1,
      bytes: raw.length, text: raw.toString('utf8'), hex: raw.toString('hex') })) };
}
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'serial-export-batch-'));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('batched file output is byte-identical to the synchronous formatter in every locale', async t => {
  const root = directory(t); const api = load(); const data = snapshot();
  for (const locale of ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR']) {
    await localization.withLocale(locale, async () => {
      const target = path.join(root, locale + '.log'); const expected = api.formatSerialSnapshot(data);
      await api.writeSerialSnapshot(target, data);
      assert.equal(fs.readFileSync(target, 'utf8'), expected);
    });
  }
  assert.ok(fs.readdirSync(root).every(name => name.endsWith('.log')));
});

test('10k x 500B export yields after bounded batches, preserves exact bytes and closes before rename', async () => {
  const data = snapshot(10000, 500); const hash = createHash('sha256'); let writes = 0, yields = 0, heartbeat = 0, maxChunkBytes = 0;
  let closed = false, renamed = false; const unlinks = [];
  const filesystem = { promises: {
    realpath: async value => value,
    lstat: async () => { throw Object.assign(new Error('fixture missing'), { code: 'ENOENT' }); },
    open: async (_temporary, flags) => {
      assert.equal(flags, 'wx');
      return { writeFile: async (chunk, options) => {
        assert.deepEqual(options, { encoding: 'utf8' }); writes++; hash.update(chunk, 'utf8'); maxChunkBytes = Math.max(maxChunkBytes, Buffer.byteLength(chunk));
      }, close: async () => { closed = true; } };
    },
    rename: async () => { assert.equal(closed, true); renamed = true; },
    unlink: async value => unlinks.push(value)
  } };
  const api = load({ filesystem, onYield: () => { yields++; } });
  const timer = setInterval(() => { heartbeat++; }, 1);
  try { await api.writeSerialSnapshot(path.join(os.tmpdir(), 'synthetic-export.log'), data); }
  finally { clearInterval(timer); }
  assert.equal(writes, 1 + Math.ceil(data.entries.length / 128)); assert.equal(yields, Math.ceil(data.entries.length / 128));
  assert.ok(heartbeat > 1); assert.ok(maxChunkBytes < 1024 * 1024); assert.equal(renamed, true); assert.deepEqual(unlinks, []);
  const reference = load(); const header = reference.formatSerialSnapshot({ ...data, entries: [] });
  const expected = createHash('sha256').update(header);
  for (let start = 0; start < data.entries.length; start += 128) {
    const formatted = reference.formatSerialSnapshot({ ...data, entries: data.entries.slice(start, start + 128) });
    assert.ok(formatted.startsWith(header)); expected.update(formatted.slice(header.length));
  }
  assert.equal(hash.digest('hex'), expected.digest('hex'));
});

test('async exports keep their initial language and one header time even when global preferences change', async t => {
  const root = directory(t); const data = snapshot(); const original = localization.getLocale(); t.after(() => localization.setLocale(original));
  localization.setLocale('en-US'); const expected = load().formatSerialSnapshot(data); let writes = 0;
  const filesystem = { ...fs, promises: { ...fs.promises, open: async (...args) => {
    const handle = await fs.promises.open(...args);
    return { writeFile: async (...values) => { if (++writes === 1) localization.setLocale('ja-JP'); return handle.writeFile(...values); }, close: () => handle.close() };
  } } };
  const target = path.join(root, 'language.log'); await load({ filesystem }).writeSerialSnapshot(target, data);
  assert.equal(fs.readFileSync(target, 'utf8'), expected);
});

test('write or rename failure preserves the previous destination and removes only the owned temporary', async t => {
  const root = directory(t); const target = path.join(root, 'capture.log'); const data = snapshot();
  for (const failure of ['write', 'rename']) {
    fs.writeFileSync(target, 'previous destination'); let writes = 0;
    const filesystem = { ...fs, promises: { ...fs.promises,
      open: async (...args) => {
        const handle = await fs.promises.open(...args);
        return { writeFile: async (...values) => {
          if (++writes === 3 && failure === 'write') throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
          return handle.writeFile(...values);
        }, close: () => handle.close() };
      },
      rename: async (...args) => { if (failure === 'rename') throw Object.assign(new Error('fixture rename denied'), { code: 'EACCES' }); return fs.promises.rename(...args); }
    } };
    await assert.rejects(load({ filesystem }).writeSerialSnapshot(target, data), /fixture/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'previous destination'); assert.deepEqual(fs.readdirSync(root), ['capture.log']);
  }
});

test('an exclusive-open collision never unlinks a temporary file owned by someone else', async t => {
  const root = directory(t); const target = path.join(root, 'capture.log'); const collision = path.join(root, '.serial-export-collision.tmp');
  fs.writeFileSync(target, 'previous destination'); fs.writeFileSync(collision, 'unrelated temporary');
  await assert.rejects(load({ uuid: 'collision' }).writeSerialSnapshot(target, snapshot(1)), error => error.code === 'EEXIST');
  assert.equal(fs.readFileSync(target, 'utf8'), 'previous destination'); assert.equal(fs.readFileSync(collision, 'utf8'), 'unrelated temporary');
});
