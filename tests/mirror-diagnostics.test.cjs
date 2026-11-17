const test = require('node:test');
const assert = require('node:assert/strict');
const { createMirrorDiagnostics, normalizeMirrorLogEvent } = require('../electron/lib/mirror-diagnostics.cjs');

test('semantic diagnostics retain only fixed classifications and numeric/version/dimension metadata', () => {
  let now = 10; const rows = [], monitor = createMirrorDiagnostics({ transport: 'adb', mirrorNumber: 1, attemptNumber: 2, phase: 'launch', record: row => rows.push(row), now: () => now });
  monitor.event('opening'); monitor.output(Buffer.from('scrcpy 5.0.1 <https://private/?token=SECRET>\nINFO: Texture: 1920x1080\nERROR: Cannot create AudioRecord device=PRIVATE\n'));
  monitor.event('ready', { readiness: 'texture', phase: 'streaming' }); now = 30; monitor.finish('exit', { exitCode: 1, signal: 'SIGTERM', reason: 'AUDIO_CAPTURE' }); monitor.finish('exit', { exitCode: 2 });
  assert.equal(rows.filter(row => row.event === 'exit').length, 1); assert.equal(rows.at(-1).durationMs, 20); assert.equal(rows.at(-1).toolVersion, '5.0.1'); assert.equal(rows.at(-1).width, 1920); assert.equal(rows.at(-1).height, 1080); assert.equal(rows.at(-1).reason, 'AUDIO_CAPTURE');
  assert.doesNotMatch(JSON.stringify(rows), /SECRET|PRIVATE|https|token=|device=|message|command|payload/); for (const row of rows) assert.deepEqual(normalizeMirrorLogEvent(row), row);
});
test('split signatures and giant lines are classified with bounded raw carry, partial disclosed and no history after disposal', () => {
  const rows = [], monitor = createMirrorDiagnostics({ transport: 'adb', record: row => rows.push(row) });
  monitor.output(Buffer.from('INFO: Tex')); assert.equal(monitor.output(Buffer.from('ture: 640x360\n')).videoReady, true);
  monitor.output(Buffer.alloc(1024 * 1024, 65), 'stderr'); assert.ok(monitor.bufferedBytes() <= 4096); monitor.output(Buffer.from('\nCannot create Audio'), 'stderr'); assert.equal(monitor.output(Buffer.from('Record\n'), 'stderr').audioStartupFailure, true);
  monitor.finish('exit', { exitCode: 1 }); assert.equal(monitor.bufferedBytes(), 0); assert.equal(rows.at(-1).diagnosticPartial, true); assert.ok(rows.at(-1).diagnosticTail.includes('AUDIO_CAPTURE')); const count = rows.length; monitor.dispose(); monitor.output(Buffer.from('ERROR: SECRET\n')); monitor.event('ready'); assert.equal(rows.length, count);
});
test('strict event projection ignores arbitrary text and unsafe values without invoking accessors or proxy traps', () => {
  const secret = 'SECRET C:/private https://host/?token=token';
  const row = normalizeMirrorLogEvent({ source: 'mirror', event: 'failure', transport: 'adb', reason: secret, phase: secret, signal: secret, exitCode: Infinity, width: 20000, toolVersion: secret, diagnosticTail: ['AUDIO_CAPTURE', secret], message: secret });
  assert.deepEqual(row, { source: 'mirror', event: 'failure', transport: 'adb' });
  let calls = 0; const getter = { source: 'mirror', event: 'failure', transport: 'adb', get reason() { calls++; return secret; } }; normalizeMirrorLogEvent(getter); assert.equal(calls, 0);
  assert.equal(normalizeMirrorLogEvent(new Proxy({}, { get() { calls++; throw Error(); } })), null); assert.equal(calls, 0);
  assert.equal(normalizeMirrorLogEvent({ source: 'mirror', event: 'arbitrary', transport: 'adb' }), null);
});
test('optional recording errors never change classification results or process behavior', () => {
  const monitor = createMirrorDiagnostics({ transport: 'adb', record: () => { throw Error('sink'); } });
  assert.doesNotThrow(() => monitor.event('spawn')); assert.equal(monitor.output(Buffer.from('Cannot create AudioRecord\n')).audioStartupFailure, true); assert.doesNotThrow(() => monitor.finish('failure', { reason: 'SPAWN_FAILED' }));
});

test('the legacy demux/audio cross-line fallback remains recognized without retaining full output', () => {
  const monitor = createMirrorDiagnostics({ transport: 'adb' }); monitor.output(Buffer.from('INFO: Audio capture enabled\n'));
  assert.equal(monitor.output(Buffer.from('ERROR: Demuxer error\n'), 'stderr').audioStartupFailure, true); assert.equal(monitor.bufferedBytes(), 0);
});
