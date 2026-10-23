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

test('pre-v2 serial backup checksum remains valid and rollback preserves exact v1 preference bytes', async t => {
  const key = 'adb-workbench.serial-preferences.v1';
  const config = { baudRate: 57600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' };
  const old = { version: 1, config, receiveMode: 'ascii', sendMode: 'hex', lineEnding: 'crlf',
    favorites: [{ id: 'status', name: '状态', mode: 'ascii', content: 'AT', lineEnding: 'crlf' }] };
  const originalRaw = JSON.stringify(old, null, 2) + '\n';
  const legacyPayload = payload([], { [key]: originalRaw });
  // Build the exact old envelope rather than re-encoding it through the new
  // normalizer: its checksum must be checked before v1 is upgraded in memory.
  const archive = gzipSync(JSON.stringify({ format: 'adb-workbench-backup', payload: legacyPayload, sha256: HASH(legacyPayload) }));
  const decoded = core.readArchive(archive).payload;
  assert.deepEqual(JSON.parse(decoded.preferences[key]), { ...old, version: 2, terminalConfig: { ...config } });
  const root = temp(t, 'serial-v1-migration');
  const staged = await core.stageImport(root, decoded, { [key]: originalRaw });
  const applied = await core.applyPendingImport(root);
  assert.equal(applied.id, staged.id);
  assert.equal(applied.previousPreferences[key], originalRaw);
  assert.equal(JSON.parse(applied.preferences[key]).terminalConfig.baudRate, 57600);
  const rolledBack = await core.rollbackStartupImport(root, staged.id);
  assert.equal(rolledBack.preferences[key], originalRaw);
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

const AI_PROVIDER = 'ai-tools/ai-tools-store.v1.json';
const AI_RESOURCE = 'ai-tools/ai-tools-resources.v1.json';
const AI_SKILL = `ai-tools/skills/archives/${SESSION_ID}.json`;
const AI_SESSION = `ai-tools/session-archives/${'a'.repeat(64)}.json`;
const byteHash = bytes => createHash('sha256').update(bytes).digest('hex');
const encryptedFixture = label => Buffer.from(`${JSON.stringify({ version: 1, encrypted: Buffer.from(`opaque-fixture-${label}`).toString('base64') })}\n`);
function putBytes(root, name, bytes) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), bytes); }

test('AI import stages only ciphertext and startup journal atomically includes legacy and fixed AI targets', async t => {
  const root = temp(t); const old = encryptedFixture('old'); const next = encryptedFixture('new'); const skill = encryptedFixture('skill');
  putBytes(root, AI_PROVIDER, old); put(root, 'terminal_command_history.json', '[ "original" ]\n');
  const writes = [{ name: AI_PROVIDER, bytes: next, expectedHash: byteHash(old) }, { name: AI_SKILL, bytes: skill, expectedHash: null }, { name: AI_SESSION, bytes: encryptedFixture('session'), expectedHash: null }];
  const staged = await core.stageImport(root, payload([{ name: 'terminal_command_history.json', data: ['imported'] }]), {}, { aiWrites: writes, aiGuards: [{ name: AI_PROVIDER, expectedHash: byteHash(old) }] });
  assert.deepEqual(fs.readFileSync(path.join(root, AI_PROVIDER)), old);
  const raw = gunzipSync(fs.readFileSync(path.join(root, 'data-migration-pending.gz'))).toString(); const pending = JSON.parse(raw).pending;
  assert.equal(pending.schemaVersion, 2); assert.equal(raw.includes('opaque-fixture'), false); assert.equal(raw.includes(next.toString()), false);
  assert.deepEqual(Buffer.from(pending.aiWrites[0].data, 'base64'), next);
  const applied = await core.applyPendingImport(root); assert.equal(applied.status, 'applied');
  assert.deepEqual(fs.readFileSync(path.join(root, AI_PROVIDER)), next); assert.deepEqual(fs.readFileSync(path.join(root, AI_SKILL)), skill);
  const journal = get(root, 'data-migration-journal.json'); assert.equal(journal.schemaVersion, 2); assert.equal(journal.entries.length, 4);
  assert.equal(journal.entries.find(entry => entry.name === AI_PROVIDER).beforeHash, byteHash(old)); assert.equal(journal.entries.find(entry => entry.name === AI_PROVIDER).afterHash, byteHash(next));
  const recovered = await core.applyPendingImport(root); assert.equal(recovered.status, 'rolled-back');
  assert.deepEqual(fs.readFileSync(path.join(root, AI_PROVIDER)), old); assert.equal(fs.existsSync(path.join(root, AI_SKILL)), false); assert.equal(fs.existsSync(path.join(root, AI_SESSION)), false);
  assert.equal(fs.readFileSync(path.join(root, 'terminal_command_history.json'), 'utf8'), '[ "original" ]\n');
  await core.finalizeStartupImport(root, staged.id);
});

