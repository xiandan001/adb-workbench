const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseSession, summarizeUsage } = require('../electron/lib/ai-tools-session-parser.cjs');
const { createAiToolsSessions } = require('../electron/lib/ai-tools-sessions.cjs');
const { createAiToolsSessionArchives, sessionArchiveId } = require('../electron/lib/ai-tools-session-archives.cjs');
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n');

test('Claude text, repeated assistant usage, missing counters and HTML remain honest plain data', () => {
  const assistant = { type: 'assistant', sessionId: 'session-a', cwd: '/test', message: { id: 'a', role: 'assistant', model: 'fixture', content: [{ type: 'text', text: '<script>not executable</script>' }], usage: { input_tokens: 12, output_tokens: 4 } } };
  const parsed = parseSession(jsonl([{ type: 'user', message: { role: 'user', content: 'test title' } }, assistant, assistant]), 'claude');
  assert.equal(parsed.title, 'test title'); assert.equal(parsed.messages.length, 2); assert.equal(parsed.usage.length, 1); assert.equal(parsed.usage[0].cached, null);
  assert.equal(parsed.messages[1].text, '<script>not executable</script>'); assert.equal(summarizeUsage([{ ...parsed, toolId: 'claude' }]).models[0].input, 12);
});
test('Codex cumulative repeated snapshots do not double count; resetting segment stays additive', () => {
  const count = (input, output) => ({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: 3 } } } });
  const parsed = parseSession(jsonl([{ type: 'session_meta', payload: { id: 'c', cwd: '/project' } }, { type: 'turn_context', payload: { model: 'fixture-c' } }, count(10, 2), count(10, 2), count(15, 4), count(2, 1)]), 'codex');
  const summary = summarizeUsage([{ ...parsed, toolId: 'codex' }]); assert.equal(summary.models[0].input, 17); assert.equal(summary.models[0].output, 5);
});
test('cumulative counters retain their last known per-field baseline across sparse records', () => {
  const event = value => ({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: value } } });
  const parsed = parseSession(jsonl([event({ input_tokens: 10, cached_input_tokens: 5 }), event({ input_tokens: 15 }), event({ input_tokens: 20, cached_input_tokens: 10 })]), 'codex');
  assert.equal(parsed.usage[0].input, 20); assert.equal(parsed.usage[0].cached, 10);
});
test('large source metadata and repeated usage cannot amplify a small file into an unbounded IPC reply', () => {
  const rows = [{ type: 'turn_context', payload: { model: 'x'.repeat(50000), cwd: 'x'.repeat(50000) } }];
  for (let index = 1; index <= 250; index++) rows.push({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: index } } } });
  const parsed = parseSession(jsonl(rows), 'codex'); assert.equal(parsed.model.length, 256); assert.equal(parsed.cwd.length, 4096); assert.equal(parsed.usage.length, 1); assert.equal(parsed.usage[0].input, 250);
  assert.ok(Buffer.byteLength(JSON.stringify(parsed)) < 10000);
  assert.equal(parseSession('{}\n'.repeat(25000), 'claude').truncated, true);
});
test('Gemini JSON and JSONL updates use final message values', () => {
  const first = { id: 'g1', type: 'gemini', content: 'first', model: 'fixture-g', tokens: { input: 4, output: 2 } };
  const replacement = { ...first, content: 'last', tokens: { input: 4, output: 7 } };
  assert.equal(parseSession(JSON.stringify({ sessionId: 'g', messages: [first] }), 'gemini', 'json').messages[0].text, 'first');
  const parsed = parseSession(jsonl([{ sessionId: 'g' }, first, replacement]), 'gemini'); assert.equal(parsed.messages.length, 1); assert.equal(parsed.messages[0].text, 'last'); assert.equal(parsed.usage[0].output, 7);
});
test('Pi retains source token semantics; malformed lines and bounded views are reported', () => {
  const parsed = parseSession(`${jsonl([{ type: 'session', id: 'p', cwd: '/pi' }, { type: 'message', id: 'p1', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(20000) }], model: 'fixture-p', usage: { input: 1, output: 2, cacheRead: 3 } } }])}\n{broken`, 'pi');
  assert.equal(parsed.messages[0].text.length, 16000); assert.equal(parsed.messages[0].truncated, true); assert.equal(parsed.invalidLines, 1); assert.equal(parsed.usage[0].cached, 3);
  assert.throws(() => parseSession('\0', 'claude'), { code: 'AI_TOOLS_SESSION_FORMAT' });
});
test('Worker is lazy, scans only supplied fixture home, handles pagination and never mutates source', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ai-session-test-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const folder = path.join(home, '.claude', 'projects', 'test'); fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'fixture.jsonl'); const source = jsonl([{ type: 'user', sessionId: 'test', message: { role: 'user', content: 'searchable session' } }]); fs.writeFileSync(file, source);
  const service = createAiToolsSessions({ home }); t.after(() => service.dispose());
  assert.equal((await service.list({})).scannedAt, null); assert.equal((await service.scan()).count, 1);
  const result = await service.list({ search: 'searchable' }); assert.equal(result.sessions.length, 1); assert.equal((await service.open({ id: result.sessions[0].id })).messages[0].text, 'searchable session');
  await assert.rejects(service.open({ id: '../secrets' }), { code: 'AI_TOOLS_SESSION_MISSING' }); assert.equal(fs.readFileSync(file, 'utf8'), source);
  await service.dispose(); await assert.rejects(service.scan(), { code: 'AI_TOOLS_DISPOSED' });
});

test('migration cancellation terminates the pending worker but allows later fresh scans', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ai-session-cancel-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const service = createAiToolsSessions({ home }); t.after(() => service.dispose());
  const pending = service.scan(); const rejected = assert.rejects(pending, { code: 'AI_TOOLS_CANCELLED' });
  await service.cancelPending(); await rejected;
  assert.equal((await service.scan()).count, 0);
});

