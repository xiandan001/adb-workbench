const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createWorkspaceProcessor, createWorkerReportStore } = require('../electron/lib/ai-workspace-processor.cjs');
const { createEvidenceBasketStore } = require('../electron/lib/ai-evidence-basket-store.cjs');
const { computeWorkspaceJob } = require('../electron/lib/ai-workspace-compute.cjs');
const limits = require('../electron/lib/ai-workspace-limits.cjs');
const { redactText } = require('../electron/lib/feedback-policy.cjs');
const { redactWorkspaceText } = require('../electron/lib/ai-workspace-redaction.cjs');
const { withLocale } = require('../electron/lib/localization.cjs');
const { createSerialBuffer } = require('../electron/lib/serial-buffer.cjs');
const { createEvidenceAdapter } = require('../electron/lib/ai-workspace-evidence.cjs');
const CONTENT = 20 * 1024 * 1024;
const entry = text => ({ id: 'E1', source: 'text', label: 'Synthetic', target: '', capturedAt: '2026-11-17T00:00:00.000Z', timeBasis: 'unknown',
  text, numbered: false, truncated: false, redactions: 0, lineCount: 1 });
const preview = text => ({ id: randomUUID(), question: 'Only synthetic evidence', expiresAt: '2026-11-17T01:00:00.000Z', entries: [entry(text)] });
const report = text => ({ id: randomUUID(), kind: 'analysis', createdAt: '2026-11-17T00:00:00.000Z', preview: preview(text),
  result: { summary: 'Synthetic evidence', findings: [], hypotheses: [], nextSteps: [], limitations: [] }, usage: null });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ai20-')), processor = createWorkspaceProcessor();
  t.after(async () => { await processor.dispose(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('awb-ai20-')); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, processor };
}
function exactPreview(bytes) {
  const value = preview('中\\"\t');
  value.entries[0].text += 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(value)));
  assert.equal(Buffer.byteLength(JSON.stringify(value)), bytes);
  return value;
}

test('workspace carriers use the shared 20/24/512 MiB budgets without raising source count or HTTP limits', () => {
  assert.equal(limits.sourceBytes, CONTENT); assert.equal(limits.evidenceBytes, CONTENT);
  assert.equal(limits.reportBytes, 24 * 1024 * 1024); assert.equal(limits.historyBytes, 512 * 1024 * 1024);
  assert.equal(limits.reports, 20); assert.equal(limits.recentLines, 2000); assert.equal(limits.captureRecords, 8000);
  assert.equal(limits.inputBytes, 1280 * 1024);
});

test('AI safe redaction preserves all existing mask golden cases including embedded URL schemes and escaped credentials', () => {
  const samples = [
    'password="private" token=other password = token=\'nested\'', 'password="escaped\\\"secret" cookie: \'a\\\'b\'',
    'api_key : value client-secret="secret" authorization=Bearer-token 密码=秘密 激活码="123"',
    'https://u:p@host/path foo_https://u:p@host 123https://u:p@host https://u::@host https://:u:p@host',
    'u@example.com ---u@example.com a+b@example.co.uk foo@host.com.more-123 foo@host.com123 foo@.com foo@..com',
    'Bearer abcdef ghp_abcdefghijk sk-abcdefghijk github_pat_abcdefghijk',
    'C:\\Users\\fixture\\file \\\\server\\share /home/fixture/file /Users/fixture/file 10.2.3.4 999.2.3.4',
    '-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----\nvisible',
    'eyJabcdefghijk.abcdefghijk.abcdefghijk plain\r\nnext',
    'eyJabcdefgh.abcdefgh.abcdefgh- eyJabcdefgh.abcdefgh.abcdefg eyJshort.eyJabcdefgh.abcdefgh.abcdefgh',
  ];
  for (const local of ['u', 'u+v', '---u', 'a.b', '_u', 'foo%bar']) for (const host of ['host.com', 'a.co.uk', '.com', '..com', 'a.com.more-123', 'a.com123', 'a.com-more', 'a.com.x1', 'a.com_']) samples.push(local + '@' + host);
  for (const prefix of ['', 'foo_', '123', '---', 'a ']) for (const user of ['u:p', ':u:p', 'u::', 'u:', '::', 'u:p:x']) samples.push(prefix + 'https://' + user + '@host/path');
  for (const field of ['password', 'token', 'api_key', '密码']) for (const value of ['abc', '"a\\"b"', "'nested'", 'token="nested"']) for (const separator of ['=', ': ', ' " = ']) samples.push(field + separator + value);
  for (const locale of ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR']) withLocale(locale, () => {
    for (const sample of samples) assert.equal(redactWorkspaceText(sample), redactText(sample), locale + ': ' + sample);
  });
});