test('AI write plan refuses unapproved paths, plaintext, malformed ciphertext, duplicate files and wrong expected hashes', async t => {
  const root = temp(t); const bytes = encryptedFixture('new'); putBytes(root, AI_PROVIDER, encryptedFixture('old'));
  const invalid = [
    [{ name: '../ai-tools/ai-tools-store.v1.json', bytes, expectedHash: null }], [{ name: 'ai-tools/credentials.json', bytes, expectedHash: null }],
    [{ name: 'ai-tools/skills/archives/not-a-uuid.json', bytes, expectedHash: null }], [{ name: 'ai-tools/session-archives/not-a-hash.json', bytes, expectedHash: null }],
    [{ name: AI_PROVIDER, bytes: Buffer.from('{"apiKey":"PRIVATE-DO-NOT-STAGE"}'), expectedHash: null }],
    [{ name: AI_PROVIDER, bytes: Buffer.from('{"version":1,"encrypted":"!!!!"}'), expectedHash: null }],
    [{ name: AI_PROVIDER, bytes, expectedHash: null }], [{ name: AI_RESOURCE, bytes, expectedHash: undefined }],
    [{ name: AI_RESOURCE, bytes, expectedHash: null }, { name: AI_RESOURCE, bytes, expectedHash: null }],
  ];
  for (const aiWrites of invalid) { await assert.rejects(core.stageImport(root, payload(), {}, { aiWrites })); assert.equal(core.hasPendingImport(root), false); }
  await assert.rejects(core.stageImport(root, payload([{ name: AI_PROVIDER, data: { encrypted: 'no' } }]), {}), /不支持/);
});

test('AI read-only guards and write hashes are checked again on restart before any live mutation', async t => {
  for (const changedName of [AI_PROVIDER, AI_SKILL]) {
    const root = temp(t); const old = encryptedFixture('old'); const replacement = encryptedFixture('external');
    putBytes(root, AI_PROVIDER, old); putBytes(root, AI_SKILL, old); put(root, 'terminal_command_history.json', ['old']);
    await core.stageImport(root, payload([{ name: 'terminal_command_history.json', data: ['new'] }]), {}, { aiWrites: [{ name: AI_PROVIDER, bytes: encryptedFixture('new'), expectedHash: byteHash(old) }], aiGuards: [{ name: AI_SKILL, expectedHash: byteHash(old) }] });
    putBytes(root, changedName, replacement); const rejected = await core.applyPendingImport(root);
    assert.equal(rejected.status, 'failed'); assert.match(rejected.error, /变化|冲突/); assert.deepEqual(get(root, 'terminal_command_history.json'), ['old']);
    assert.deepEqual(fs.readFileSync(path.join(root, changedName)), replacement);
  }
});

