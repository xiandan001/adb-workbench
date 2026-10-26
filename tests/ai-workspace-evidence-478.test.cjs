const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createEvidenceAdapter, MAX_SOURCE_BYTES } = require('../electron/lib/ai-workspace-evidence.cjs');
const { createAiWorkspaceService } = require('../electron/lib/ai-workspace-service.cjs');
const { createBuiltinClient } = require('../electron/lib/ai-workspace-client.cjs');
const { normalizeSelection } = require('../electron/lib/ai-workspace-selection.cjs');
const { parseAnalysis } = require('../electron/lib/ai-workspace-schema.cjs');
const result = { summary: 'Synthetic', findings: [{ title: 'Observed', detail: 'Only the fixture.', evidenceIds: ['E1'], citations: [{ evidenceId: 'E1', startLine: 1, endLine: 2000 }] }], hypotheses: [], nextSteps: [], limitations: [] };

test('2000 ordinary long logcat rows above 128 KiB survive freeze and an actual builtin-client fake transport unchanged', async () => {
  const rows = Array.from({ length: 2000 }, (_, i) => `10-26 10:00:00.123 123 456 I Fixture: row-${i} ${'ordinary diagnostic payload '.repeat(4)}`);
  const raw = rows.join('\n'); assert.ok(Buffer.byteLength(raw) > 128 * 1024);
  const adbCalls = [], sends = [];
  const evidence = createEvidenceAdapter({ runAdb: async (args, options) => {
    adbCalls.push({ args, options }); return { ok: true, stdout: args.includes('get-state') ? 'device' : raw };
  } });
  const client = createBuiltinClient({ getConfig: () => ({ url: 'https://fixture.invalid/chat', key: 'fixture', model: 'fixture' }), request: (_options, receive) => {
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = body => {
      sends.push(JSON.parse(body)); queueMicrotask(() => {
        const res = new EventEmitter(); res.headers = {}; res.statusCode = 200; res.complete = false; res.destroy = () => {};
        receive(res); res.emit('data', Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] })));
        res.complete = true; res.emit('end');
      });
    }; return req;
  } });
  const service = createAiWorkspaceService({ evidence, client, membership: async () => ({ activated: true, scope: 'vip' }) });
  const caseId = randomUUID();
  const collected = await service.call('collect', { caseId, mode: 'diagnose', deviceId: 'fixture-A', question: 'Only synthetic data.', checks: ['logcat_snapshot'] });
  assert.equal(collected.ok, true); assert.equal(sends.length, 0);
  const entry = collected.preview.entries[0];
  assert.equal(entry.lineCount, 2000); assert.equal(entry.originalLineCount, 2000); assert.equal(entry.retainedLineCount, 2000);
  assert.equal(entry.truncated, false); assert.deepEqual(entry.originalLineNumbers, rows.map((_, i) => i + 1));
  assert.equal(entry.text, rows.map((row, i) => `[L${i + 1}] ${row}`).join('\n'));
  assert.equal(entry.events.length, 256); assert.equal(entry.events[0].clockBasis, 'device-local-year-unknown'); assert.ok(entry.timeWarning);
  assert.ok(adbCalls.find(call => call.args.includes('logcat')).options.maxBuffer > 128 * 1024);
  assert.deepEqual(adbCalls.find(call => call.args.includes('logcat')).args, ['-s', 'fixture-A', 'logcat', '-d', '-v', 'threadtime', '-t', '2000']);
  const analyzed = await service.call('analyze', { caseId, previewId: collected.preview.id, consent: true });
  assert.equal(analyzed.ok, true); assert.equal(sends.length, 1); assert.equal(sends[0].max_tokens, 3000);
  assert.deepEqual(JSON.parse(sends[0].messages[1].content).evidence, collected.preview.entries);
  assert.equal(analyzed.result.findings[0].citations[0].endLine, 2000);
});