test('complete frozen preview bytes include UTF-8 escaping and metadata at the exact 20 MiB boundary', async () => {
  const exact = exactPreview(CONTENT), frozen = await computeWorkspaceJob('freeze-preview', { value: exact });
  assert.equal(frozen.bytes, CONTENT); assert.deepEqual(frozen.preview, exact);
  exact.entries[0].text += 'x'; await assert.rejects(computeWorkspaceJob('freeze-preview', { value: exact }), { code: 'AI_EVIDENCE_LIMIT' });
  const below = exactPreview(CONTENT - 1); assert.equal((await computeWorkspaceJob('freeze-preview', { value: below })).bytes, CONTENT - 1);
});

test('real worker freezes a near-20 MiB complete line without silent old-window clipping and keeps the main heartbeat', async t => {
  const { processor } = fixture(t), text = 'x'.repeat(CONTENT - 50 * 1024);
  let ticks = 0, maximumGap = 0, previous = performance.now();
  const timer = setInterval(() => { const current = performance.now(); maximumGap = Math.max(maximumGap, current - previous); previous = current; ticks++; }, 2);
  t.after(() => clearInterval(timer));
  const frozen = await processor.run('freeze', { sources: [{ kind: 'text', label: 'Large fixture', text }], now: 0 });
  assert.equal(frozen.entries[0].text, '[L1] ' + text); assert.equal(frozen.truncated, false); assert.equal(frozen.entries[0].lineCount, 1);
  assert.ok(ticks > 2); assert.ok(maximumGap < 500, 'Large preparation must not run its JSON/regex work on main');
  t.diagnostic(`20MiB freeze heartbeat ticks=${ticks}, maximum gap=${maximumGap.toFixed(1)}ms`);
});

test('real worker bounds adversarial long punctuation, URI and quoted-secret redaction without shortening source evidence', async t => {
  const { processor } = fixture(t), inputs = [
    ...['a.', 'a-', 'a+'].map(atom => atom.repeat(1024 * 1024)),
    'a'.repeat(2 * 1024 * 1024) + '://authority-without-user-info',
    'https://' + 'a-'.repeat(1024 * 1024),
    'aa://'.repeat(256 * 1024) + 'authority-without-credential@host',
    'eyJ-'.repeat(256 * 1024) + ' visible',
  ];
  for (const text of inputs) {
    const frozen = await processor.run('freeze', { sources: [{ kind: 'text', label: 'Adversarial fixture', text }], now: 0 });
    assert.equal(frozen.entries[0].text, '[L1] ' + text); assert.equal(frozen.truncated, false);
  }
  const mixed = 'a-'.repeat(512 * 1024) + ' visible u@example.com foo_https://u:p@host';
  const safeMixed = await processor.run('freeze', { sources: [{ kind: 'text', label: 'Mixed suffixes', text: mixed }], now: 0 });
  assert.equal(safeMixed.entries[0].text, '[L1] ' + 'a-'.repeat(512 * 1024) + ' visible [邮箱已隐藏] foo_https://[凭据已隐藏]@host');
  const spaced = 'password' + ' '.repeat(1024 * 1024);
  const safeSpaced = await processor.run('freeze', { sources: [{ kind: 'text', label: 'No assignment', text: spaced }], now: 0 });
  assert.equal(safeSpaced.entries[0].text, '[L1] ' + spaced);
  const text = 'password="' + 'a\\\"'.repeat(512 * 1024) + '"';
  const frozen = await processor.run('freeze', { sources: [{ kind: 'text', label: 'Quoted secret', text }], now: 0 });
  assert.equal(frozen.truncated, false); assert.equal(frozen.entries[0].redactions, 1); assert.ok(frozen.entries[0].text.length < 100);
});

