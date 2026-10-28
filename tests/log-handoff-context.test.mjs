import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { tr } from '../src/shared/i18n.js';
import { prepareLogHandoffContext, LOG_HANDOFF_BYTES, LOG_HANDOFF_LINES } from '../src/shared/logHandoffContext.js';

const bytes = text => Buffer.byteLength(text, 'utf8');
const lines = text => text ? text.split('\n').length : 0;
const digest = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');

test('empty and small filtered snapshots preserve chronological rows without modifying the input', () => {
  assert.deepEqual(prepareLogHandoffContext([]), { text: '', bytes: 0, totalEntries: 0, retainedEntries: 0, retainedLines: 0,
    totalLines: 0, firstEntry: 0, lastEntry: 0, partialEntries: 0, truncated: false });
  const rows = Object.freeze([Object.freeze({ raw: 'first\r\nsecond' }), Object.freeze({ raw: '最后😀' })]);
  const before = digest(rows), result = prepareLogHandoffContext(rows);
  assert.equal(result.text, 'first\nsecond\n最后😀'); assert.equal(result.bytes, bytes(result.text));
  assert.equal(result.retainedEntries, 2); assert.equal(result.totalEntries, 2); assert.equal(result.retainedLines, 3);
  assert.equal(result.totalLines, 3); assert.equal(result.truncated, false); assert.equal(digest(rows), before);
  assert.equal(prepareLogHandoffContext(rows, true).truncated, true, 'Upstream clipped buffers cannot be presented as complete');
});

test('16,668 rows keep the latest 2,000 physical lines, not the whole joined buffer', () => {
  const rows = Array.from({ length: 16668 }, (_, i) => ({ raw: `row-${i + 1} ${'normal '.repeat(26)}` }));
  const before = digest(rows), result = prepareLogHandoffContext(rows);
  assert.equal(result.totalEntries, 16668); assert.equal(result.retainedEntries, 2000); assert.equal(result.retainedLines, 2000);
  assert.equal(result.firstEntry, 14669); assert.equal(result.lastEntry, 16668); assert.equal(result.totalLines, null);
  assert.ok(result.text.startsWith('row-14669 ')); assert.ok(result.text.endsWith(rows.at(-1).raw));
  assert.ok(result.bytes > 128 * 1024 && result.bytes <= LOG_HANDOFF_BYTES); assert.equal(result.truncated, true);
  assert.equal(result.partialEntries, 0); assert.equal(digest(rows), before);
});

test('multiline entries obey physical line limits and explicitly disclose a partial oldest entry', () => {
  const rows = [{ raw: Array.from({ length: 2500 }, (_, i) => `old-${i + 1}`).join('\r\n') }, { raw: 'new-1\nnew-2' }];
  const result = prepareLogHandoffContext(rows);
  assert.equal(result.retainedEntries, 2); assert.equal(result.retainedLines, 2000); assert.equal(lines(result.text), 2000);
  assert.equal(result.partialEntries, 1); assert.match(result.text, /此记录仅保留末尾片段：/);
  assert.ok(result.text.includes('old-503\n')); assert.ok(result.text.endsWith('new-1\nnew-2'));
  assert.equal(result.bytes, bytes(result.text)); assert.equal(result.truncated, true);
});

test('UTF-8 budget preserves Chinese and emoji boundaries and prefers whole physical lines', () => {
  const rows = Array.from({ length: 3000 }, (_, i) => ({ raw: `row-${i} ${'中文😀'.repeat(70)}` }));
  const result = prepareLogHandoffContext(rows);
  assert.ok(result.bytes <= LOG_HANDOFF_BYTES); assert.equal(result.bytes, bytes(result.text));
  assert.ok(result.retainedLines <= LOG_HANDOFF_LINES); assert.equal(result.partialEntries, 0);
  assert.equal(result.text, rows.slice(-result.retainedEntries).map(row => row.raw).join('\n'));
  assert.ok(result.text.isWellFormed()); assert.ok(!result.text.includes('\uFFFD'));
});

test('a giant single row is bounded before encoding and marks its partial suffix without splitting Unicode', () => {
  const raw = 'early-do-not-materialize '.repeat(500000) + '中文😀'.repeat(100000);
  const result = prepareLogHandoffContext([{ raw }]);
  assert.equal(result.retainedEntries, 1); assert.equal(result.retainedLines, 1); assert.equal(result.partialEntries, 1);
  assert.equal(result.totalLines, null); assert.equal(result.truncated, true);
  assert.match(result.text, /^此记录仅保留末尾片段：/); assert.ok(result.text.endsWith('中文😀'));
  assert.ok(result.text.isWellFormed()); assert.ok(!result.text.includes('\uFFFD'));
  assert.equal(result.bytes, bytes(result.text)); assert.ok(result.bytes <= LOG_HANDOFF_BYTES);
});

test('byte-clipped multiline entries drop an incomplete line before complete recent lines', () => {
  const result = prepareLogHandoffContext([{ raw: 'x'.repeat(LOG_HANDOFF_BYTES * 3) + '\nlatest-line\nfinal-line' }]);
  assert.equal(result.text, '此记录仅保留末尾片段：latest-line\nfinal-line');
  assert.equal(result.retainedLines, 2); assert.equal(result.partialEntries, 1);
});