test('AI apply failure rolls back both domains and new journals never overwrite later external changes', async t => {
  const root = temp(t); const old = encryptedFixture('old'); putBytes(root, AI_PROVIDER, old); put(root, 'terminal_command_history.json', ['old']);
  const writes = [{ name: AI_PROVIDER, bytes: encryptedFixture('new'), expectedHash: byteHash(old) }, { name: AI_RESOURCE, bytes: encryptedFixture('resource'), expectedHash: null }];
  await core.stageImport(root, payload([{ name: 'terminal_command_history.json', data: ['new'] }]), {}, { aiWrites: writes });
  const rename = fs.promises.rename; let failed = false;
  t.mock.method(fs.promises, 'rename', async (source, target) => { if (!failed && target === path.join(root, AI_RESOURCE)) { failed = true; throw new Error('injected AI write failure'); } return rename(source, target); });
  const result = await core.applyPendingImport(root); assert.equal(result.status, 'rolled-back'); assert.deepEqual(get(root, 'terminal_command_history.json'), ['old']); assert.deepEqual(fs.readFileSync(path.join(root, AI_PROVIDER)), old);
  await core.finalizeStartupImport(root, result.id);
  await core.stageImport(root, payload([{ name: 'terminal_command_history.json', data: ['new'] }]), {}, { aiWrites: writes }); const applied = await core.applyPendingImport(root);
  const external = encryptedFixture('external'); putBytes(root, AI_PROVIDER, external);
  await assert.rejects(core.rollbackStartupImport(root, applied.id), /变化|外部/);
  assert.deepEqual(fs.readFileSync(path.join(root, AI_PROVIDER)), external); assert.deepEqual(get(root, 'terminal_command_history.json'), ['new']);
  assert.equal(core.hasPendingImport(root), true);
});

test('legacy v1 pending and journals remain readable but cannot smuggle AI writes', async t => {
  const root = temp(t); put(root, 'terminal_command_history.json', ['old']);
  const pending = { schemaVersion: 1, id: SESSION_ID, payload: payload([{ name: 'terminal_command_history.json', data: ['new'] }]), previousPreferences: {} };
  putBytes(root, 'data-migration-pending.gz', gzipSync(JSON.stringify({ pending, sha256: HASH(pending) })));
  const applied = await core.applyPendingImport(root); assert.equal(applied.status, 'applied');
  const journal = get(root, 'data-migration-journal.json'); journal.schemaVersion = 1; delete journal.aiGuards;
  for (const entry of journal.entries) { delete entry.kind; delete entry.beforeHash; delete entry.afterHash; }
  put(root, 'data-migration-journal.json', journal); assert.equal((await core.applyPendingImport(root)).status, 'rolled-back'); await core.finalizeStartupImport(root, applied.id);
  pending.aiWrites = [{ name: AI_PROVIDER, data: encryptedFixture('forbidden').toString('base64'), expectedHash: null }];
  putBytes(root, 'data-migration-pending.gz', gzipSync(JSON.stringify({ pending, sha256: HASH(pending) })));
  const rejected = await core.applyPendingImport(root); assert.equal(rejected.status, 'failed'); assert.equal(fs.existsSync(path.join(root, AI_PROVIDER)), false);
});

test('a target changed while an apply temporary file is being written is never renamed over', async t => {
  const root = temp(t); const target = path.join(root, AI_PROVIDER); const original = encryptedFixture('old'); const external = encryptedFixture('external-during-temp');
  putBytes(root, AI_PROVIDER, original);
  await core.stageImport(root, payload(), {}, { aiWrites: [{ name: AI_PROVIDER, bytes: encryptedFixture('imported'), expectedHash: byteHash(original) }] });
  const open = fs.promises.open; let injected = false;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args);
    if (!injected && String(args[0]).startsWith(`${target}.`) && String(args[0]).endsWith('.tmp')) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async bytes => { await write(bytes); injected = true; fs.writeFileSync(target, external); };
    }
    return handle;
  });
  await assert.rejects(core.applyPendingImport(root), /变化|外部/);
  assert.equal(injected, true); assert.deepEqual(fs.readFileSync(target), external); assert.equal(core.hasPendingImport(root), true);
  assert.equal(get(root, 'data-migration-journal.json').phase, 'prepared');
});