test('actual large report save/load/export and metadata-only basket operations remain worker-owned and restartable', async t => {
  const { directory, processor } = fixture(t), text = 'large fixture '.repeat(Math.floor((CONTENT - 100 * 1024) / 14));
  const history = createWorkerReportStore({ directory: path.join(directory, 'reports'), processor: processor.run }), value = report(text);
  const saved = await history.save(value, 'Large synthetic report');
  const second = await history.save(value, 'Second large synthetic report');
  const listed = await history.list(); assert.equal(listed.length, 2); assert.equal(listed[0].preview, undefined);
  assert.ok(fs.statSync(path.join(directory, 'reports', saved.id + '.json')).size + fs.statSync(path.join(directory, 'reports', second.id + '.json')).size > 24 * 1024 * 1024);
  const restored = await history.load(saved.id); assert.equal(restored.preview.entries[0].text, text);
  const exported = await processor.run('reportText', { report: restored }); assert.ok(exported.includes(text));
  await assert.rejects(processor.run('reportText', { report: { ...restored, extra: 'x'.repeat(5 * 1024 * 1024) } }), { code: 'AI_REPORT' });
  const filename = path.join(directory, 'basket.json'), basket = createEvidenceBasketStore({ filename, processor: processor.run });
  const item = { id: randomUUID(), origin: 'fixture', title: 'Large synthetic basket', question: 'Synthetic', deviceId: '', createdAt: value.createdAt,
    provenance: { trust: 'renderer-view', origin: 'fixture' }, truncated: false, entries: value.preview.entries };
  const appended = await basket.append(item); assert.equal(appended.revision, 1); assert.equal(appended.items[0].entries, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(await basket.list())) < 4096);
  const reopened = createEvidenceBasketStore({ filename, processor: processor.run }); assert.equal((await reopened.resolve(1)).entries[0].text, text);
});

test('worker byte reservations remain occupied until cancelled jobs are acknowledged and are then released', async t => {
  class FakeWorker extends EventEmitter { ref() {} unref() {} terminate() { return Promise.resolve(); } postMessage(value) { this.requests.push(value); } requests = []; }
  let worker, workerOptions;
  const processor = createWorkspaceProcessor({ workerFactory: (_filename, options) => { workerOptions = options; worker = new FakeWorker(); return worker; } });
  t.after(() => processor.dispose());
  const cancel = new AbortController(), big = 'x'.repeat(CONTENT);
  const first = processor.run('clone', { value: big }, { signal: cancel.signal }).catch(error => error);
  await assert.rejects(processor.run('clone', { value: big }), { code: 'AI_WORKER_BUSY' });
  cancel.abort(); assert.equal((await first).code, 'CANCELLED');
  await assert.rejects(processor.run('clone', { value: big }), { code: 'AI_WORKER_BUSY' });
  worker.emit('message', { id: worker.requests[0].id, error: { code: 'CANCELLED', message: 'Cancelled' } });
  const next = processor.run('clone', { value: big }); worker.emit('message', { id: worker.requests[1].id, result: 'released' });
  assert.equal(await next, 'released'); assert.equal(workerOptions.resourceLimits.maxOldGenerationSizeMb, 384);
});

test('worker allocation failure is an explicit rejected job and does not evict saved evidence', async () => {
  const processor = createWorkspaceProcessor({ workerFactory: () => { throw Error('synthetic memory allocation failure'); } });
  await assert.rejects(processor.run('clone', { value: 'unchanged evidence' }), { code: 'AI_WORKER_FAILED' });
  await processor.dispose();
});

