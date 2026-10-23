const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const codec = require('../electron/lib/data-migration-v2.cjs');
const legacy = require('../electron/lib/data-migration-archive.cjs');

const PASSWORD = 'test-backup-password';
const payload = () => ({ schemaVersion: 1, appVersion: '4.6.1', createdAt: '2026-10-23T00:00:00.000Z', files: [{ name: 'terminal_command_history.json', data: ['fixture command'] }], preferences: { currentTheme: 'light' } });
const ai = () => ({ version: 2, providers: { version: 1, providers: [{ id: 'fixture', apiKey: 'PRIVATE-V2-FIXTURE-KEY' }] }, resources: { version: 1, mcpServers: [], prompts: [] }, sessions: [] });

test('v2 envelope round-trips legacy payload and AI JSON without plaintext credentials', async () => {
  const value = { payload: payload(), ai: ai() }; const encrypted = await codec.encode(value, PASSWORD);
  assert.equal(codec.isEncrypted(encrypted), true); assert.equal(encrypted.includes(Buffer.from('PRIVATE-V2-FIXTURE-KEY')), false);
  assert.deepEqual(await codec.decode(encrypted, PASSWORD), value);
  assert.notDeepEqual(await codec.encode(value, PASSWORD), encrypted);
});

test('v1 gzip codec remains independent and cannot carry AI target files', async () => {
  const original = legacy.encodeArchive(payload()); assert.equal(codec.isEncrypted(original), false);
  assert.deepEqual(legacy.readArchive(original).payload, payload());
  await assert.rejects(codec.decode(original, PASSWORD), /格式|版本/);
  const bad = payload(); bad.files.push({ name: 'ai-tools/ai-tools-store.v1.json', data: { encrypted: 'do-not-allow' } });
  assert.throws(() => legacy.encodeArchive(bad), /不支持/);
});

test('wrong passwords, tampered header/cipher and truncation fail before revealing any content', async () => {
  const original = await codec.encode({ payload: payload(), ai: ai() }, PASSWORD);
  await assert.rejects(codec.decode(original, 'incorrect-password'), /密码|损坏/);
  for (const position of [original.length - 1, Math.floor(original.length * 0.75)]) {
    const changed = Buffer.from(original); changed[position] ^= 1;
    await assert.rejects(codec.decode(changed, PASSWORD), error => { assert.equal(error.message.includes('PRIVATE-V2'), false); return true; });
  }
  for (const value of [Buffer.alloc(0), original.subarray(0, 25), original.subarray(0, -16)]) await assert.rejects(codec.decode(value, PASSWORD));
});

test('fixed KDF parameters cannot be inflated by an unauthenticated archive header', async () => {
  const encrypted = await codec.encode({ payload: payload(), ai: ai() }, PASSWORD);
  const marker = encrypted.indexOf(Buffer.from('{')); const length = encrypted.readUInt32BE(marker - 4);
  const header = JSON.parse(encrypted.subarray(marker, marker + length).toString()); header.kdf.N = 1048576;
  const replacement = Buffer.from(JSON.stringify(header)); const size = Buffer.alloc(4); size.writeUInt32BE(replacement.length);
  const modified = Buffer.concat([encrypted.subarray(0, marker - 4), size, replacement, encrypted.subarray(marker + length)]);
  await assert.rejects(codec.decode(modified, PASSWORD), /格式|版本|参数/);
});

test('bounds and unsafe AI structures are rejected without secret-bearing errors', async () => {
  for (const password of ['', 'short', 'x'.repeat(1025), 'test\0password']) await assert.rejects(codec.encode({ payload: payload(), ai: ai() }, password), /密码/);
  for (const value of [null, [], JSON.parse('{"__proto__":{"polluted":true}}'), { run() {} }]) await assert.rejects(codec.encode({ payload: payload(), ai: value }, PASSWORD));
  let accessed = false; const accessor = {}; Object.defineProperty(accessor, 'secret', { get() { accessed = true; return 'private'; }, enumerable: true });
  await assert.rejects(codec.encode({ payload: payload(), ai: accessor }, PASSWORD)); assert.equal(accessed, false);
  assert.equal(codec.isEncrypted('not a buffer'), false);
  await assert.rejects(codec.decode(Buffer.alloc(codec.MAX_ARCHIVE_BYTES + 1), PASSWORD), /大小|容量|超过/);
});

test('legacy normalization does not let a v2 legacy payload smuggle an AI path', async () => {
  const bad = payload(); bad.files = [{ name: 'ai-tools/router.v1.json', data: {} }];
  await assert.rejects(codec.encode({ payload: bad, ai: ai() }, PASSWORD), /不支持/);
  const raw = payload(); const envelope = { format: 'adb-workbench-backup', payload: raw, sha256: createHash('sha256').update(JSON.stringify(raw)).digest('hex') };
  assert.deepEqual(legacy.readArchive(gzipSync(JSON.stringify(envelope))).payload, raw);
});
