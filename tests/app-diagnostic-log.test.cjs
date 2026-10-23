const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAppDiagnosticLog } = require('../electron/lib/app-diagnostic-log.cjs');

function fixture(t, options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-safe-diagnostics-'));
  const directory = path.join(base, 'diagnostics'); let clock = Date.parse('2026-10-23T12:00:00Z');
  const logger = createAppDiagnosticLog({ directory, version: '4.7.0', now: () => clock, ...options });
  t.after(async () => { await logger.dispose(); fs.rmSync(base, { recursive: true, force: true }); });
  return { logger, base, directory, advance: (ms = 1100) => { clock += ms; } };
}
const event = extra => ({ level: 'error', module: 'ipc', operation: 'ipc', outcome: 'failure', errorCode: 'IPC_THROW', channel: 'serial:connect', ...extra });

test('logs retain only known metadata; arbitrary payloads, messages, paths and secret-shaped codes never appear', async t => {
  const h = fixture(t); let accessed = false;
  const input = event({ message: 'PASSWORD private-command', args: ['C:\\Users\\private'], headers: { Authorization: 'secret-token' }, errorCode: 'PASSWORD_PRIVATE' });
  Object.defineProperty(input, 'response', { enumerable: true, get() { accessed = true; throw Error('secret'); } });
  assert.equal(h.logger.record(input), true); assert.equal(accessed, false);
  assert.equal(h.logger.record(event({ module: 'private-token' })), false);
  const result = await h.logger.snapshot(); assert.equal(result.lines, 1); assert.equal(result.bytes, Buffer.byteLength(result.text));
  assert.match(result.text, /serial:connect/); assert.match(result.text, /UNKNOWN/); assert.doesNotMatch(result.text, /PASSWORD|private|secret|Authorization|Users|message|args|headers/);
  assert.deepEqual(Object.keys(result).sort(), ['bytes', 'lines', 'text', 'truncated']);
});

test('bounded queue and repeated failure rate limiting do not block record or grow without limit', async t => {
  const h = fixture(t); assert.equal(h.logger.record(event()), true); assert.equal(h.logger.record(event()), false);
  for (let i = 0; i < 200; i++) { h.advance(); h.logger.record(event()); }
  await h.logger.flush(); const result = await h.logger.snapshot();
  assert.equal(result.truncated, true); assert.ok(result.lines <= 128); assert.ok(result.bytes <= 16384);
});

test('rotation and frozen tails are bounded and snapshot data survives a new logger without exposing paths', async t => {
  const h = fixture(t, { maxFileBytes: 700, maxSnapshotBytes: 600 });
  for (let i = 0; i < 25; i++) { h.advance(); h.logger.record(event({ durationMs: i })); await h.logger.flush(); }
  const entries = fs.readdirSync(h.directory); assert.ok(entries.length <= 3); assert.ok(entries.every(name => /^app(?:\.[12])?\.log$/.test(name)));
  for (const name of entries) assert.ok(fs.statSync(path.join(h.directory, name)).size <= 700);
  const saved = await h.logger.snapshot(); assert.ok(saved.bytes <= 600); assert.ok(saved.lines > 0); assert.equal(saved.truncated, true);
  const restarted = createAppDiagnosticLog({ directory: h.directory, version: '4.7.0', maxSnapshotBytes: 600 });
  assert.equal((await restarted.snapshot()).text, saved.text); await restarted.dispose();
  h.advance(); h.logger.record(event()); await h.logger.flush(); assert.notEqual((await h.logger.snapshot()).text, saved.text);
});

test('disk errors are nonfatal, flush settles and disposal rejects future events', async t => {
  const h = fixture(t); fs.writeFileSync(h.directory, 'not a directory');
  assert.equal(h.logger.record(event()), true); await h.logger.flush();
  assert.deepEqual(await h.logger.snapshot(), { text: '', bytes: 0, lines: 0, truncated: true });
  await h.logger.dispose(); assert.equal(h.logger.record(event()), false);
});

test('linked directories or files never write outside the private diagnostics scope', async t => {
  const h = fixture(t); const outside = path.join(h.base, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, h.directory, process.platform === 'win32' ? 'junction' : 'dir');
  h.logger.record(event()); await h.logger.flush(); assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal((await h.logger.snapshot()).truncated, true);
});

test('hardlinked log files are rejected without altering either name', async t => {
  const h = fixture(t); fs.mkdirSync(h.directory); const target = path.join(h.base, 'private-file'); fs.writeFileSync(target, 'DO-NOT-CHANGE');
  fs.linkSync(target, path.join(h.directory, 'app.log')); h.logger.record(event()); await h.logger.flush();
  assert.equal(fs.readFileSync(target, 'utf8'), 'DO-NOT-CHANGE'); assert.equal((await h.logger.snapshot()).text, '');
});

test('snapshot rejects tampered or partial log lines and never returns unknown fields from disk', async t => {
  const h = fixture(t); h.logger.record(event()); await h.logger.flush();
  fs.appendFileSync(path.join(h.directory, 'app.log'), '{"message":"private-secret"}\n{"time":"unfinished-secret');
  const result = await h.logger.snapshot(); assert.equal(result.lines, 1); assert.equal(result.truncated, true); assert.doesNotMatch(result.text, /private|secret|unfinished/);
});

test('a readonly empty snapshot never creates a diagnostics directory', async t => {
  const h = fixture(t); assert.equal(fs.existsSync(h.directory), false);
  assert.deepEqual(await h.logger.snapshot(), { text: '', bytes: 0, lines: 0, truncated: false });
  assert.equal(fs.existsSync(h.directory), false);
});

test('backlog includes a blocked in-flight batch and dispose drains accepted records only', async t => {
  const io = Object.create(fs.promises); let release; let opened;
  const openEntered = new Promise(resolve => { opened = resolve; });
  const gate = new Promise(resolve => { release = resolve; }); let first = true;
  io.open = async (...args) => { if (first) { first = false; opened(); await gate; } return fs.promises.open(...args); };
  const h = fixture(t, { filesystem: io }); h.logger.record(event()); await openEntered;
  let accepted = 1; for (let i = 0; i < 140; i++) { h.advance(); accepted += Number(h.logger.record(event())); }
  assert.equal(accepted, 128); const stopped = h.logger.dispose(); assert.equal(h.logger.record(event()), false);
  release(); await stopped; const result = await h.logger.snapshot(); assert.equal(result.truncated, true); assert.ok(result.bytes <= 16384);
});

test('tampered runtime versions cannot smuggle arbitrary strings through otherwise valid stored rows', async t => {
  const h = fixture(t); h.logger.record(event()); await h.logger.flush(); const file = path.join(h.directory, 'app.log');
  const row = JSON.parse(fs.readFileSync(file, 'utf8').trim()); row.version = '4-password-private'; fs.appendFileSync(file, JSON.stringify(row) + '\n');
  const result = await h.logger.snapshot(); assert.equal(result.lines, 1); assert.equal(result.truncated, true); assert.doesNotMatch(result.text, /password|private/);
});