test('cancelled queued basket mutations never commit and concurrent revisions serialize in the actual worker', async t => {
  const { directory, processor } = fixture(t), filename = path.join(directory, 'basket.json');
  const store = createEvidenceBasketStore({ filename, processor: processor.run }), abort = new AbortController();
  const item = () => ({ id: randomUUID(), origin: 'fixture', title: 'Immutable', question: 'Synthetic', deviceId: '', createdAt: '2026-11-17T00:00:00.000Z',
    provenance: { trust: 'renderer-view', origin: 'fixture' }, truncated: false, entries: [entry('unchanged synthetic line')] });
  const busy = processor.run('freeze', { sources: [{ kind: 'text', label: 'Before basket', text: 'x'.repeat(CONTENT - 50 * 1024) }], now: 0 });
  const cancelled = store.append(item(), { signal: abort.signal }); abort.abort(); await assert.rejects(cancelled, { code: 'CANCELLED' });
  await busy; assert.equal((await store.list()).revision, 0); assert.equal(fs.existsSync(filename), false);
  const pending = [item(), item(), item()].map(value => store.append(value));
  assert.deepEqual((await Promise.all(pending)).map(value => value.revision), [1, 2, 3]);
  assert.equal((await store.resolve(3)).items.length, 3); await assert.rejects(store.resolve(2), { code: 'AI_BASKET_CHANGED' });
});

test('basket cancellation at the last pre-rename checkpoint preserves original bytes and removes only its temporary file', async t => {
  const { directory, processor } = fixture(t), filename = path.join(directory, 'basket.json');
  const normal = createEvidenceBasketStore({ filename, processor: processor.run }); await normal.clear(); const before = fs.readFileSync(filename);
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const io = { ...fs.promises, async open(...args) {
    const handle = await fs.promises.open(...args);
    if (args[1] !== 'wx') return handle;
    return { writeFile: async (...values) => { await handle.writeFile(...values); Atomics.store(flag, 0, 1); },
      sync: () => handle.sync(), close: () => handle.close() };
  } };
  const injected = createEvidenceBasketStore({ filename, io }); await assert.rejects(injected.clear({ flag }), { code: 'CANCELLED' });
  assert.deepEqual(fs.readFileSync(filename), before); assert.deepEqual(fs.readdirSync(directory), ['basket.json']);
});

test('actual workspace serial evidence uses the worker printable snapshot and preserves all four binary frames', async t => {
  const { processor } = fixture(t), buffer = createSerialBuffer({ mergeReceive: false, now: () => 0 });
  const frames = ['FE08584248434D440001CF', 'FE09584248434D44000100CF', 'FE08584248434D440002CF', 'FE09584248434D44000201CF'];
  frames.forEach((hex, index) => buffer.append({ bytes: Buffer.from(hex, 'hex'), direction: index % 2 ? 'RX' : 'TX', sessionId: 'synthetic', path: 'COM-FIXTURE', config: {} }));
  const rows = buffer.entriesAfter(), before = structuredClone(rows);
  const adapter = createEvidenceAdapter({ processor: processor.run, getSerial: () => ({ rs232: { sessionId: 'synthetic', path: 'COM-FIXTURE', entries: rows } }) });
  const frozen = await adapter.collect({ sourceIds: [adapter.list()[0].id] });
  assert.equal(frozen.truncated, false); assert.equal(frozen.entries[0].lineCount, 4);
  for (const hex of frames) assert.ok(frozen.entries[0].text.includes(hex.match(/../g).join(' ')));
  assert.deepEqual(rows, before); assert.match(frozen.entries[0].text, /\\x00/);
});

test('worker command delegates request plans and fingerprints without exposing provider or transport operations', async t => {
  const { processor } = fixture(t), payload = { question: 'Only synthetic evidence', evidence: [entry('fixture')] };
  const { buildRequestPlan, buildMarkdownPlan } = require('../electron/lib/ai-workspace-request-plan.cjs');
  const args = { prompt: 'Synthetic plan', payload, locale: 'zh-CN', maxTokens: 3000, phase: 'map' };
  assert.deepEqual(await processor.run('request-plan', args), buildRequestPlan(args));
  const markdown = { prompt: 'Synthetic Markdown', lines: ['[L1] fixture'], intro: 'Local fixture', maxTokens: 3000, maxLines: 2000 };
  assert.deepEqual(await processor.run('markdown-plan', markdown), buildMarkdownPlan(markdown));
  const same = await processor.run('fingerprints', { entries: [payload.evidence[0], { ...payload.evidence[0], id: 'E2' }] });
  assert.equal(same[0], same[1]);
  await assert.rejects(processor.run('request-plan', { ...args, consent: true }), { code: 'AI_EVIDENCE_LIMIT' });
});