test('rollback final rename also preserves an external change made during recovery temp write', async t => {
  const root = temp(t); const target = path.join(root, AI_PROVIDER); const original = encryptedFixture('old'); const external = encryptedFixture('external-during-rollback');
  putBytes(root, AI_PROVIDER, original);
  await core.stageImport(root, payload(), {}, { aiWrites: [{ name: AI_PROVIDER, bytes: encryptedFixture('imported'), expectedHash: byteHash(original) }] });
  const applied = await core.applyPendingImport(root); const open = fs.promises.open; let injected = false;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args);
    if (!injected && String(args[0]).startsWith(`${target}.`) && String(args[0]).endsWith('.tmp')) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async bytes => { await write(bytes); injected = true; fs.writeFileSync(target, external); };
    }
    return handle;
  });
  await assert.rejects(core.rollbackStartupImport(root, applied.id), /变化|外部/);
  assert.deepEqual(fs.readFileSync(target), external); assert.equal(get(root, 'data-migration-journal.json').phase, 'applied');
});

test('temporary-path collision never deletes a file not created by the migration operation', async t => {
  const root = temp(t); const open = fs.promises.open; let collision;
  t.mock.method(fs.promises, 'open', async (...args) => {
    if (!collision && args[1] === 'wx' && String(args[0]).includes('data-migration-pending.gz.')) {
      collision = String(args[0]); fs.writeFileSync(collision, 'unowned fixture'); throw Object.assign(new Error('temporary collision'), { code: 'EEXIST' });
    }
    return open(...args);
  });
  await assert.rejects(core.stageImport(root, payload(), {}), /collision/);
  assert.equal(fs.readFileSync(collision, 'utf8'), 'unowned fixture'); assert.equal(core.hasPendingImport(root), false);
});

test('read-only AI source changes during commit trigger rollback without rewriting the changed source', async t => {
  const root = temp(t); const old = encryptedFixture('old'); const external = encryptedFixture('external-source');
  putBytes(root, AI_PROVIDER, old); putBytes(root, AI_SKILL, old);
  await core.stageImport(root, payload(), {}, { aiWrites: [{ name: AI_PROVIDER, bytes: encryptedFixture('new'), expectedHash: byteHash(old) }], aiGuards: [{ name: AI_SKILL, expectedHash: byteHash(old) }] });
  const rename = fs.promises.rename; let changed = false;
  t.mock.method(fs.promises, 'rename', async (...args) => { const result = await rename(...args); if (!changed && args[1] === path.join(root, AI_PROVIDER)) { changed = true; putBytes(root, AI_SKILL, external); } return result; });
  const rolledBack = await core.applyPendingImport(root);
  assert.equal(rolledBack.status, 'rolled-back'); assert.match(rolledBack.error, /变化/);
  assert.deepEqual(fs.readFileSync(path.join(root, AI_PROVIDER)), old); assert.deepEqual(fs.readFileSync(path.join(root, AI_SKILL)), external);
});

test('corrupt pending ciphertext, unapproved guards and AI file limits fail without modifying live data', async t => {
  const root = temp(t); const bytes = encryptedFixture('next');
  await assert.rejects(core.stageImport(root, payload(), {}, { aiGuards: [{ name: 'ai-tools/oauth.json', expectedHash: null }] }));
  await assert.rejects(core.stageImport(root, payload(), {}, { aiWrites: [{ name: AI_PROVIDER, bytes: Buffer.alloc(8 * 1024 * 1024 + 1), expectedHash: null }] }));
  await assert.rejects(core.stageImport(root, payload(), {}, { aiWrites: Array.from({ length: 601 }, () => ({ name: AI_RESOURCE, bytes, expectedHash: null })) }));
  await core.stageImport(root, payload([{ name: 'terminal_command_history.json', data: ['new'] }]), {}, { aiWrites: [{ name: AI_PROVIDER, bytes, expectedHash: null }] });
  const envelope = JSON.parse(gunzipSync(fs.readFileSync(path.join(root, 'data-migration-pending.gz'))).toString());
  envelope.pending.aiWrites[0].data = Buffer.from('not ciphertext').toString('base64'); envelope.sha256 = HASH(envelope.pending);
  putBytes(root, 'data-migration-pending.gz', gzipSync(JSON.stringify(envelope)));
  assert.equal((await core.applyPendingImport(root)).status, 'failed'); assert.equal(fs.existsSync(path.join(root, AI_PROVIDER)), false); assert.equal(fs.existsSync(path.join(root, 'terminal_command_history.json')), false);
});
