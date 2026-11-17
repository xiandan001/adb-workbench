import test from 'node:test';
import assert from 'node:assert/strict';
import policy from '../electron/lib/ai-context-limits.json' with { type: 'json' };
import { contextTextBytes, contextPayloadBytes, evidenceLineIndex, evidenceTextWindow, TEXT_WINDOW_UNITS } from '../src/shared/aiContextTextWindow.js';
const { contentBytes } = policy;

test('cooperative source and complete payload byte checks match actual UTF-8 and JSON escaping at 20 MiB', async () => {
  const text = '中😀"\\\t'.repeat(40000), value = { origin: 'fixture', text, target: 'A' };
  assert.equal(await contextTextBytes(text), Buffer.byteLength(text));
  assert.equal(await contextPayloadBytes(value), Buffer.byteLength(JSON.stringify(value)));
  const exact = { text: '' }; exact.text = 'x'.repeat(contentBytes - Buffer.byteLength(JSON.stringify(exact)));
  assert.equal(await contextPayloadBytes(exact), contentBytes);
  exact.text += 'x'; await assert.rejects(contextPayloadBytes(exact), /20 MiB/);
});

test('20 MiB measurement yields the renderer heartbeat and does not mutate the retained value', async t => {
  const text = 'x'.repeat(contentBytes), value = { text }; let ticks = 0;
  const timer = setInterval(() => ticks++, 1); t.after(() => clearInterval(timer));
  assert.equal(await contextTextBytes(text), contentBytes); assert.ok(ticks > 1); assert.equal(value.text, text);
  await assert.rejects(contextTextBytes(text + 'x'), /20 MiB/);
});

test('single huge evidence lines have bounded character pages without inventing source lines or cutting Unicode', () => {
  const text = '[L1] ' + '中😀'.repeat(2000000), index = evidenceLineIndex(text);
  const first = evidenceTextWindow(index, { start: 0, end: 1, part: 0, numbered: true });
  assert.equal(first.rows.length, 1); assert.equal(first.rows[0].line, 1); assert.ok(first.rows[0].text.length <= TEXT_WINDOW_UNITS);
  assert.equal(first.rows[0].continuedBefore, false); assert.equal(first.rows[0].continuedAfter, true);
  assert.ok(first.count > 1); const second = evidenceTextWindow(index, { start: 0, end: 1, part: 1, numbered: true });
  assert.equal(second.rows[0].line, 1); assert.equal(second.rows[0].continuedBefore, true);
  assert.ok((first.rows[0].text + second.rows[0].text).isWellFormed());
  assert.equal(first.rows[0].text + second.rows[0].text, text.slice(5, 5 + first.rows[0].text.length + second.rows[0].text.length));
});

test('character subpages keep the original 80-line page and exact frozen numbering', () => {
  const text = Array.from({ length: 160 }, (_, i) => `[L${i + 1}] ${'fixture'.repeat(1000)}`).join('\n'), index = evidenceLineIndex(text);
  const page = evidenceTextWindow(index, { start: 80, end: 160, part: 0, numbered: true });
  assert.equal(page.rows[0].line, 81); assert.ok(page.rows.every(row => row.line >= 81 && row.line <= 160));
  assert.ok(page.rows.reduce((sum, row) => sum + row.text.length, 0) <= TEXT_WINDOW_UNITS);
  assert.ok(!page.rows[0].text.startsWith('[L81]')); assert.equal(index.count, 160);
});