test('literal keyword context merges overlaps, filters locally and preserves original line positions after redaction', async () => {
  const adapter = createEvidenceAdapter({});
  const collected = await adapter.collect({ text: 'outside\nbefore\nERROR.* password=secret\nafter\nERROR.* again\nend\noutside',
    selection: { keywords: 'ERROR.*', contextLines: 1, maxLines: 2000 } });
  const entry = collected.entries[0];
  assert.deepEqual(entry.originalLineNumbers, [2, 3, 4, 5, 6]);
  assert.equal(entry.originalLineCount, 7); assert.equal(entry.selectedLineCount, 5); assert.equal(entry.lineCount, 5);
  assert.doesNotMatch(entry.text, /secret|outside/); assert.match(entry.text, /ERROR\.\*/);
  assert.equal(entry.redactions, 1);
});

test('time filters preserve local/source clock basis and reject invalid or reversed boundaries', async () => {
  const adapter = createEvidenceAdapter({});
  const text = ['2026-10-26T09:00:00Z old', '2026-10-26T10:00:00Z yes', 'unknown timestamp', '2026-10-26T11:00:00Z late'].join('\n');
  const entry = (await adapter.collect({ text, selection: { from: '2026-10-26T09:30:00Z', to: '2026-10-26T10:30:00Z', contextLines: 0 } })).entries[0];
  assert.deepEqual(entry.originalLineNumbers, [2]); assert.equal(entry.events[0].timestamp, '2026-10-26T10:00:00Z'); assert.ok(entry.timeWarning);
  for (const selection of [{ from: 'garbage' }, { from: '2026-02-30T10:00' }, { from: '2026-10-27T10:00', to: '2026-10-26T10:00' }, { maxLines: 2001 }, { contextLines: 21 }, { keywords: 'x'.repeat(513) }, { expression: '.*' }]) assert.throws(() => normalizeSelection(selection), { code: 'AI_SELECTION' });
});

test('yearless device times remain explicitly yearless; unknown serial receipt times are not promoted to event times', async () => {
  const adapter = createEvidenceAdapter({ getSerial: () => ({ terminal: { sessionId: 's', path: 'COM-fixture', entries: [{ sessionId: 's', time: '2026-10-26T10:00:00Z', direction: 'RX', text: 'fixture' }] } }) });
  const source = adapter.list()[0];
  const receipt = (await adapter.collect({ sourceIds: [source.id] })).entries[0];
  assert.deepEqual(receipt.events, []); assert.ok(receipt.timeWarning);
  await assert.rejects(adapter.collect({ sourceIds: [source.id], selection: { from: '2026-10-26T09:00' } }), { code: 'AI_EVIDENCE_EMPTY' });
  const yearless = (await adapter.collect({ text: '10-26 10:00:00.000 1 2 I yes\n10-26 12:00:00.000 1 2 I no', selection: { from: '2026-10-26T09:00', to: '2026-10-26T11:00' } })).entries[0];
  assert.equal(yearless.lineCount, 1); assert.equal(yearless.events[0].clockBasis, 'device-local-year-unknown');
});

test('multiline secret redaction retains stable line numbering; exceptional rows explicitly truncate within UTF-8 budget', async () => {
  const adapter = createEvidenceAdapter({});
  const entry = (await adapter.collect({ text: 'begin\n-----BEGIN PRIVATE KEY-----\nprivate-data\n-----END PRIVATE KEY-----\nend' })).entries[0];
  assert.equal(entry.lineCount, 5); assert.deepEqual(entry.originalLineNumbers, [1, 2, 3, 4, 5]); assert.doesNotMatch(entry.text, /private-data/);
  const long = (await adapter.collect({ text: '中'.repeat(Math.floor(MAX_SOURCE_BYTES / 3)) })).entries[0];
  assert.equal(long.truncated, true); assert.ok(Buffer.byteLength(long.text) <= MAX_SOURCE_BYTES); assert.doesNotMatch(long.text, /\ufffd/);
});