test('imported archives are lazy, read-only, paginated and deduplicated against identical live originals', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-session-viewer-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'); const directory = path.join(root, 'ai-tools'); let decrypts = 0;
  const crypto = { canEncrypt: () => true, encrypt: text => Buffer.from(text).map(byte => byte ^ 0x45), decrypt: bytes => { decrypts++; return bytes.map(byte => byte ^ 0x45).toString(); } };
  const archive = createAiToolsSessionArchives({ directory, home, ...crypto });
  const folder = path.join(home, '.claude', 'projects', 'p'); fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'session.jsonl'); const raw = jsonl([...Array.from({ length: 65 }, (_, index) => ({ type: 'user', uuid: `m${index}`, sessionId: 's', message: { role: 'user', content: `archive message ${index}` } })),
    { type: 'assistant', uuid: 'answer', sessionId: 's', message: { role: 'assistant', model: 'fixture', content: 'answer', usage: { input_tokens: 7, output_tokens: 3 } } }]);
  fs.writeFileSync(file, raw); const portable = await archive.exportPortable(); const plan = await archive.preparePortableImport(portable);
  for (const target of plan.targets) { fs.mkdirSync(path.dirname(target.path), { recursive: true }); fs.writeFileSync(target.path, target.after); }
  const service = createAiToolsSessions({ directory, home, ...crypto }); t.after(() => service.dispose());
  assert.equal((await service.list({})).count, 0); assert.equal(decrypts, 0);
  const scan = await service.scan(); assert.equal(scan.count, 1); assert.equal(scan.usage.models[0].input, 7); let list = await service.list({}); assert.equal(list.sessions[0].imported, undefined);
  fs.unlinkSync(file); assert.equal((await service.scan()).count, 1); list = await service.list({});
  const row = list.sessions[0]; assert.equal(row.imported, true); assert.equal(row.archived, true); assert.equal(row.source, 'migration-archive'); assert.equal(row.readOnly, true); assert.equal(row.path, '迁移归档/session.jsonl');
  const first = await service.open({ id: row.id }); assert.equal(first.messages.length, 50); assert.equal(first.hasMore, true); assert.equal(first.messages[0].text, 'archive message 0'); assert.equal(Object.hasOwn(first, 'data'), false);
  const next = await service.open({ id: row.id, offset: 50 }); assert.equal(next.messages.length, 16); assert.equal(next.messages[0].text, 'archive message 50'); assert.equal(list.usage.models[0].input, 7);
  fs.appendFileSync(plan.targets[0].path, '\n'); await assert.rejects(service.open({ id: row.id }), { code: 'AI_TOOLS_SESSION_ARCHIVE_CHANGED' });
});

test('a full native viewer index never hides imported archives from search and open', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-session-viewer-cap-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'); const directory = path.join(root, 'ai-tools'); const folder = path.join(home, '.claude', 'projects', 'p'); fs.mkdirSync(folder, { recursive: true });
  const encryption = { canEncrypt: () => true, encrypt: text => Buffer.from(text).map(byte => byte ^ 0x45), decrypt: bytes => bytes.map(byte => byte ^ 0x45).toString() };
  for (let index = 0; index < 500; index++) fs.writeFileSync(path.join(folder, `${index}.jsonl`), jsonl([{ type: 'user', sessionId: `s-${index}`, message: { role: 'user', content: `native fixture ${index}` } }]));
  const raw = Buffer.from(jsonl([{ type: 'user', sessionId: 'archive', message: { role: 'user', content: 'imported after full native index' } }])); const id = sessionArchiveId('claude', 'jsonl', raw);
  const archives = createAiToolsSessionArchives({ home, directory, ...encryption }); const plan = await archives.preparePortableImport({ version: 1, included: true, records: [{ id, toolId: 'claude', format: 'jsonl', data: raw.toString('base64'), bytes: raw.length, sourceName: 'imported.jsonl', modifiedAt: Date.now() + 10000 }] });
  for (const target of plan.targets) { fs.mkdirSync(path.dirname(target.path), { recursive: true }); fs.writeFileSync(target.path, target.after); }
  const service = createAiToolsSessions({ home, directory, ...encryption }); t.after(() => service.dispose());
  const scanned = await service.scan(); assert.equal(scanned.count, 501); assert.equal(scanned.archivedCount, 1);
  const first = await service.list({}); assert.equal(first.sessions.length, 50); assert.equal(first.sessions[0].imported, true);
  const found = await service.list({ search: 'imported after full' }); assert.equal(found.sessions.length, 1); assert.equal(found.sessions[0].id, id);
  assert.equal((await service.open({ id })).messages[0].text, 'imported after full native index');
});

test('cancelling an archive-directory read cannot let its late completion terminate a fresh scan', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-session-archive-cancel-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'); const directory = path.join(root, 'ai-tools'); const archiveDirectory = path.join(directory, 'session-archives'); fs.mkdirSync(archiveDirectory, { recursive: true });
  const service = createAiToolsSessions({ home, directory, canEncrypt: () => false }); t.after(() => service.dispose());
  const open = fs.promises.opendir; let entered; let release; let paused = false;
  const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  t.mock.method(fs.promises, 'opendir', async (...args) => { if (!paused && args[0] === archiveDirectory) { paused = true; entered(); await gate; } return open(...args); });
  const original = service.scan(); const rejected = assert.rejects(original, { code: 'AI_TOOLS_CANCELLED' }); await started;
  await service.cancelPending(); assert.equal((await service.scan()).count, 0); release(); await rejected;
  assert.equal((await service.list({})).count, 0);
});
