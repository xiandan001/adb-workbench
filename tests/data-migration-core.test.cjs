const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { gzipSync, gunzipSync } = require('zlib');
const { createHash } = require('crypto');
const core = require('../electron/lib/data-migration-core.cjs');
const { encodeArchive, MAX_COMPRESSED_BYTES, MAX_FILE_BYTES } = require('../electron/lib/data-migration-archive.cjs');

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_NAME = `log-analysis-sessions/${SESSION_ID}.json`;
const HASH = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function temp(t, name = 'migration') {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `adb-${name}-`));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function put(root, name, data) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), typeof data === 'string' ? data : JSON.stringify(data));
}
function get(root, name) { return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')); }
function session() {
  return { schemaVersion: 1, id: SESSION_ID, savedAt: '2026-10-21T10:00:00.000Z', name: '设备迁移日志',
    source: 'file', sourceLabel: 'device.log', deviceId: 'TEST-DEVICE', filter: { minLevel: 'E' }, buffers: ['main'],
    entries: [{ id: 'log1', raw: '原始错误日志', source: 'file' }], evidence: [], aiTurns: [], markers: [] };
}
function payload(files = [], preferences = { currentTheme: 'tech' }) {
  return { schemaVersion: 1, appVersion: '4.3.2', createdAt: '2026-10-21T10:00:00.000Z', files, preferences };
}

test('archive round-trip includes only portable files/preferences, preserving raw session evidence', async t => {
  const root = temp(t);
  put(root, 'settings.json', { screenshotPath: 'D:\\private', pushRemotePathHistory: ['/sdcard/'], taskCenterOnboarding: null });
  put(root, 'terminal_command_history.json', ['getprop ro.build.version.release']);
  put(root, SESSION_NAME, session());
  put(root, 'log-analysis-sessions/.metadata/ignored.json', { invalid: true });
  put(root, 'credentials.json', { token: 'DO-NOT-EXPORT' });
  put(root, 'Local Storage/leveldb/private.json', { token: 'DO-NOT-EXPORT' });
  const archive = await core.createArchive(root, { currentTheme: 'tech', autoUpdateEnabled: 'true' }, '4.3.2');
  const restored = core.readArchive(archive);
  assert.equal(restored.summary.fileCount, 3);
  assert.equal(restored.summary.sessionCount, 1);
  assert.equal(restored.summary.preferenceCount, 2);
  assert.equal(restored.summary.bytes, restored.summary.totalBytes);
  assert.equal(restored.payload.files.find(file => file.name === SESSION_NAME).data.entries[0].raw, '原始错误日志');
  assert.deepEqual(restored.payload.files.find(file => file.name === 'settings.json').data,
    { pushRemotePathHistory: ['/sdcard/'], taskCenterOnboarding: null });
  assert.equal(gunzipSync(archive).toString().includes('DO-NOT-EXPORT'), false);
});

test('corrupt, unsupported, duplicate, traversal and oversized archive data are rejected', () => {
  assert.throws(() => core.readArchive(Buffer.from('broken')), /损坏/);
  const envelope = JSON.parse(gunzipSync(encodeArchive(payload())).toString());
  envelope.payload.appVersion = '0.0.0';
  assert.throws(() => core.readArchive(gzipSync(JSON.stringify(envelope))), /校验失败/);
  envelope.sha256 = HASH(envelope.payload);
  envelope.payload.schemaVersion = 999;
  envelope.sha256 = HASH(envelope.payload);
  assert.throws(() => core.readArchive(gzipSync(JSON.stringify(envelope))), /版本/);
  for (const name of ['../settings.json', 'settings.json/other.json', 'credentials.json', 'log-analysis-sessions/.metadata/a.json']) {
    assert.throws(() => encodeArchive(payload([{ name, data: {} }])), /不支持/);
  }
  assert.throws(() => encodeArchive(payload([{ name: 'settings.json', data: {} }, { name: 'settings.json', data: {} }])), /重复/);
  assert.throws(() => core.readArchive(Buffer.allocUnsafe(MAX_COMPRESSED_BYTES + 1)), /128 MB/);
  assert.throws(() => encodeArchive(payload([{ name: 'terminal_command_history.json', data: ['x'.repeat(MAX_FILE_BYTES)] }])), /64 MB/);
  assert.throws(() => encodeArchive(payload(Array.from({ length: 2001 }, () => ({ name: 'settings.json', data: {} })))), /结构/);
});

test('staging changes no live data and acknowledged startup import preserves local paths and unrelated files', async t => {
  const root = temp(t);
  const originalSettings = '{ "screenshotPath": "D:/local/screens", "pushRemotePathHistory": ["/old"], "unknownLocal": 42 }\n';
  put(root, 'settings.json', originalSettings);
  put(root, 'credentials.json', '{ "token": "KEEP-SECRET" }\n');
  put(root, 'terminal_command_history.json', ['old']);
  put(root, 'unrelated.txt', 'keep exact');
  const input = payload([{ name: 'settings.json', data: { screenshotPath: 'C:/foreign', pushRemotePathHistory: ['/new'] } },
    { name: 'terminal_command_history.json', data: ['new'] }, { name: SESSION_NAME, data: session() }]);
  const staged = await core.stageImport(root, input, { currentTheme: 'light', autoUpdateEnabled: ' false ' });
  assert.equal(core.hasPendingImport(root), true);
  assert.equal(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'), originalSettings);
  const result = await core.applyPendingImport(root);
  assert.equal(result.id, staged.id);
  assert.equal(result.status, 'applied');
  assert.equal(result.requiresAck, true);
  assert.deepEqual(result.previousPreferences, { currentTheme: 'light', autoUpdateEnabled: ' false ' });
  assert.deepEqual(get(root, 'settings.json'), { screenshotPath: 'D:/local/screens', pushRemotePathHistory: ['/new'], unknownLocal: 42 });
  assert.deepEqual(get(root, 'terminal_command_history.json'), ['new']);
  assert.equal(get(root, SESSION_NAME).entries[0].raw, '原始错误日志');
  assert.equal(fs.readFileSync(path.join(root, 'credentials.json'), 'utf8'), '{ "token": "KEEP-SECRET" }\n');
  assert.equal(fs.readFileSync(path.join(root, 'unrelated.txt'), 'utf8'), 'keep exact');
  assert.equal(fs.readFileSync(path.join(result.recoveryPath, '0000.bin'), 'utf8'), originalSettings);
  await assert.rejects(core.finalizeStartupImport(root, 'not-the-staged-id'), /失效/);
  await core.finalizeStartupImport(root, result.id);
  assert.equal(core.hasPendingImport(root), false);
  assert.equal(await core.applyPendingImport(root), null);
  assert.equal(fs.existsSync(path.join(result.recoveryPath, 'recovery.json')), true);
});

test('unacknowledged interrupted startup restores exact original bytes and retains renderer rollback until acknowledged', async t => {
  const root = temp(t);
  const original = '[ "original", "with whitespace" ]\n';
  put(root, 'terminal_command_history.json', original);
  const staged = await core.stageImport(root, payload([
    { name: 'terminal_command_history.json', data: ['imported'] }, { name: SESSION_NAME, data: session() }
  ], { currentTheme: 'tech', autoUpdateEnabled: 'true' }), { currentTheme: 'light' });
  await core.applyPendingImport(root);
  const recovered = await core.applyPendingImport(root);
  assert.equal(recovered.status, 'rolled-back');
  assert.deepEqual(recovered.preferences, { currentTheme: 'light' });
  assert.deepEqual(recovered.removePreferenceKeys, ['autoUpdateEnabled']);
  assert.equal(fs.readFileSync(path.join(root, 'terminal_command_history.json'), 'utf8'), original);
  assert.equal(fs.existsSync(path.join(root, SESSION_NAME)), false);
  assert.equal(core.hasPendingImport(root), true);
  assert.deepEqual(await core.applyPendingImport(root), recovered);
  await core.finalizeStartupImport(root, staged.id);
  assert.equal(core.hasPendingImport(root), false);
});

test('renderer-triggered rollback restores files and exact original preference strings', async t => {
  const root = temp(t);
  put(root, 'terminal_command_history.json', ['original']);
  await core.stageImport(root, payload([{ name: 'terminal_command_history.json', data: ['imported'] }]), { autoUpdateEnabled: ' true ' });
  const applied = await core.applyPendingImport(root);
  await assert.rejects(core.rollbackStartupImport(root, 'wrong-id'), /失效/);
  const rolledBack = await core.rollbackStartupImport(root, applied.id);
  assert.deepEqual(rolledBack.preferences, { autoUpdateEnabled: ' true ' });
  assert.deepEqual(rolledBack.removePreferenceKeys, ['currentTheme']);
  assert.deepEqual(get(root, 'terminal_command_history.json'), ['original']);
  await core.finalizeStartupImport(root, applied.id);
});

test('journals support valid preference maps above 1 MB and restore original draft selection bytes', async t => {
  const root = temp(t);
  const deviceNames = Object.fromEntries(Array.from({ length: 5000 }, (_, index) => [`device-${index}`, 'n'.repeat(240)]));
  const oldDraft = JSON.stringify({ version: 1, draft: { id: 'draft-1', name: '草稿', steps: [] },
    savedFingerprint: 'exact fingerprint', workspaceView: 'editor', editorMode: 'simple', selectedDeviceIds: ['original-device'] }, null, 2);
  const oldPreferences = { deviceNames: JSON.stringify(deviceNames), 'adb-workbench.task-center.draft.v1': oldDraft };
  assert.ok(Buffer.byteLength(JSON.stringify(oldPreferences)) > 1024 * 1024);
  await core.stageImport(root, payload([], { deviceNames: JSON.stringify(deviceNames), currentTheme: 'tech' }), oldPreferences);
  const applied = await core.applyPendingImport(root);
  assert.equal(applied.status, 'applied');
  const rolledBack = await core.applyPendingImport(root);
  assert.deepEqual(rolledBack.preferences, oldPreferences);
  assert.equal(JSON.parse(rolledBack.preferences['adb-workbench.task-center.draft.v1']).selectedDeviceIds[0], 'original-device');
  await core.finalizeStartupImport(root, applied.id);
});

test('injected apply write failure rolls back all touched files and leaves unrelated data intact', async t => {
  const root = temp(t);
  const original = '[ "original" ]\n';
  put(root, 'terminal_command_history.json', original);
  put(root, 'credentials.json', { token: 'KEEP' });
  await core.stageImport(root, payload([{ name: 'terminal_command_history.json', data: ['imported'] },
    { name: SESSION_NAME, data: session() }]), { currentTheme: 'light' });
  const originalRename = fs.promises.rename;
  let failed = false;
  t.mock.method(fs.promises, 'rename', async function (source, target) {
    if (!failed && target === path.join(root, SESSION_NAME)) { failed = true; throw new Error('injected disk failure'); }
    return originalRename.call(this, source, target);
  });
  const result = await core.applyPendingImport(root);
  assert.equal(result.status, 'rolled-back');
  assert.match(result.error, /injected/);
  assert.equal(fs.readFileSync(path.join(root, 'terminal_command_history.json'), 'utf8'), original);
  assert.equal(fs.existsSync(path.join(root, SESSION_NAME)), false);
  assert.deepEqual(get(root, 'credentials.json'), { token: 'KEEP' });
  await core.finalizeStartupImport(root, result.id);
});

test('symlinked session directory or target is rejected without modifying external data', async t => {
  const root = temp(t);
  const outside = temp(t, 'outside');
  put(outside, `${SESSION_ID}.json`, session());
  fs.symlinkSync(outside, path.join(root, 'log-analysis-sessions'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(core.createArchive(root, {}, '4.3.2'), /链接/);
  await core.stageImport(root, payload([{ name: SESSION_NAME, data: session() }]), {});
  const result = await core.applyPendingImport(root);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /链接/);
  assert.equal(get(outside, `${SESSION_ID}.json`).name, '设备迁移日志');
  await core.finalizeStartupImport(root, result.id);
});

test('invalid pending data never changes files; malformed backup blocks rollback instead of partially restoring', async t => {
  const root = temp(t);
  put(root, 'terminal_command_history.json', ['original']);
  put(root, 'data-migration-pending.gz', 'corrupt');
  const rejected = await core.applyPendingImport(root);
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.requiresAck, false);
  assert.deepEqual(get(root, 'terminal_command_history.json'), ['original']);
  await core.stageImport(root, payload([{ name: 'terminal_command_history.json', data: ['imported'] }]), {});
  const applied = await core.applyPendingImport(root);
  put(applied.recoveryPath, '0000.bin', 'modified backup');
  await assert.rejects(core.rollbackStartupImport(root, applied.id), /校验失败/);
  assert.deepEqual(get(root, 'terminal_command_history.json'), ['imported']);
  assert.equal(core.hasPendingImport(root), true);
});
