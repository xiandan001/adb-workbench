const test = require('node:test');
const assert = require('node:assert/strict');
const { createEvidenceAdapter } = require('../electron/lib/ai-workspace-evidence.cjs');
const { diagnosticPresets, normalizeDiagnostic, shapeDiagnosticSource } = require('../electron/lib/ai-workspace-diagnostics.cjs');

test('symptom presets are local metadata and application collection only issues bound read commands', async () => {
  const calls = [];
  const evidence = createEvidenceAdapter({ runAdb: async args => {
    calls.push(args);
    if (args.includes('get-state')) return { ok: true, stdout: 'device' };
    return { ok: true, stdout: args.includes('pidof') ? '123' : args.includes('package') ? 'versionName=1.0\nversionCode=5\nUser 0: installed=true\nprivate output not selected' : 'fixture' };
  } });
  assert.equal(diagnosticPresets().length, 3); assert.deepEqual(calls, []);
  const result = await evidence.collect({ deviceId: 'synthetic-device', selectedChecks: ['app_package', 'app_process'], diagnostic: { packageName: 'com.example.fixture', symptom: 'crash' } });
  assert.equal(result.entries.length, 2); assert.ok(calls.every(args => args[0] === '-s' && args[1] === 'synthetic-device'));
  assert.ok(calls.some(args => args.join(' ') === '-s synthetic-device shell dumpsys package com.example.fixture'));
  assert.ok(!result.entries[0].text.includes('private output not selected'));
  const before = calls.length;
  for (const packageName of ['com.example;reboot', '../app', 'com.example app', '']) await assert.rejects(evidence.collect({ deviceId: 'synthetic-device', selectedChecks: ['app_package'], diagnostic: { packageName, symptom: 'crash' } }));
  assert.equal(calls.length, before);
});

test('unsupported app checks are explicit unavailable evidence, never proof of health', async () => {
  const evidence = createEvidenceAdapter({ runAdb: async args => ({ ok: args.includes('get-state'), stdout: args.includes('get-state') ? 'device' : '' }) });
  const result = await evidence.collect({ deviceId: 'synthetic-device', selectedChecks: ['app_memory'], diagnostic: { packageName: 'com.example.fixture', symptom: 'slow' } });
  assert.equal(result.entries[0].unavailable, true); assert.ok(result.entries[0].text.length > 0);
  assert.throws(() => normalizeDiagnostic({ packageName: 'com.example.fixture', symptom: 'unknown' }), { code: 'AI_DIAGNOSTIC' });
});

test('Activity evidence matches an exact package rather than another package with the same prefix', () => {
  const result = shapeDiagnosticSource({ checkId: 'app_activity', diagnostic: { packageName: 'com.example.fixture', symptom: 'launch' },
    text: 'ActivityRecord com.example.fixturerogue/.Other\nmResumedActivity com.example.fixture/.Home\nOther private app state' });
  assert.match(result.text, /com\.example\.fixture\/\.Home/);
  assert.doesNotMatch(result.text, /fixturerogue|Other private/);
});
