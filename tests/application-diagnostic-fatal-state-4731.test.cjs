const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApplicationLogSession } = require('../electron/lib/application-log-session.cjs');

test('a fatal record followed by a continuing existing handler is included in byte, record and size-cap accounting', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veylo-fatal-accounting-'));
  const session = createApplicationLogSession({ directory, maxBytes: 4096 });
  t.after(async () => { await session.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  const before = await session.start();
  assert.equal(session.recordFatal({ source: 'code', event: 'exception', message: 'FATAL_ACCOUNT_MARKER' }), true);
  const after = await session.status();
  assert.equal(after.records, before.records + 1);
  assert.equal(after.bytes, (await fs.stat(path.join(directory, 'capture.log'))).size);
  for (let index = 0; index < 30; index++) session.record({ source: 'code', event: 'console', message: 'x'.repeat(1000) });
  await session.stop(); assert.ok((await fs.stat(path.join(directory, 'capture.log'))).size <= 4096);
});

test('a fatal append remains its own recoverable JSONL row when an asynchronous ordinary write is paused mid-line', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veylo-fatal-framing-'));
  let pauseNext = false, resume, paused;
  const waiting = new Promise(resolve => { paused = resolve; });
  const io = Object.create(fs);
  io.open = async (...args) => {
    const handle = await fs.open(...args);
    return { get fd() { return handle.fd; }, stat: () => handle.stat(), sync: () => handle.sync(), close: () => handle.close(), truncate: size => handle.truncate(size),
      async writeFile(bytes) {
        if (!pauseNext) return handle.writeFile(bytes);
        pauseNext = false; const buffer = Buffer.from(bytes); await handle.writeFile(buffer.subarray(0, 12));
        paused(); await new Promise(resolve => { resume = resolve; }); await handle.writeFile(buffer.subarray(12));
      } };
  };
  const session = createApplicationLogSession({ directory, io });
  t.after(async () => { resume?.(); await session.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  await session.start(); pauseNext = true;
  session.record({ source: 'code', event: 'console', message: 'ORDINARY_PARTIAL_LINE' }); await waiting;
  assert.equal(session.recordFatal({ source: 'code', event: 'exception', message: 'FRAMED_FATAL_MARKER' }), true);
  resume(); await session.stop();
  const restored = createApplicationLogSession({ directory });
  const text = await restored.text(); assert.ok(text.includes('FRAMED_FATAL_MARKER'));
  assert.ok((await restored.status()).losses.recovery > 0); await restored.dispose();
});
