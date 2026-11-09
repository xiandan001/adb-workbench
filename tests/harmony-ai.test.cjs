const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createHarmonyEvidence } = require('../electron/lib/harmony-evidence.cjs');
const { createEvidenceAdapter, freezeEntry } = require('../electron/lib/ai-workspace-evidence.cjs');
const { computeWorkspaceJob } = require('../electron/lib/ai-workspace-compute.cjs');
const { createAiWorkspaceService } = require('../electron/lib/ai-workspace-service.cjs');
const { parseTask, promptForPlatform } = require('../electron/lib/ai-workspace-schema.cjs');
const { validateReport } = require('../electron/lib/ai-workspace-history.cjs');
const { registerDiscoveredDevices } = require('../electron/lib/device-registry.cjs');
const deviceId = 'hdc:fixture-ai';
const diagnostic = { packageName: 'com.example.fixture', symptom: 'crash' };
const analysis = { summary: 'Observed native evidence', findings: [], hypotheses: [], nextSteps: [], limitations: ['Sample only'] };
function register(status = 'device', capabilities = { shell: true, logs: true, apps: true, performance: true }) {
  registerDiscoveredDevices('hdc', [{ id: deviceId, status, capabilities }]);
}
function native(overrides = {}) {
  const calls = [];
  const provider = createHarmonyEvidence({ runHdc: async (id, args, options) => {
    calls.push({ id, args, options });
    const stdout = args[1] === 'echo' ? 'AWB_READY' : args[1] === 'hilog' ? '11-09 12:34:56.001 12 13 E A0001/com.example.fixture/Tag: JS_CRASH password=private'
      : args[1] === 'pidof' ? '123 456' : args[1] === 'hidumper' ? 'Bundle com.example.fixture Ability Entry' : 'fixture';
    return { ok: true, stdout };
  }, getPackageDetail: async (id, name) => ({ bundleName: name, versionName: '1', system: null, enabled: null, abilities: [{ name: 'Start', moduleName: 'entry' }], permissions: [{ name: 'ohos.permission.CAMERA', granted: null }] }),
  collectMetrics: async () => ({ cpu: { usage: null }, memory: { totalKb: null }, sampleError: 'unavailable' }), ...overrides });
  return { calls, provider };
}
function service(evidence, options = {}) {
  const calls = [], saves = [];
  const value = createAiWorkspaceService({ evidence, membership: async () => ({ activated: true, scope: 'vip' }),
    client: async args => { calls.push(args); return { ok: true, text: JSON.stringify(analysis) }; },
    saveTask: async (draft, metadata) => { saves.push({ draft, metadata }); return { id: 'saved', ...draft }; }, confirmSave: async () => true, ...options });
  return { value, calls, saves };
}

test('native AI checks use fixed HDC reads, redact HiLog and preserve Bundle unknown state', async () => {
  register(); const h = native();
  const adapter = createEvidenceAdapter({ harmony: h.provider, runAdb: () => assert.fail('No ADB for HDC') });
  const result = await adapter.collect({ deviceId, selectedChecks: ['device_info', 'logcat_snapshot', 'app_package', 'app_process', 'app_memory', 'app_activity'], diagnostic });
  assert.equal(result.entries.length, 6);
  assert.ok(result.entries.every(entry => entry.platform === 'harmony' && entry.source === 'hdc' && entry.target === deviceId));
  assert.match(result.entries[1].text, /JS_CRASH/); assert.doesNotMatch(result.entries[1].text, /password=private/);
  assert.match(result.entries[2].text, /"granted": null/); assert.match(result.entries[2].text, /"enabled": null/);
  assert.ok(h.calls.every(call => call.id === deviceId && call.options.timeoutMs <= 12000));
  assert.ok(!h.calls.some(call => call.args.some(arg => ['dumpsys', 'logcat', 'pm', '-r'].includes(arg))));
  assert.deepEqual(h.calls.filter(call => call.args[1] === 'hilog').map(call => call.args), [['shell', 'hilog', '-x', '-v', 'time', '-z', '2000']]);
});

test('Ready and registry generation changes cannot produce a trusted frozen native capture', async () => {
  register('ready'); const h = native(), adapter = createEvidenceAdapter({ harmony: h.provider });
  await assert.rejects(adapter.collect({ deviceId, selectedChecks: ['device_info'] }), { code: 'DEVICE_OFFLINE' });
  assert.equal(h.calls.length, 0);
  register(); let checks = 0;
  const changed = createEvidenceAdapter({ harmony: { ...h.provider, verifyTarget: async () => ({ generation: checks++ }) } });
  await assert.rejects(changed.collect({ deviceId, selectedChecks: ['logcat_snapshot'] }), { code: 'AI_SOURCE_CHANGED' });
});

test('missing native checks and refiltering remain unavailable, never a healthy zero sample', async () => {
  register(); const h = native({ runHdc: async () => ({ ok: true, stdout: '' }) });
  const missing = await h.provider.readCheck(deviceId, 'logcat_snapshot');
  const metrics = await h.provider.readCheck(deviceId, 'performance_snapshot');
  assert.equal(missing.unavailable, true); assert.equal(metrics.unavailable, true);
  const frozen = await computeWorkspaceJob('freeze', { sources: [{ ...missing, label: 'HiLog' }] });
  const filtered = await computeWorkspaceJob('refilter', { entries: frozen.entries, selection: { maxLines: 10 } });
  assert.equal(filtered[0].unavailable, true); assert.equal(filtered[0].platform, 'harmony');
  register('device', { logs: false }); const denied = native();
  assert.equal((await denied.provider.readCheck(deviceId, 'logcat_snapshot')).unavailable, true); assert.equal(denied.calls.length, 0);
});

