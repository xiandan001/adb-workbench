const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePlan, parseAnalysis, parseTask, prompts, CHECKS } = require('../electron/lib/ai-workspace-schema.cjs');
const json = JSON.stringify;
const task = steps => ({ name: 'Synthetic fixture', description: 'Review first.', steps });
const analysis = { summary: 'Observed event.', findings: [{ title: 'Observed', detail: 'Sample evidence.', evidenceIds: ['E1'] }], hypotheses: ['Unconfirmed hypothesis.'], nextSteps: ['Inspect the state.'], limitations: ['Clocks are not synchronized.'] };

test('plans accept only unique fixed read-only checks and a bounded rationale', () => {
  assert.deepEqual(parsePlan(json({ checks: ['device_info'], reason: 'Read device facts.' })), { checks: ['device_info'], reason: 'Read device facts.' });
  assert.deepEqual(parsePlan('```json\n' + json({ checks: CHECKS, reason: 'Compare facts.' }) + '\n```').checks, CHECKS);
  for (const value of [
    { checks: [], reason: 'Empty' }, { checks: ['shell'], reason: 'Unsafe' }, { checks: ['device_info', 'device_info'], reason: 'Duplicate' },
    { checks: ['device_info'], reason: 'x'.repeat(2001) }, { checks: ['device_info'], reason: 'Ok', deviceId: 'other' },
    { checks: ['device_info'], reason: '' }
  ]) assert.throws(() => parsePlan(json(value)), { code: 'invalid_output' });
});

test('structured analysis preserves separate facts, hypotheses and validated references', () => {
  assert.deepEqual(parseAnalysis(json(analysis), ['E1']), analysis);
  const noFacts = { ...analysis, findings: [] };
  assert.deepEqual(parseAnalysis(json(noFacts), []), noFacts);
  for (const evidenceIds of [['E2'], ['E1', 'E1'], ['E1', 'untrusted']]) {
    const bad = { ...analysis, findings: [{ ...analysis.findings[0], evidenceIds }] };
    assert.throws(() => parseAnalysis(json(bad), ['E1']), { code: 'invalid_evidence' });
  }
  assert.throws(() => parseAnalysis(json({ ...analysis, execute: 'arbitrary' }), ['E1']), { code: 'invalid_output' });
  assert.throws(() => parseAnalysis(json({ ...analysis, hypotheses: [123] }), ['E1']), { code: 'invalid_output' });
  assert.throws(() => parseAnalysis(json(analysis), ['other']), { code: 'invalid_output' });
});

test('task drafts map exactly to existing executor field names with no arbitrary commands', () => {
  const steps = [
    { type: 'delay', label: 'Wait', durationMs: 500 },
    { type: 'screenshot', label: 'Capture' }, { type: 'perfSnapshot', label: 'Sample' },
    { type: 'tap', label: 'Tap', x: 10, y: 20 }, { type: 'longPress', label: 'Press', x: 1, y: 2, durationMs: 800 },
    { type: 'swipe', label: 'Swipe', x: 1, y: 2, endX: 30, endY: 40, durationMs: 500 },
    { type: 'input', label: 'Type', text: ' fixture text ' }, { type: 'keyevent', label: 'Home', keyCode: 'KEYCODE_HOME' },
    { type: 'waitText', label: 'Wait for text', text: 'fixture', timeoutMs: 3000 },
    { type: 'assertText', label: 'Assert text', text: 'fixture', timeoutMs: 1000 }
  ];
  assert.deepEqual(parseTask(json(task(steps))), task(steps.map(step => step.type === 'keyevent' ? { ...step, keyCode: '3' } : step)));
  for (const keyCode of [4, '4', 'BACK', 'DPAD_CENTER', 'ENTER', 'APP_SWITCH']) {
    assert.match(parseTask(json(task([{ type: 'keyevent', label: 'Key', keyCode }]))).steps[0].keyCode, /^\d+$/);
  }
});

test('unsafe step types and hidden fields are rejected instead of filtered or normalized', () => {
  for (const type of ['shell', 'externalScript', 'installApk', 'pushFile', 'inspection', 'reboot', '__proto__', 'toString']) {
    assert.throws(() => parseTask(json(task([{ type, label: 'Disallowed' }]))), { code: 'invalid_output' });
  }
  for (const extra of [{ command: 'rm -rf /' }, { localPath: 'private' }, { outputBaseDir: 'private' }, { deviceId: 'other' }, { continueOnError: true }, { selector: { xpath: '*' } }]) {
    assert.throws(() => parseTask(json(task([{ type: 'screenshot', label: 'Capture', ...extra }]))), { code: 'invalid_output' });
  }
  assert.throws(() => parseTask('{"name":"x","description":"","steps":[{"type":"screenshot","label":"x","__proto__":{"command":"bad"}}]}'), { code: 'invalid_output' });
  for (const keyCode of ['3;reboot', '$(id)', 'POWER', 26, 'KEYCODE_POWER', 999, true]) {
    assert.throws(() => parseTask(json(task([{ type: 'keyevent', label: 'Key', keyCode }]))), { code: 'invalid_output' });
  }
});

test('task bounds reject oversized, missing, coerced and control-character values', () => {
  const invalidSteps = [
    { type: 'tap', label: 'Tap', x: -1, y: 2 }, { type: 'tap', label: 'Tap', x: '1', y: 2 },
    { type: 'tap', label: 'Tap', x: 1.5, y: 2 }, { type: 'tap', label: 'Tap', x: 32768, y: 2 },
    { type: 'swipe', label: 'Swipe', startX: 1, startY: 2, endX: 3, endY: 4, durationMs: 500 },
    { type: 'delay', label: 'Wait', durationMs: 60001 }, { type: 'longPress', label: 'Press', x: 1, y: 2, durationMs: 200 },
    { type: 'input', label: 'Input', text: 'line\nbreak' }, { type: 'input', label: 'Input', text: 'x'.repeat(501) },
    { type: 'assertText', label: 'Assert', text: 'fixture', timeoutMs: 60001 },
    { type: 'screenshot', label: '\u001b[2J' }, { type: 'screenshot' }
  ];
  for (const step of invalidSteps) assert.throws(() => parseTask(json(task([step]))), { code: 'invalid_output' });
  assert.throws(() => parseTask(json(task([]))), { code: 'invalid_output' });
  assert.throws(() => parseTask(json(task(Array.from({ length: 21 }, () => ({ type: 'screenshot', label: 'x' }))))), { code: 'invalid_output' });
});

test('malformed output fails with a safe reason instead of exposing model text', () => {
  for (const source of ['secret-private-output', 'x'.repeat(65537), null, '{"checks":', 'before {"checks":["device_info"],"reason":"x"} after']) {
    assert.throws(() => parsePlan(source), error => error.code === 'invalid_output' && !error.message.includes('secret-private-output'));
  }
  for (const value of Object.values(prompts)) {
    assert.match(value, /untrusted/i);
    assert.match(value, /ONLY/);
  }
});
