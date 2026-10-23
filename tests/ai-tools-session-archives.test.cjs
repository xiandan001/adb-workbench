const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { createAiToolsSessionArchives, sessionArchiveId } = require('../electron/lib/ai-tools-session-archives.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-session-archive-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function context(name) {
    const directory = path.join(root, name, 'ai-tools'); const home = path.join(root, name, 'home'); const key = randomBytes(32);
    const options = { directory, home, canEncrypt: () => true,
      encrypt(value) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]); },
      decrypt(value) { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(-16)); return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString(); },
    };
    return { options, service: createAiToolsSessionArchives(options) };
  }
  return { root, context, write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); } };
}
const claude = text => Buffer.from(`${JSON.stringify({ type: 'user', sessionId: 'fixture', message: { role: 'user', content: text } })}\n`);
function apply(plan) { for (const target of plan.targets) { fs.mkdirSync(path.dirname(target.path), { recursive: true }); fs.writeFileSync(target.path, target.after); } }

test('explicit export covers four default native roots including Codex archives and keeps exact bytes', async t => {
  const h = fixture(t); const source = h.context('source'); const roots = [
    ['.claude/projects/p/session.jsonl', 'claude', 'jsonl', claude('PRIVATE-CLAUDE-RAW')],
    ['.codex/archived_sessions/old.jsonl', 'codex', 'jsonl', Buffer.from('{"type":"session_meta","payload":{"id":"fixture-c"}}\r\n')],
    ['.gemini/tmp/p/chats/session-test.json', 'gemini', 'json', Buffer.from('{"sessionId":"g","messages":[{"id":"m","type":"user","content":"PRIVATE-GEMINI-RAW"}]}')],
    ['.pi/agent/sessions/p/session.jsonl', 'pi', 'jsonl', Buffer.from('{"type":"session","id":"fixture-p"}\n')],
  ];
  for (const [relative, , , raw] of roots) h.write(path.join(source.options.home, relative), raw);
  h.write(path.join(source.options.home, '.codex', 'auth.json'), 'MUST-NOT-READ');
  for (const name of ['auth.jsonl', '.credentials.jsonl', '.tokens.jsonl']) h.write(path.join(source.options.home, '.claude', 'projects', 'p', name), 'MUST-NOT-READ');
  h.write(path.join(source.options.home, '.claude', 'projects', 'p', '.credentials', 'private.jsonl'), claude('MUST-NOT-EXPORT-CREDENTIAL-DIRECTORY'));
  const result = await source.service.exportPortable(); assert.equal(result.records.length, 4); assert.equal(result.included, true);
  for (const [relative, toolId, format, raw] of roots) {
    const row = result.records.find(item => item.toolId === toolId); assert.deepEqual(Buffer.from(row.data, 'base64'), raw); assert.equal(row.bytes, raw.length);
    assert.equal(row.sourceName, path.basename(relative)); assert.equal(row.id, sessionArchiveId(toolId, format, raw)); assert.equal(Object.hasOwn(row, 'path'), false);
  }
});

test('different machine encryption imports read-only archives, never live CLI paths, and reexports full original bytes', async t => {
  const h = fixture(t); const source = h.context('source'); const target = h.context('target');
  const raw = Buffer.from(Array.from({ length: 2200 }, (_, index) => JSON.stringify({ type: 'user', uuid: `m-${index}`, message: { role: 'user', content: `full message ${index}` } })).join('\n'));
  h.write(path.join(source.options.home, '.claude', 'projects', 'p', 'full.jsonl'), raw);
  const payload = await source.service.exportPortable(); const plan = await target.service.preparePortableImport(payload);
  assert.deepEqual(plan.counts, { added: 1, skipped: 0 }); assert.equal(plan.targets.length, 1); assert.equal(fs.existsSync(target.options.directory), false);
  assert.ok(plan.targets[0].path.endsWith(path.join('session-archives', `${payload.records[0].id}.json`))); assert.equal(plan.targets[0].after.includes(Buffer.from('full message')), false);
  apply(plan); assert.equal(fs.existsSync(target.options.home), false);
  const exported = await target.service.exportPortable(); assert.equal(exported.records.length, 1); assert.deepEqual(Buffer.from(exported.records[0].data, 'base64'), raw);
  assert.equal((await target.service.preparePortableImport(payload)).counts.skipped, 1);
});

