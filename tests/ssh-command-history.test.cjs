const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCipheriv, createDecipheriv, randomBytes, randomUUID } = require('node:crypto');
const { createSshCommandHistory } = require('../electron/lib/ssh-command-history.cjs');

const identity = { host: 'host-one.example', port: 22, username: 'tester' };
const FILE_NAME = 'ssh-command-history.v1.json';

function fixture(t, { available = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-history-test-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('ssh-history-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const key = randomBytes(32); let time = 1000; let capable = available;
  const options = { directory, now: () => time++, canEncrypt: () => capable,
    encrypt(value) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, encryptBody(cipher, value)]); },
    decrypt(bytes) { const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'); } };
  function encryptBody(cipher, value) { const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([cipher.getAuthTag(), encrypted]); }
  const file = path.join(directory, FILE_NAME);
  const writePayload = payload => fs.writeFileSync(file, JSON.stringify({ version: 1, encrypted: options.encrypt(JSON.stringify(payload)).toString('base64') }));
  const readPayload = () => JSON.parse(options.decrypt(Buffer.from(JSON.parse(fs.readFileSync(file, 'utf8')).encrypted, 'base64')));
  return { directory, file, options, store: createSshCommandHistory(options), writePayload, readPayload, capability: value => { capable = value; } };
}

test('history is encrypted including host metadata, isolated by host/port/user and deduplicated', t => {
  const f = fixture(t); const first = f.store.record(identity, 'echo unique-command-one');
  assert.equal(first.recorded, true); assert.equal(first.persistent, true);
  f.store.record(identity, 'ls -la'); f.store.record({ ...identity, host: 'HOST-ONE.EXAMPLE' }, 'echo unique-command-one');
  for (const other of [{ ...identity, host: 'other-host' }, { ...identity, port: 2200 }, { ...identity, username: 'other-user' }]) assert.deepEqual(f.store.list(other).entries, []);
  const result = f.store.list(identity); assert.equal(result.paused, false); assert.equal(result.persistent, true); assert.equal(result.warning, '');
  assert.deepEqual(result.entries.map(entry => [entry.command, entry.count]), [['echo unique-command-one', 2], ['ls -la', 1]]);
  assert.equal(result.entries[0].id, first.id); assert.ok(result.entries[0].lastUsed > result.entries[1].lastUsed);
  const raw = fs.readFileSync(f.file, 'utf8');
  for (const secret of ['unique-command-one', identity.host, identity.username, 'paused', 'lastUsed', 'ls -la']) assert.equal(raw.includes(secret), false);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['encrypted', 'version']);
  const reloaded = createSshCommandHistory(f.options); assert.deepEqual(reloaded.list(identity), result);
  result.entries[0].command = 'mutated'; assert.equal(reloaded.list(identity).entries[0].command, 'echo unique-command-one');
});

test('pause/remove/clear persist encrypted metadata without resuming paused recording', t => {
  const f = fixture(t); f.store.record(identity, 'pwd'); const other = { ...identity, host: 'other' }; f.store.record(other, 'whoami');
  const id = f.store.list(identity).entries[0].id;
  assert.equal(f.store.setPaused(identity, true).paused, true);
  assert.equal(f.store.record(identity, 'echo should-not-record').reason, 'paused');
  const reload = createSshCommandHistory(f.options); assert.equal(reload.list(identity).paused, true);
  assert.equal(reload.remove(other, id).entries.length, 1); assert.equal(reload.list(identity).entries.length, 1);
  assert.equal(reload.remove(identity, id).entries.length, 0); assert.equal(reload.list(identity).paused, true);
  reload.clear(identity); assert.equal(reload.list(identity).paused, true);
  reload.setPaused(identity, false); assert.equal(reload.record(identity, 'pwd').recorded, true);
  assert.equal(reload.clear(identity).entries.length, 0); assert.equal(reload.list(other).entries[0].command, 'whoami');
});