test('native frozen analysis retains consent and exact evidence; legacy reports remain valid', async () => {
  register(); const adapter = createEvidenceAdapter({ harmony: native().provider }); const h = service(adapter), caseId = randomUUID();
  const collected = await h.value.call('collect', { caseId, mode: 'diagnose', question: 'Inspect crash', deviceId, checks: ['logcat_snapshot'] });
  assert.equal(collected.ok, true); assert.equal(collected.preview.platform, 'harmony'); assert.equal(h.calls.length, 0);
  assert.equal((await h.value.call('analyze', { caseId, previewId: collected.preview.id })).ok, false); assert.equal(h.calls.length, 0);
  const result = await h.value.call('analyze', { caseId, previewId: collected.preview.id, consent: true });
  assert.equal(result.ok, true); assert.match(h.calls[0].systemPrompt, /authoritative platform is Harmony/);
  assert.deepEqual(JSON.parse(h.calls[0].userContent).evidence, collected.preview.entries);
  const report = { id: randomUUID(), kind: 'analysis', createdAt: new Date().toISOString(), preview: collected.preview, result: analysis };
  assert.equal(validateReport(report).preview.platform, 'harmony');
  assert.throws(() => validateReport({ ...report, preview: { ...report.preview, platform: 'android' } }), { code: 'AI_REPORT' });
  const legacy = { ...report, preview: { id: randomUUID(), question: 'Legacy', entries: [freezeEntry({ kind: 'adb', checkId: 'device_info', label: 'Android', target: 'fixture-ai', text: 'Android' }, 0, Date.now())] } };
  assert.equal(validateReport(legacy).preview.platform, undefined);
  h.value.dispose();
});

test('cross-transport comparison is inconclusive even when raw target text is identical', async () => {
  register(); const h = service(createEvidenceAdapter({ harmony: native().provider, runAdb: async args => ({ ok: true, stdout: args.at(-1) === 'get-state' ? 'device' : 'Android fixture' }) }));
  const beforeId = randomUUID(), afterId = randomUUID(), compareId = randomUUID();
  const before = await h.value.call('collect', { caseId: beforeId, mode: 'diagnose', question: 'Before', deviceId: 'fixture-ai', checks: ['device_info'] });
  const analyzed = await h.value.call('analyze', { caseId: beforeId, previewId: before.preview.id, consent: true });
  const after = await h.value.call('collect', { caseId: afterId, mode: 'diagnose', question: 'After', deviceId, checks: ['device_info'] });
  const comparison = await h.value.call('comparisonPreview', { caseId: compareId, beforeRef: { caseId: beforeId, turnId: analyzed.turn.id }, afterRef: { caseId: afterId, previewId: after.preview.id } });
  assert.equal(comparison.ok, true); assert.equal(comparison.preview.platform, 'mixed'); assert.equal(comparison.preview.comparison.comparable, false);
  assert.deepEqual(comparison.preview.comparison.pairs, []); h.value.dispose();
});

test('native task parsing never treats Android numeric keys or long-press duration as native equivalents', () => {
  const source = step => JSON.stringify({ name: 'Fixture', description: '', steps: [step] });
  assert.equal(parseTask(source({ type: 'keyevent', label: 'Back', keyCode: 'Back' }), { platform: 'harmony' }).steps[0].keyCode, 'Back');
  for (const keyCode of [4, '4', 'KEYCODE_BACK', 'Power']) assert.throws(() => parseTask(source({ type: 'keyevent', label: 'Key', keyCode }), { platform: 'harmony' }));
  assert.throws(() => parseTask(source({ type: 'longPress', label: 'Press', x: 10, y: 10, durationMs: 1000 }), { platform: 'harmony' }));
  assert.equal(parseTask(source({ type: 'keyevent', label: 'Back', keyCode: 'BACK' })).steps[0].keyCode, '4');
  assert.match(promptForPlatform('plan', 'harmony'), /HiLog/);
});

test('native task saves carry authoritative platform and reject unknown focused input capability', async () => {
  register(); let step = { type: 'keyevent', label: 'Back', keyCode: 'Back' };
  const h = service({ list: () => [] }, { client: async args => { h.calls.push(args); return { ok: true, text: JSON.stringify({ name: 'Fixture', description: '', steps: [step] }) }; } });
  const caseId = randomUUID();
  const generated = await h.value.call('generateTask', { caseId, deviceId, goal: 'Back' });
  assert.equal(generated.ok, true); assert.equal(generated.draft.targetPlatform, 'harmony'); assert.equal(h.saves.length, 0);
  assert.equal((await h.value.call('saveTask', { caseId, draftId: generated.draft.id })).ok, true);
  assert.deepEqual(h.saves[0].metadata, { targetPlatform: 'harmony', deviceId });
  step = { type: 'input', label: 'Input', text: 'hello' };
  assert.equal((await h.value.call('generateTask', { caseId, deviceId, goal: 'input hello' })).code, 'AI_TASK_INPUT');
  assert.equal(JSON.parse(h.calls.at(-1).userContent).allowFocusedTextInput, false);
  register('ready'); const count = h.calls.length;
  assert.equal((await h.value.call('generateTask', { caseId, deviceId, goal: 'Back' })).code, 'DEVICE_OFFLINE');
  assert.equal(h.calls.length, count); h.value.dispose();
});