test('identical native and migrated bytes deduplicate, distinct snapshots retain independent hashes', async t => {
  const h = fixture(t); const source = h.context('source'); const raw = claude('same');
  h.write(path.join(source.options.home, '.claude', 'projects', 'p', 'same.jsonl'), raw);
  const payload = await source.service.exportPortable(); apply(await source.service.preparePortableImport(payload));
  assert.equal((await source.service.exportPortable()).records.length, 1);
  h.write(path.join(source.options.home, '.claude', 'projects', 'p', 'later.jsonl'), claude('later snapshot'));
  assert.equal((await source.service.exportPortable()).records.length, 2);
});

test('excluded sessions never read native or encrypted archive contents and preserve the target', async t => {
  const h = fixture(t); const source = h.context('source'); h.write(path.join(source.options.directory, 'session-archives', `${'a'.repeat(64)}.json`), 'corrupt-file-must-not-be-read');
  h.write(path.join(source.options.home, '.claude', 'projects', 'p', 'session.jsonl'), 'unknown-schema');
  const excluded = { version: 1, included: false, records: [] };
  assert.deepEqual(await source.service.exportPortable({ includeSessions: false }), excluded);
  const plan = await source.service.preparePortableImport(excluded); assert.deepEqual(plan.targets, []); assert.deepEqual(plan.guards, []); assert.deepEqual(plan.counts, { added: 0, skipped: 0 });
  assert.equal(fs.readFileSync(path.join(source.options.directory, 'session-archives', `${'a'.repeat(64)}.json`), 'utf8'), 'corrupt-file-must-not-be-read');
});

test('source read errors, unknown session schemas and limits fail explicitly instead of truncating', async t => {
  const h = fixture(t); const source = h.context('source'); const file = path.join(source.options.home, '.claude', 'projects', 'p', 'session.jsonl');
  h.write(file, '{"unknown_schema":"new"}\n'); await assert.rejects(source.service.exportPortable(), /格式|识别/);
  h.write(file, Buffer.alloc(16 * 1024 * 1024 + 1)); await assert.rejects(source.service.exportPortable(), /大小|容量|超过/);
  const empty = { version: 1, included: true, records: [] };
  await assert.rejects(source.service.preparePortableImport({ ...empty, records: Array(501).fill({}) }), /数量|容量|格式/);
});

test('import rejects altered hashes, invalid base64, path metadata, duplicate IDs and plaintext archives', async t => {
  const h = fixture(t); const source = h.context('source'); h.write(path.join(source.options.home, '.claude', 'projects', 'p', 's.jsonl'), claude('valid'));
  const exported = await source.service.exportPortable(); const row = exported.records[0]; const target = h.context('target');
  for (const changed of [{ ...row, id: 'f'.repeat(64) }, { ...row, data: '!!!!' }, { ...row, sourceName: '../auth.json' }, { ...row, path: 'C:\\private' }, { ...row, bytes: row.bytes + 1 }]) await assert.rejects(target.service.preparePortableImport({ ...exported, records: [changed] }));
  await assert.rejects(target.service.preparePortableImport({ ...exported, records: [row, row] }));
  h.write(path.join(target.options.directory, 'session-archives', `${row.id}.json`), JSON.stringify(row)); await assert.rejects(target.service.preparePortableImport(exported), /读取|加密|损坏/);
});

test('source link traversal is rejected and constructor performs no filesystem read', async t => {
  const h = fixture(t); const source = h.context('source'); assert.equal(fs.existsSync(source.options.home), false); assert.equal(fs.existsSync(source.options.directory), false);
  const outside = path.join(h.root, 'outside'); h.write(path.join(outside, 'private.jsonl'), claude('outside')); fs.mkdirSync(path.join(source.options.home, '.claude'), { recursive: true });
  fs.symlinkSync(outside, path.join(source.options.home, '.claude', 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(source.service.exportPortable(), /链接|路径/); assert.equal(fs.readFileSync(path.join(outside, 'private.jsonl'), 'utf8'), claude('outside').toString());
});