test('privacy filtering rejects leading space, multiline, controls, invalid Unicode and obvious secrets', t => {
  const f = fixture(t);
  const rejected = ['', ' ', ' echo hidden', '\techo hidden', 'line1\nline2', 'echo\r', 'abc\0def', 'abc\x1b[31m', 'abc\x7f', '\ud800', 'x'.repeat(4097),
    'PASSWORD=secret command', 'export AWS_SECRET_ACCESS_KEY=private', 'GITHUB_TOKEN=secret command', 'PGPASSWORD=secret psql',
    'curl --token=private', 'tool --password private', 'tool --client-secret=private', 'sshpass -p private ssh host',
    'curl -H "Authorization: Bearer private" https://host', 'curl -u user:private https://host', 'curl https://user:private@example.test',
    'mysql -pPrivateValue', 'curl -d \'{"password":"private"}\' https://host'];
  for (const command of rejected) assert.equal(f.store.record(identity, command).recorded, false, JSON.stringify(command));
  assert.deepEqual(f.store.list(identity).entries, []); assert.equal(fs.existsSync(f.file), false);
  for (const command of ['ls -la', 'git status --short', 'echo 中文', 'echo "password policy"', 'printf "hello"  ']) assert.equal(f.store.record(identity, command).recorded, true, command);
  assert.equal(f.store.list(identity).entries[0].command, 'printf "hello"  ');
});

test('command UTF8 byte limit is inclusive and per-host history evicts oldest beyond 500', t => {
  const f = fixture(t, { available: false });
  assert.equal(f.store.record(identity, 'a'.repeat(4096)).recorded, true);
  assert.equal(f.store.record(identity, '中'.repeat(1366)).recorded, false);
  f.store.clear(identity);
  for (let i = 0; i < 501; i++) f.store.record(identity, `echo item-${i}`);
  const entries = f.store.list(identity).entries; assert.equal(entries.length, 500); assert.equal(entries[0].command, 'echo item-500'); assert.equal(entries.at(-1).command, 'echo item-1');
});

test('64-host limit retains paused privacy choices and evicts least-recent unpaused host', t => {
  const f = fixture(t, { available: false }); f.store.record(identity, 'keep'); f.store.setPaused(identity, true);
  for (let i = 0; i < 64; i++) f.store.record({ ...identity, host: `host-${i}` }, `echo host-${i}`);
  assert.equal(f.store.list(identity).paused, true); assert.equal(f.store.list(identity).entries[0].command, 'keep');
  assert.deepEqual(f.store.list({ ...identity, host: 'host-0' }).entries, []);
  for (let i = 1; i < 64; i++) f.store.setPaused({ ...identity, host: `host-${i}` }, true);
  const blocked = f.store.record({ ...identity, host: 'new-host' }, 'pwd'); assert.equal(blocked.recorded, false); assert.equal(blocked.reason, 'host-limit');
  assert.throws(() => f.store.setPaused({ ...identity, host: 'new-host' }, true), /上限|64/);
});

test('aggregate plaintext stays below 2 MiB by dropping oldest entries, not paused metadata', t => {
  const f = fixture(t); const hosts = [];
  for (let hostIndex = 0; hostIndex < 2; hostIndex++) {
    const entries = Array.from({ length: 245 }, (_, i) => ({ id: randomUUID(), command: `echo ${hostIndex}-${i} ` + 'x'.repeat(4050), lastUsed: 1000 - i, count: 1 }));
    hosts.push({ identity: { ...identity, host: `sized-${hostIndex}` }, paused: hostIndex === 0, updatedAt: 1000, entries });
  }
  f.writePayload({ version: 1, hosts });
  for (let i = 0; i < 30; i++) f.store.record({ ...identity, host: 'sized-1' }, `echo added-${i} ` + 'y'.repeat(4050));
  const payload = f.readPayload(); assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 2 * 1024 * 1024);
  assert.equal(f.store.list({ ...identity, host: 'sized-0' }).paused, true);
  assert.ok(payload.hosts.reduce((sum, host) => sum + host.entries.length, 0) < 520);
});

test('unavailable encryption uses only session memory and never writes a plaintext fallback', t => {
  const f = fixture(t, { available: false });
  const result = f.store.record(identity, 'echo memory-only'); assert.equal(result.recorded, true); assert.equal(result.persistent, false); assert.match(result.warning, /内存|本次会话/);
  assert.equal(f.store.list(identity).entries[0].command, 'echo memory-only'); assert.equal(fs.existsSync(f.file), false);
  f.store.setPaused(identity, true); assert.equal(fs.existsSync(f.file), false);
  assert.deepEqual(createSshCommandHistory(f.options).list(identity).entries, []);
});