test('bounded ANSI/control cleanup keeps tabs, text and Unicode without changing the original or declaring truncation', () => {
  const raw = '\x1b[32m中文😀\x1b[0m\tvalue\x00\x07\n\x1b]0;private title\x07normal\x7f';
  const result = prepareLogHandoffContext([{ raw }]);
  assert.equal(result.text, '中文😀\tvalue\nnormal'); assert.equal(result.bytes, bytes(result.text));
  assert.equal(result.retainedLines, 2); assert.equal(result.truncated, false); assert.ok(raw.includes('\x1b[32m'));
});

test('50k large rows only access a bounded suffix and never encode the entire backing buffer', () => {
  let reads = 0; const raw = '中😀'.repeat(20000);
  const rows = Array.from({ length: 50000 }, () => ({ get raw() { reads++; return raw; } }));
  const start = performance.now(), result = prepareLogHandoffContext(rows), elapsed = performance.now() - start;
  assert.ok(reads <= 5, `Read ${reads} large rows instead of a bounded suffix`);
  assert.equal(result.totalEntries, 50000); assert.ok(result.retainedEntries >= 2);
  assert.ok(result.bytes <= LOG_HANDOFF_BYTES); assert.equal(result.bytes, bytes(result.text));
  assert.ok(elapsed < 2000, `Bounded snapshot took ${elapsed}ms`);
});

test('repeated unfinished OSC is processed within the bounded window without repeated whole-tail scanning', () => {
  const raw = '\x1b]unfinished title '.repeat(30000), start = performance.now();
  const result = prepareLogHandoffContext([{ raw }]);
  assert.ok(performance.now() - start < 2000); assert.ok(result.bytes <= LOG_HANDOFF_BYTES);
  assert.ok(!result.text.includes('\x1b')); assert.equal(result.retainedLines, 1);
});

test('format cleanup cannot reopen the raw scan budget and amplify work across thousands of large rows', () => {
  let reads = 0; const raw = '\x1b[32m'.repeat(30000);
  const rows = Array.from({ length: 50000 }, () => ({ get raw() { reads++; return raw; } }));
  const result = prepareLogHandoffContext(rows);
  assert.ok(reads <= 4, `Cleaned display bytes must not allow ${reads} huge input rows to be scanned`);
  assert.ok(result.bytes < 100); assert.equal(result.bytes, bytes(result.text)); assert.equal(result.truncated, true);
});

test('the component prepares only on click, propagates upstream clipping and exposes accurate range without storing raw text', () => {
  const require = createRequire(import.meta.url), parser = require('@babel/parser'), traverse = require('@babel/traverse').default;
  const source = fs.readFileSync(new URL('../src/components/LogFilterHandoff.jsx', import.meta.url), 'utf8');
  const ast = parser.parse(source, { sourceType: 'module', plugins: ['jsx'] }); let prepare;
  traverse(ast, { VariableDeclarator({ node }) { if (node.id.name === 'prepare') prepare = source.slice(node.init.start, node.init.end); } });
  assert.ok(prepare); assert.match(source, /context=\{prepare\}/); assert.doesNotMatch(source, /useEffect|useMemo/);
  let accesses = 0, range, created;
  const rows = [{ get raw() { accesses++; return 'fixture row'; } }];
  const action = new Function('prepareLogHandoffContext', 'tr', 'rows', 'sourceTruncated', 'deviceId', 'setPrepared', 'setCreated', 'describe', `return (${prepare});`)(
    prepareLogHandoffContext, tr, rows, true, 'clicked-device', value => { range = value; }, value => { created = value; },
    value => `${value.retainedEntries}/${value.totalEntries}; ${value.retainedLines} lines; ${value.bytes} bytes. `);
  assert.equal(accesses, 0);
  const payload = action(); assert.equal(accesses, 1); assert.equal(payload.view.deviceId, 'clicked-device');
  assert.equal(payload.view.origin, 'log-filter'); assert.equal(payload.view.truncated, true);
  assert.equal(payload.view.text, 'fixture row'); assert.equal(payload.view.trust, undefined);
  assert.equal(range.text, undefined); assert.equal(range.bytes, bytes(payload.view.text)); assert.equal(created, false);
  assert.match(payload.view.question, /局部内容/); assert.match(payload.view.title, /1\/1/);
  const analyzer = fs.readFileSync(new URL('../src/components/LogAnalyzer.jsx', import.meta.url), 'utf8');
  assert.match(analyzer, /<LogFilterHandoff rows=\{filtered\} deviceId=\{captureDeviceId\} sourceTruncated=\{truncated\} isDark=\{isDark\}/);
  assert.match(source, /isDark \? 'text-slate-300' : 'text-slate-600'/);
  assert.doesNotMatch(source, /opacity-/);
  assert.doesNotMatch(analyzer, /joinAiContextRows/); assert.match(analyzer, /origin: 'log-diagnostic'/);
});
