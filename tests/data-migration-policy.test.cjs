const test = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedFile, sanitizeFile, normalizePreferences, PORTABLE_PREF_KEYS } = require('../electron/lib/data-migration-policy.cjs');

const id = '11111111-1111-4111-8111-111111111111';
const at = '2026-10-21T10:00:00.000Z';
const script = () => ({ id: 'script-a', name: '真实录制', mode: 'replay', steps: [{ id: 'step-a', type: 'shell', command: 'echo test' }] });
const session = () => ({ schemaVersion: 1, id, name: '问题会话', source: 'realtime', savedAt: at,
  entries: [{ id: 'a', raw: 'original log' }], evidence: [{ id: 'a', raw: 'original log', ref: 'L1' }],
  aiTurns: [{ content: '说明 [L1]', evidenceRefs: ['L1'] }], markers: [] });

test('migration only permits exact portable file names and canonical session UUID files', () => {
  for (const name of ['settings.json', 'customThemes.json', 'connection_history.json', 'terminal_command_history.json',
    'task-center-scripts.json', 'task-center-history.json', 'auto-diagnose-rules.json', 'performance-thresholds.json', `log-analysis-sessions/${id}.json`]) assert.equal(isAllowedFile(name), true);
  for (const name of ['../settings.json', 'SETTINGS.JSON', 'settings.json:secret', 'vip-token.txt', 'vip-activation-records.json',
    'Local Storage/leveldb/data', 'log-analysis-sessions/.metadata/a.json', `log-analysis-sessions\\${id}.json`, 'task-center-artifacts/a.json', '/settings.json', 'C:/settings.json']) {
    assert.equal(isAllowedFile(name), false, name);
    assert.throws(() => sanitizeFile(name, {}));
  }
});

test('portable settings omit source machine output directories and preserve onboarding', () => {
  const data = { screenshotPath: 'C:/private', screenRecordPath: 'D:/video', qualityCenterPath: 'D:/quality',
    pushRemotePathHistory: ['/sdcard/Download'], taskCenterOnboarding: { schemaVersion: 1, status: 'skipped', updatedAt: at } };
  assert.deepEqual(sanitizeFile('settings.json', data), { pushRemotePathHistory: ['/sdcard/Download'], taskCenterOnboarding: data.taskCenterOnboarding });
  assert.throws(() => sanitizeFile('settings.json', { taskCenterOnboarding: { schemaVersion: 2 } }));
  assert.throws(() => sanitizeFile('settings.json', { pushRemotePathHistory: [42] }));
});

test('corrupt file shapes and versions reject instead of silently converting to empty data', () => {
  for (const [name, value] of [['connection_history.json', {}], ['terminal_command_history.json', [42]],
    ['customThemes.json', [null]], ['task-center-scripts.json', { version: 2, scripts: [] }],
    ['task-center-history.json', { version: 1, history: [{}] }], ['auto-diagnose-rules.json', []],
    ['performance-thresholds.json', { cpu: '85', memory: 80, batteryTemp: 40, dataUsed: 90 }]]) assert.throws(() => sanitizeFile(name, value), name);
});

test('connection and terminal histories retain data and validate timestamps and entry limits', () => {
  const entry = { id: 'a', deviceId: '192.168.1.2:5555', deviceName: '教室设备', ip: '192.168.1.2:5555', type: 'wifi', timestamp: at };
  assert.deepEqual(sanitizeFile('connection_history.json', [entry]), [entry]);
  assert.throws(() => sanitizeFile('connection_history.json', [{ ...entry, timestamp: 'invalid' }]));
  assert.throws(() => sanitizeFile('connection_history.json', Array(21).fill(entry)));
  assert.deepEqual(sanitizeFile('terminal_command_history.json', ['getprop', 'dumpsys activity']), ['getprop', 'dumpsys activity']);
});

test('scripts retain user file dependencies without running them, reject unsafe steps and duplicates', () => {
  const value = script();
  value.steps.push({ id: 'install', type: 'installApk', localPath: 'D:/apks/app.apk' });
  assert.deepEqual(sanitizeFile('task-center-scripts.json', { version: 1, scripts: [value] }).scripts, [value]);
  assert.throws(() => sanitizeFile('task-center-scripts.json', { version: 1, scripts: [{ ...value, steps: [{}] }] }));
  assert.throws(() => sanitizeFile('task-center-scripts.json', { version: 1, scripts: [value, value] }));
});

test('run history keeps identity and results but strips every nontransferred clickable evidence link', () => {
  const run = { id: 'run-a', scriptName: '任务', status: 'failed', scriptHash: 'hash', stressSummary: null, artifactDir: 'C:/evidence', runResultPath: 'C:/evidence/run.json',
    stressReportPath: 'C:/report.md', stressResultPath: 'C:/result.json', deviceRuns: [{ deviceId: 'device-a', steps: [{ id: 'a', artifact: 'C:/screen.png', output: 'failure', error: 'original' }] }] };
  const restored = sanitizeFile('task-center-history.json', { version: 1, history: [run] }).history[0];
  assert.equal(restored.scriptHash, 'hash');
  assert.equal(restored.artifactDir, undefined);
  assert.equal(restored.runResultPath, undefined);
  assert.equal(restored.stressReportPath, undefined);
  assert.deepEqual(restored.deviceRuns[0].steps[0], { id: 'a', output: 'failure', error: 'original' });
  assert.equal(run.artifactDir, 'C:/evidence');
  const broken = { ...run, deviceRuns: [{ deviceId: 'a', steps: [{ output: { unexpected: true } }] }] };
  assert.throws(() => sanitizeFile('task-center-history.json', { version: 1, history: [broken] }));
});