test('unreadable encrypted pause settings default to paused in memory until explicit resume', t => {
  const f = fixture(t); f.store.record(identity, 'saved'); f.store.setPaused(identity, true); const original = fs.readFileSync(f.file);
  f.capability(false); const memory = createSshCommandHistory(f.options);
  assert.equal(memory.list(identity).paused, true); assert.equal(memory.list(identity).persistent, false);
  assert.equal(memory.record(identity, 'hidden').recorded, false);
  memory.setPaused(identity, false); assert.equal(memory.record(identity, 'memory').recorded, true);
  assert.deepEqual(fs.readFileSync(f.file), original); f.capability(true);
  memory.record(identity, 'still memory'); assert.deepEqual(fs.readFileSync(f.file), original);
  assert.equal(memory.list(identity).persistent, false);
});

test('corrupt envelope and invalid decrypted schema fail closed without overwriting files', t => {
  const f = fixture(t);
  const invalid = ['{broken', JSON.stringify({ version: 1, encrypted: 'not base64' }), JSON.stringify({ version: 1, encrypted: Buffer.from('not decryptable').toString('base64') }),
    JSON.stringify({ version: 1, plaintext: 'private command' }), JSON.stringify({ version: 9, encrypted: 'YQ==' })];
  for (const raw of invalid) {
    fs.writeFileSync(f.file, raw); const store = createSshCommandHistory(f.options);
    for (const run of [() => store.list(identity), () => store.record(identity, 'pwd'), () => store.clear(identity), () => store.setPaused(identity, false)]) assert.throws(run, /历史.*读取|保留原文件/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), raw);
  }
  f.writePayload({ version: 1, hosts: [{ identity, paused: false, updatedAt: 1, entries: [{ id: randomUUID(), command: 'pwd', lastUsed: 1, count: -1 }] }] });
  const raw = fs.readFileSync(f.file); assert.throws(() => createSshCommandHistory(f.options).list(identity), /历史.*读取|保留原文件/); assert.deepEqual(fs.readFileSync(f.file), raw);
});

test('failed atomic replacement preserves disk and memory history and removes owned temporary', t => {
  const f = fixture(t); f.store.record(identity, 'original'); const before = fs.readFileSync(f.file); const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, target) => { if (target === f.file) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return rename(source, target); });
  assert.throws(() => f.store.record(identity, 'not committed'), /保存|写入/);
  assert.deepEqual(fs.readFileSync(f.file), before); assert.deepEqual(f.store.list(identity).entries.map(entry => entry.command), ['original']);
  assert.deepEqual(fs.readdirSync(f.directory), [FILE_NAME]);
});

