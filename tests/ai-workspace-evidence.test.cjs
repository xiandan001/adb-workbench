const test = require('node:test');
const assert = require('node:assert/strict');
const { createEvidenceAdapter, sanitize, boundedText } = require('../electron/lib/ai-workspace-evidence.cjs');

test('local evidence masks common secrets, paths, terminal controls and private key blocks', () => {
  const text = '\x1b[31mpassword="secret123"\nBearer secretbearer\n--api-key secretcli\nC:\\Users\\real\\project\n10.2.3.4\n'
    + '-----BEGIN PRIVATE KEY-----\nsecretblock\n-----END PRIVATE KEY-----\nvisible';
  const safe = sanitize(text);
  for (const secret of ['secret123', 'secretbearer', 'secretcli', 'secretblock', 'real', '10.2.3.4', '\x1b']) assert.ok(!safe.includes(secret));
  assert.ok(safe.includes('visible'));
  const limited = boundedText('中文'.repeat(5000));
  assert.ok(Buffer.byteLength(limited.text) <= 8192); assert.ok(!limited.text.includes('\ufffd')); assert.equal(limited.truncated, true);
});

test('source selection is explicit and freezes only the selected session', async () => {
  let sshReads = 0; let sessionId = 'one';
  const adapter = createEvidenceAdapter({
    getLogs: () => [{ source: 'file', identity: 'a', entries: [{ raw: 'file-log' }] }],
    getSerial: () => ({ terminal: { path: 'COM4', sessionId, entries: [{ sessionId: 'old', text: 'old-secret' }, { sessionId: 'one', text: 'new-data', time: 100, direction: 'RX' }] } }),
    getSsh: () => [{ sessionId: 'ssh1', terminalId: 't1', title: 'shell', name: 'fixture', host: '127.0.0.1' }],
    readSsh: () => { sshReads++; return { text: 'ssh-text' }; }, now: () => 123,
  });
  const serial = adapter.list().find(item => item.kind === 'serial');
  assert.equal(sshReads, 0);
  const result = await adapter.collect({ sourceIds: [serial.id] });
  assert.equal(sshReads, 0); assert.equal(result.entries.length, 1);
  assert.match(result.entries[0].text, /new-data/); assert.doesNotMatch(result.entries[0].text, /old-secret/);
  sessionId = 'two';
  await assert.rejects(adapter.collect({ sourceIds: [serial.id] }), error => error.code === 'AI_SOURCE_CHANGED');
  assert.match(result.entries[0].text, /new-data/);
});

test('readonly ADB diagnostics bind every command to the supplied device and reject arbitrary tools', async () => {
  const calls = [];
  const adapter = createEvidenceAdapter({ runAdb: async (args, options) => {
    calls.push({ args, options }); return { ok: true, stdout: args[2] === 'get-state' ? 'device\n' : 'fixture' };
  } });
  const result = await adapter.collect({ deviceId: 'fixture:5555', selectedChecks: ['device_info', 'logcat_snapshot', 'performance_snapshot'] });
  assert.equal(result.entries.length, 3);
  assert.ok(calls.length > 5);
  assert.ok(calls.every(call => call.args[0] === '-s' && call.args[1] === 'fixture:5555' && call.options.maxBuffer <= (call.args.includes('logcat') ? 2 * 1024 * 1024 : 128 * 1024)));
  assert.ok(calls.some(call => call.args.join(' ').includes('logcat -d -v threadtime -t 2000')));
  assert.ok(!calls.some(call => call.args.includes('-c') || call.args.includes('reboot')));
  const before = calls.length;
  for (const args of [{ deviceId: 'fixture;reboot', selectedChecks: ['device_info'] }, { deviceId: 'fixture', selectedChecks: ['shell'] }]) {
    await assert.rejects(adapter.collect(args));
  }
  assert.equal(calls.length, before);
});

test('cancelling diagnostics kills only the child owned by this collection', async () => {
  const controller = new AbortController(); let killed = 0; let resolve;
  const adapter = createEvidenceAdapter({ runAdb: (_args, options) => {
    options.onProcess({ kill: () => { killed++; resolve({ ok: false }); } });
    return new Promise(done => { resolve = done; });
  } });
  const pending = adapter.collect({ deviceId: 'fixture', selectedChecks: ['logcat_snapshot'], signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error.code === 'CANCELLED'); assert.equal(killed, 1);
});

test('empty, oversized and missing buffered sources cannot produce a misleading preview', async () => {
  const adapter = createEvidenceAdapter({});
  await assert.rejects(adapter.collect({}), error => error.code === 'AI_EVIDENCE_EMPTY');
  await assert.rejects(adapter.collect({ text: 'x'.repeat(512 * 1024 + 1) }), error => error.code === 'AI_EVIDENCE_INPUT');
  await assert.rejects(adapter.collect({ sourceIds: ['unknown'] }), error => error.code === 'AI_SOURCE_CHANGED');
  const result = await adapter.collect({ text: 'x'.repeat(10000) });
  assert.equal(result.truncated, false); assert.equal(result.entries[0].text, '[L1] ' + 'x'.repeat(10000));
});