test('saved sessions retain raw evidence and reject mismatched identities, invalid dates and broken references', () => {
  const value = session();
  const next = sanitizeFile(`log-analysis-sessions/${id}.json`, value);
  assert.equal(next.entries[0].raw, 'original log');
  assert.equal(next.aiTurns[0].evidenceRefs[0], 'L1');
  assert.equal(next.id, id);
  for (const patch of [{ id: 'different' }, { schemaVersion: 2 }, { savedAt: 'invalid' }, { evidence: [] }]) {
    assert.throws(() => sanitizeFile(`log-analysis-sessions/${id}.json`, { ...value, ...patch }));
  }
});

test('diagnosis rules require valid regular expressions and performance thresholds are bounded numbers', () => {
  const rule = { id: 'custom-a', label: '问题', type: 'custom', pattern: 'failure', flags: 'i', severity: 'error', keywords: ['failure'], enabled: true, description: '', updatedAt: at };
  const source = { version: 1, builtinEnabled: { 'builtin-crash': false }, customRules: [rule] };
  assert.equal(sanitizeFile('auto-diagnose-rules.json', source).customRules[0].builtIn, false);
  assert.throws(() => sanitizeFile('auto-diagnose-rules.json', { ...source, customRules: [{ ...rule, pattern: '[' }] }));
  const thresholds = { cpu: 85, memory: 85, batteryTemp: 45, dataUsed: 90 };
  assert.deepEqual(sanitizeFile('performance-thresholds.json', thresholds), thresholds);
  assert.throws(() => sanitizeFile('performance-thresholds.json', { ...thresholds, cpu: 101 }));
});

test('preference allowlist excludes credentials, local paths and confirmation suppression', () => {
  for (const key of ['vip-token', 'activeDeviceId', 'adb-workbench.recent-apks.v1', 'adbDeviceManagement.confirmSuppressions', 'lastAppVersion', 'deviceMaintenance:a']) {
    assert.equal(PORTABLE_PREF_KEYS.includes(key), false);
    assert.throws(() => normalizePreferences({ [key]: 'true' }));
  }
  assert.deepEqual(normalizePreferences({ currentTheme: 'tech', autoUpdateEnabled: 'false', deviceNames: '{"device-a":"设备"}' }),
    { currentTheme: 'tech', autoUpdateEnabled: 'false', deviceNames: '{"device-a":"设备"}' });
  assert.throws(() => normalizePreferences({ autoUpdateEnabled: true }));
  assert.throws(() => normalizePreferences({ autoUpdateEnabled: '"false"' }));
  assert.throws(() => normalizePreferences({ deviceNames: '[]' }));
  assert.throws(() => normalizePreferences({ deviceNames: '{broken' }));
  assert.throws(() => normalizePreferences({ currentTheme: '../unsafe' }));
});

test('recursive unsafe keys, custom prototypes and oversized preferences reject before applying', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const value = JSON.parse(`{"safe":{"${key}":{"polluted":true}}}`);
    assert.throws(() => sanitizeFile('settings.json', value));
    assert.throws(() => normalizePreferences({ deviceNames: JSON.stringify(value) }));
  }
  assert.throws(() => normalizePreferences(Object.create({ inherited: true })));
  assert.throws(() => sanitizeFile('settings.json', { value: new Date() }));
  assert.throws(() => normalizePreferences({ deviceNames: JSON.stringify({ a: 'x'.repeat(4 * 1024 * 1024) }) }), /4 MB/);
  assert.equal({}.polluted, undefined);
});

test('portable preferences validate commands, filters, favorites, projection settings and clear stale selected devices', () => {
  const preferences = {
    globalCommandSettings: JSON.stringify({ enabled: true, shortcut: { ctrl: true, alt: false, shift: false, meta: false, key: 'k' }, customCommands: [] }),
    'logFilterPresets.v1': JSON.stringify([{ id: 'p1', name: '错误', filter: { minLevel: 'E' }, buffers: ['main'] }]),
    'adb-workbench.favorite-packages.v1': '["android","com.example","android"]',
    scrcpySettings: JSON.stringify({ screenOff: false, stayAwake: true, bitrate: '8 Mbps', maxSize: '0' }),
    'adb-workbench.task-center.draft.v1': JSON.stringify({ version: 1, draft: script(), savedFingerprint: '{}', workspaceView: 'editor', editorMode: 'simple', selectedDeviceIds: ['old-device'] })
  };
  const next = normalizePreferences(preferences);
  assert.deepEqual(JSON.parse(next['adb-workbench.favorite-packages.v1']), ['android', 'com.example']);
  assert.deepEqual(JSON.parse(next['adb-workbench.task-center.draft.v1']).selectedDeviceIds, []);
  assert.throws(() => normalizePreferences({ globalCommandSettings: JSON.stringify({ enabled: true, shortcut: null, customCommands: [{ id: 'a', title: 'bad', action: 'shell:rm' }] }) }));
  assert.throws(() => normalizePreferences({ 'logFilterPresets.v1': '[{"id":"a","name":"bad","filter":{},"buffers":["unknown"]}]' }));
  const draft = JSON.parse(preferences['adb-workbench.task-center.draft.v1']);
  draft.draft.name = '';
  draft.draft.steps[0].points = '[{"x":';
  assert.equal(JSON.parse(normalizePreferences({ 'adb-workbench.task-center.draft.v1': JSON.stringify(draft) })['adb-workbench.task-center.draft.v1']).draft.steps[0].points, '[{"x":');
});