test('external corruption after loading is detected before any subsequent replacement', t => {
  const f = fixture(t); f.store.record(identity, 'original'); fs.writeFileSync(f.file, '{changed externally');
  assert.throws(() => f.store.record(identity, 'not committed'), /变化|历史.*读取|保留原文件/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{changed externally'); assert.deepEqual(f.store.list(identity).entries.map(entry => entry.command), ['original']);
});

test('encryption capability loss does not overwrite existing ciphertext or claim persistence', t => {
  const f = fixture(t); f.store.record(identity, 'saved'); const before = fs.readFileSync(f.file);
  f.capability(false); const result = f.store.record(identity, 'ephemeral');
  assert.equal(result.persistent, false); assert.equal(result.recorded, true); assert.deepEqual(fs.readFileSync(f.file), before);
  f.capability(true); assert.equal(f.store.record(identity, 'still ephemeral').persistent, false); assert.deepEqual(fs.readFileSync(f.file), before);
});

test('invalid identity, pause flag and injected clock fail before creating storage', t => {
  const f = fixture(t);
  for (const value of [null, {}, { ...identity, host: 'ssh://host' }, { ...identity, port: 0 }, { ...identity, port: '22' }, { ...identity, username: 'user\n' }]) assert.throws(() => f.store.record(value, 'pwd'), /身份|主机|用户|端口/);
  assert.throws(() => f.store.setPaused(identity, 'yes'), /暂停/);
  assert.throws(() => createSshCommandHistory({ ...f.options, now: () => NaN }).record(identity, 'pwd'), /时间/);
  assert.equal(fs.existsSync(f.file), false);
});

test('history file must be ordinary, bounded and unshared before decryption', t => {
  const f = fixture(t); const linked = path.join(f.directory, 'linked-copy'); f.store.record(identity, 'original');
  fs.linkSync(f.file, linked);
  assert.throws(() => createSshCommandHistory(f.options).list(identity), /保留原文件/);
  fs.unlinkSync(linked);
  fs.writeFileSync(f.file, Buffer.alloc(3 * 1024 * 1024 + 1, 32));
  let decryptions = 0;
  assert.throws(() => createSshCommandHistory({ ...f.options, decrypt: bytes => { decryptions++; return f.options.decrypt(bytes); } }).list(identity), /保留原文件/);
  assert.equal(decryptions, 0);
  fs.unlinkSync(f.file); fs.mkdirSync(f.file);
  assert.throws(() => createSshCommandHistory(f.options).list(identity), /保留原文件/);
});

test('decrypted payload limits reject oversized data, duplicate identities and invalid counts', t => {
  const f = fixture(t);
  const huge = JSON.stringify({ version: 1, hosts: [] }) + ' '.repeat(2 * 1024 * 1024);
  fs.writeFileSync(f.file, JSON.stringify({ version: 1, encrypted: f.options.encrypt(huge).toString('base64') }));
  assert.throws(() => createSshCommandHistory(f.options).list(identity), /保留原文件/);
  const host = { identity, paused: false, updatedAt: 1000, entries: [] };
  for (const hosts of [[host, structuredClone(host)], Array.from({ length: 65 }, (_, i) => ({ ...host, identity: { ...identity, host: `host-${i}` } })),
    [{ ...host, entries: Array.from({ length: 501 }, (_, i) => ({ id: randomUUID(), command: `echo ${i}`, lastUsed: 1000, count: 1 })) }],
    [{ ...host, entries: [{ id: randomUUID(), command: 'echo first', lastUsed: 1000, count: Number.MAX_SAFE_INTEGER + 1 }] }]]) {
    f.writePayload({ version: 1, hosts }); const original = fs.readFileSync(f.file);
    assert.throws(() => createSshCommandHistory(f.options).record(identity, 'pwd'), /保留原文件/); assert.deepEqual(fs.readFileSync(f.file), original);
  }
});

test('duplicate count saturates safely and clock rollback does not reorder recency incorrectly', t => {
  const f = fixture(t); const entryId = randomUUID();
  f.writePayload({ version: 1, hosts: [{ identity, paused: false, updatedAt: 5000, entries: [{ id: entryId, command: 'pwd', lastUsed: 5000, count: Number.MAX_SAFE_INTEGER }] }] });
  f.store.record(identity, 'pwd'); f.store.record(identity, 'ls');
  const result = f.store.list(identity); assert.deepEqual(result.entries.map(entry => entry.command), ['ls', 'pwd']);
  assert.equal(result.entries[1].count, Number.MAX_SAFE_INTEGER); assert.equal(result.entries[1].id, entryId); assert.equal(result.entries[0].lastUsed, 5000);
  const original = fs.readFileSync(f.file); f.store.remove(identity, randomUUID()); assert.deepEqual(fs.readFileSync(f.file), original);
});

test('encryption failure falls back to memory explicitly without replacing prior ciphertext', t => {
  const f = fixture(t); f.store.record(identity, 'persisted'); const original = fs.readFileSync(f.file);
  const store = createSshCommandHistory({ ...f.options, encrypt: () => { throw new Error('private backend detail'); } });
  const result = store.record(identity, 'not persisted'); assert.equal(result.recorded, true); assert.equal(result.persistent, false); assert.match(result.warning, /内存/);
  assert.equal(result.warning.includes('private backend'), false); assert.deepEqual(fs.readFileSync(f.file), original);
  assert.deepEqual(store.list(identity).entries.map(entry => entry.command), ['not persisted', 'persisted']);
  assert.deepEqual(createSshCommandHistory(f.options).list(identity).entries.map(entry => entry.command), ['persisted']);
});

test('deleting the disk history while running never causes an implicit recreation', t => {
  const f = fixture(t); f.store.record(identity, 'original'); fs.unlinkSync(f.file);
  assert.throws(() => f.store.record(identity, 'new'), { code: 'SSH_HISTORY_CHANGED' });
  assert.equal(fs.existsSync(f.file), false); assert.deepEqual(f.store.list(identity).entries.map(entry => entry.command), ['original']);
});
