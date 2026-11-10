const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createApplicationLogSession } = require('../electron/lib/application-log-session.cjs');
const { normalizeApplicationLogEvent, classifyApplicationError } = require('../electron/lib/application-log-policy.cjs');

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veylo-app-log-test-'));
  const session = createApplicationLogSession({ directory, metadata: { version: '4.7.13', platform: 'win32' }, ...options });
  t.after(async () => { await session.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, session };
}
test('capture is explicitly opt-in, writes ordered events, stops and exports UTF-8 LF', async t => {
  const { session } = await fixture(t);
  assert.equal(session.record({ source: 'app', event: 'ready' }), false);
  assert.equal((await session.status()).available, false);
  assert.equal((await session.start()).recording, true);
  assert.equal(session.record({ source: 'media', event: 'configure', codec: 'avc1.640028', supported: true }), true);
  assert.equal(session.record({ source: 'media', event: 'first-frame', output: 1, decoded: true }), true);
  await session.stop();
  assert.equal(session.record({ source: 'app', event: 'ready' }), false);
  const text = await session.text(), rows = text.trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.event), ['start', 'configure', 'first-frame', 'stop']);
  assert.equal(text.includes('\r'), false);
  assert.equal(Buffer.byteLength(text), (await session.status()).bytes);
});
test('reject arbitrary content, getters and proxies; only fixed classifications survive', async t => {
  const { session } = await fixture(t); await session.start();
  const secret = 'ghp_SECRET_password C:\\Users\\Alice https://host/?token=secret device:123456789';
  session.record({ source: 'media', event: 'decode-error', errorName: 'DataError', errorCode: 'INVALID_DATA',
    message: secret, data: secret, deviceId: secret, codec: secret, mode: secret });
  assert.equal(normalizeApplicationLogEvent(new Proxy({}, {})), null);
  assert.equal(normalizeApplicationLogEvent({ source: '__proto__', event: 'start' }), null);
  assert.equal(normalizeApplicationLogEvent({ get source() { throw Error('Do not invoke'); } }), null);
  assert.deepEqual(classifyApplicationError(new Error('net::ERR_TIMED_OUT ' + secret)), { errorName: 'Error', errorCode: 'TIMEOUT' });
  await session.stop(); const text = await session.text();
  for (const value of ['SECRET', 'Alice', 'token', '123456789', 'message', 'deviceId']) assert.equal(text.includes(value), false);
  assert.equal(JSON.parse(text.trim().split('\n')[1]).errorName, 'DataError');
});
test('survives restart without resuming capture, allows re-export and a new session', async t => {
  const { directory, session } = await fixture(t); await session.start();
  session.record({ source: 'app', event: 'ready' }); await session.stop();
  const next = createApplicationLogSession({ directory }); t.after(() => next.dispose());
  const state = await next.status(); assert.equal(state.recording, false); assert.equal(state.available, true); assert.equal(state.reason, 'manual');
  assert.match(await next.text(), /"event":"ready"/);
  await next.start(); await next.stop(); assert.doesNotMatch(await next.text(), /"event":"ready"/);
});
test('unclean exit is explicitly recovered as interrupted; injected fields are not exported', async t => {
  const { directory, session } = await fixture(t); await session.status();
  await fs.writeFile(path.join(directory, 'capture.log'), JSON.stringify({ source: 'session', event: 'start', time: new Date().toISOString(), version: '4.7.13', token: 'SECRET' }) + '\n');
  const recovered = createApplicationLogSession({ directory }); t.after(() => recovered.dispose());
  assert.equal((await recovered.status()).reason, 'interrupted');
  assert.doesNotMatch(await recovered.text(), /SECRET/);
  assert.match(await recovered.text(), /"reason":"interrupted"/);
});
test('file size and rate limit bound capture without silently losing counts', async t => {
  let tick = Date.now(); const { session } = await fixture(t, { maxBytes: 2048, now: () => tick++ });
  await session.start();
  for (let i = 0; i < 300; i++) session.record({ source: 'media', event: 'decode-summary', received: i, submitted: i, output: i });
  const state = await session.status();
  assert.equal(state.recording, false); assert.equal(state.reason, 'size-limit'); assert.ok(state.dropped > 0);
  assert.ok(Buffer.byteLength(await session.text()) <= 2048);
});
test('time limit stops automatically, repeated starts stay single-flight', async t => {
  let expire; const { session } = await fixture(t, { setTimer: callback => { expire = callback; return 1; }, clearTimer() {} });
  await Promise.all([session.start(), session.start()]); expire();
  assert.equal((await session.status()).reason, 'time-limit');
  const rows = (await session.text()).trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row => row.event === 'start').length, 1);
});
test('write failure stops recording with explicit io-error, never reports success', async t => {
  const io = Object.create(fs); io.open = async () => { throw Object.assign(Error('disk'), { code: 'EACCES' }); };
  const { session } = await fixture(t, { io });
  const state = await session.start(); assert.equal(state.recording, false); assert.equal(state.reason, 'io-error'); assert.equal(state.error, 'IO_ERROR');
  await assert.rejects(session.text());
});
test('capture refuses a hard-linked source and does not truncate the other file', async t => {
  const { directory, session } = await fixture(t); await session.status();
  const other = path.join(directory, 'unrelated.txt'); await fs.writeFile(other, 'preserve me'); await fs.link(other, path.join(directory, 'capture.log'));
  assert.equal((await session.start()).reason, 'io-error');
  assert.equal(await fs.readFile(other, 'utf8'), 'preserve me');
});
test('shutdown overlapping asynchronous start never leaves an active capture or live timer', async t => {
  const timers = new Set(); let release;
  const wait = new Promise(resolve => { release = resolve; });
  const io = Object.create(fs); io.open = async (...args) => { await wait; return fs.open(...args); };
  const { session } = await fixture(t, { io,
    setTimer: fn => { timers.add(fn); return fn; }, clearTimer: fn => timers.delete(fn) });
  await session.status();
  const starting = session.start(); await new Promise(resolve => setImmediate(resolve));
  const closing = session.dispose(); release(); await Promise.all([starting, closing]);
  assert.equal((await session.status()).recording, false); assert.equal(timers.size, 0);
  assert.equal(session.record({ source: 'app', event: 'ready' }), false);
});
test('default capture continues beyond 4 MiB, stops at 20 MiB, and the large file remains recoverable and exportable', async t => {
  const limit = 20 * 1024 * 1024; let clock = Date.now();
  const { directory, session } = await fixture(t, { now: () => clock });
  assert.throws(() => createApplicationLogSession({ directory, maxBytes: limit + 1 }), /APP_LOG_CONFIGURATION/);
  const configured = createApplicationLogSession({ directory, maxBytes: limit }); await configured.status(); await configured.dispose();
  await session.start(); let state, sequence = 0;
  let lastTick = performance.now(), maxDelay = 0;
  const heartbeat = setInterval(() => { const time = performance.now(); maxDelay = Math.max(maxDelay, time - lastTick); lastTick = time; }, 10);
  try {
    do {
      clock += 1000;
      for (let i = 0; i < 100; i++) session.record({ source: 'media', event: 'decode-summary', mode: 'hardware', codec: 'avc1.640028',
        received: sequence++, submitted: sequence, output: sequence, keyframes: sequence, width: 3840, height: 2160,
        supported: true, sps: true, pps: true, decoded: true, durationMs: sequence * 10 });
      state = await session.status();
      assert.ok(sequence < 150000, 'size limit must terminate the synthetic capture');
    } while (state.recording);
    assert.equal(state.reason, 'size-limit'); assert.ok(state.bytes > limit - 4096); assert.ok(state.bytes <= limit);
    assert.ok(state.dropped > 0);
    const restored = createApplicationLogSession({ directory }); t.after(() => restored.dispose());
    const restoredState = await restored.status();
    assert.equal(restoredState.available, true); assert.equal(restoredState.reason, 'size-limit');
    const text = await restored.text(); assert.equal(Buffer.byteLength(text), state.bytes);
    assert.ok(Buffer.byteLength(text) > 4 * 1024 * 1024); assert.match(text.slice(-300), /"reason":"size-limit"/);
    await new Promise(resolve => setTimeout(resolve, 20));
    t.diagnostic(JSON.stringify({ bytes: state.bytes, records: state.records, maxEventLoopDelayMs: Math.round(maxDelay) }));
  } finally { clearInterval(heartbeat); }
});
test('streamed recovery skips oversized cross-chunk rows without losing the following safe event or leaking fields', async t => {
  const { directory, session } = await fixture(t); await session.status();
  const time = new Date().toISOString();
  const lines = [{ time, source: 'session', event: 'start', version: '4.7.14' },
    { time, source: 'app', event: 'ready', message: 'PRIVATE_TOKEN'.repeat(20000) },
    { time, source: 'app', event: 'ready' }, { time, source: 'session', event: 'stop', reason: 'manual' }];
  await fs.writeFile(path.join(directory, 'capture.log'), lines.map(JSON.stringify).join('\n'));
  const restored = createApplicationLogSession({ directory }); t.after(() => restored.dispose());
  const state = await restored.status(); assert.equal(state.records, 3); assert.equal(state.reason, 'manual');
  const text = await restored.text(); assert.doesNotMatch(text, /PRIVATE|message/);
  assert.deepEqual(text.trim().split('\n').map(JSON.parse).map(row => row.event), ['start', 'ready', 'stop']);
});