test('line citations reject unknown IDs, missing source membership, reversed, fractional and out-of-bounds positions', () => {
  const evidence = [{ id: 'E1', text: '[L1] one\n[L2] two', lineCount: 2 }, { id: 'E2', text: '[L1] other', lineCount: 1 }];
  const answer = { ...result, findings: [{ ...result.findings[0], citations: [{ evidenceId: 'E1', startLine: 1, endLine: 2 }] }] };
  assert.equal(parseAnalysis(JSON.stringify(answer), evidence).findings[0].citations[0].endLine, 2);
  for (const citation of [{ evidenceId: 'E99', startLine: 1, endLine: 1 }, { evidenceId: 'E2', startLine: 1, endLine: 1 },
    { evidenceId: 'E1', startLine: 2, endLine: 1 }, { evidenceId: 'E1', startLine: 0, endLine: 1 }, { evidenceId: 'E1', startLine: 1, endLine: 3 }, { evidenceId: 'E1', startLine: 1.5, endLine: 2 }]) {
    assert.throws(() => parseAnalysis(JSON.stringify({ ...answer, findings: [{ ...answer.findings[0], citations: [citation] }] }), evidence), { code: 'invalid_evidence' });
  }
});

test('50k log records and 10k serial records only access the bounded recent window, not every payload', async t => {
  const payload = 'fixture '.repeat(512);
  for (const kind of ['log', 'serial']) {
    let reads = 0;
    const count = kind === 'log' ? 50000 : 10000;
    const rows = Array.from({ length: count }, (_, i) => ({ sessionId: 'fixture-session', time: i, direction: 'RX',
      get raw() { reads++; return payload; }, get text() { reads++; return payload; } }));
    const adapter = createEvidenceAdapter(kind === 'log'
      ? { getLogs: () => [{ source: 'file', identity: 'fixture-large', entries: rows }] }
      : { getSerial: () => ({ terminal: { sessionId: 'fixture-session', path: 'COM-fixture', entries: rows } }) });
    const source = adapter.list()[0]; assert.equal(reads, 0);
    const started = performance.now(), memory = process.memoryUsage().heapUsed;
    const snapshot = await adapter.collect({ sourceIds: [source.id] });
    const duration = performance.now() - started, growth = Math.max(0, process.memoryUsage().heapUsed - memory);
    t.diagnostic(`${kind}: ${reads}/${count} payloads read, ${duration.toFixed(1)}ms, heap delta ${growth} bytes`);
    assert.ok(reads < 600, `${kind} unexpectedly scanned all large payloads`);
    assert.ok(duration < 5000, 'bounded capture should not block for seconds');
    assert.ok(growth < 64 * 1024 * 1024, 'capture must not copy the complete 40-200MiB source');
    const entry = snapshot.entries[0];
    assert.equal(entry.windowInfo.originalRecords, count); assert.equal(entry.truncated, true); assert.ok(entry.selectionWarning);
    assert.equal(entry.originalLineNumbers, undefined); assert.ok(Buffer.byteLength(entry.text) <= MAX_SOURCE_BYTES);
  }
});

test('a multi-line source record is also bounded before splitting, and a truncated private-key block stays redacted', async () => {
  const adapter = createEvidenceAdapter({ getLogs: () => [{ source: 'file', identity: 'fixture-lines', entries: [{ raw: 'tiny\n'.repeat(100000) }] }] });
  const entry = (await adapter.collect({ sourceIds: [adapter.list()[0].id] })).entries[0];
  assert.ok(entry.originalLineCount <= 8000); assert.equal(entry.lineCount, 2000); assert.ok(entry.selectionWarning);
  const hidden = createEvidenceAdapter({});
  const result = (await hidden.collect({ text: 'partial-secret-fragment\n-----END PRIVATE KEY-----\nvisible' })).entries[0];
  assert.doesNotMatch(result.text, /partial-secret-fragment/); assert.match(result.text, /visible/);
});
