import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareInlineLogAnalysis, splitLogAnalysisSections, INLINE_LOG_BYTES } from '../src/shared/logInlineAnalysis.js';

test('inline preparation keeps immutable original rows and evidence identities with no API call', () => {
  let sent = 0; const rows = [{ id: 'a', raw: 'first\nsecond', level: 'E' }, { id: 'b', raw: 'third', level: 'I' }];
  const result = prepareInlineLogAnalysis(rows, { deviceId: 'A', api: { aiAnalyzeLog: () => sent++ } });
  assert.equal(sent, 0); assert.equal(result.selectedEntries[0].raw, rows[0].raw); assert.equal(result.scope.retainedLines, 3);
  assert.ok(Object.isFrozen(result.selectedEntries)); assert.ok(Object.isFrozen(result.selectedEntries[0]));
  const reused = prepareInlineLogAnalysis(rows, { deviceId: 'A', previousEvidence: result.evidence }); assert.deepEqual(reused.evidenceRefs, result.evidenceRefs);
  assert.deepEqual(result.lines, result.selectedEntries.map(entry => `[${result.references.get(entry.id)}] ${entry.raw}`));
});
test('inline selection is explicitly partial and never exceeds 2000 raw lines or the shared content budget including references', () => {
  const rows = Array.from({ length: 3000 }, (_, id) => ({ id, raw: '原始日志 '.repeat(100) }));
  const result = prepareInlineLogAnalysis(rows, { sourceTruncated: true });
  assert.ok(result.scope.retainedLines <= 2000); assert.ok(new TextEncoder().encode(result.lines.join('\n')).length <= INLINE_LOG_BYTES);
  assert.equal(result.scope.partial, true); assert.equal(result.selectedEntries.at(-1).id, 2999); assert.equal(rows[0].raw, '原始日志 '.repeat(100));
  const admitted = prepareInlineLogAnalysis([{ id: 'now-accepted', raw: 'x'.repeat(600000) }]); assert.equal(admitted.selectedEntries[0].raw.length, 600000); assert.equal(admitted.scope.partial, false);
  const tooLarge = prepareInlineLogAnalysis([{ id: 'huge', raw: 'x'.repeat(INLINE_LOG_BYTES + 1) }]); assert.equal(tooLarge.selectedEntries.length, 0); assert.equal(tooLarge.scope.omittedOversized, 1);
});
test('result presentation uses only actual headings and preserves an unstructured full-report fallback', () => {
  const content = '# 结论\nObserved only\n## 依据\n[L1] exact\n## 待验证假设\nCould be A\n## 下一步\nVerify A';
  const result = splitLogAnalysisSections(content); assert.equal(result.structured, true); assert.deepEqual(result.sections.map(item => item.kind), ['conclusion', 'evidence', 'hypotheses', 'next']); assert.equal(result.fullText, content);
  const plain = splitLogAnalysisSections('Maybe a timeout, not enough evidence.'); assert.equal(plain.structured, false); assert.equal(plain.fullText, 'Maybe a timeout, not enough evidence.'); assert.deepEqual(plain.sections, []);
});
test('structured presentation preserves unheaded warnings and never parses headings inside code as findings', () => {
  const result = splitLogAnalysisSections('Important uncertainty\n## 1. Conclusion\nOnly a clue\n```text\n# Evidence\nnot a real heading\n```');
  assert.equal(result.sections[0].heading, ''); assert.equal(result.sections[0].content, 'Important uncertainty');
  assert.equal(result.sections[1].kind, 'conclusion'); assert.equal(result.sections.length, 2); assert.ok(result.sections[1].content.includes('# Evidence'));
});
