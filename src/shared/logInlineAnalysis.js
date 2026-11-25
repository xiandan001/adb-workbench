import { captureLogEvidence } from './logWorkspace.js';
import { tr } from './i18n.js';
import { AI_CONTEXT_BYTES } from './aiContextTextWindow.js';

export const INLINE_LOG_LINES = 2000;
export const INLINE_LOG_BYTES = AI_CONTEXT_BYTES;
const encoder = new TextEncoder();
export function prepareInlineLogAnalysis(rows, { deviceId = '', previousEvidence = [], sourceTruncated = false, scopeLabel = '', evidenceScopeKey = '' } = {}) {
  const selected = []; let bytes = 0, retainedLines = 0, omittedOversized = 0, first = rows.length, last = -1;
  for (let index = rows.length - 1; index >= 0 && selected.length < INLINE_LOG_LINES; index--) {
    const entry = rows[index]; if (typeof entry?.raw !== 'string') continue;
    // The conservative reference allowance covers [L100000] plus its separating space.
    if (entry.raw.length > INLINE_LOG_BYTES) { omittedOversized++; continue; }
    const size = encoder.encode(entry.raw).byteLength + 10 + (selected.length ? 1 : 0);
    const lines = entry.raw.split(/\r\n|\r|\n/).length;
    if (size > INLINE_LOG_BYTES || lines > INLINE_LOG_LINES) { omittedOversized++; continue; }
    if (bytes + size > INLINE_LOG_BYTES || retainedLines + lines > INLINE_LOG_LINES) break;
    selected.push(Object.freeze({ ...entry })); bytes += size; retainedLines += lines; first = index; if (last < 0) last = index;
  }
  const selectedEntries = Object.freeze(selected.reverse()), captured = captureLogEvidence(selectedEntries, previousEvidence, deviceId, evidenceScopeKey);
  const lines = Object.freeze(selectedEntries.map(entry => `[${captured.references.get(entry.id)}] ${entry.raw}`));
  const actualBytes = encoder.encode(lines.join('\n')).byteLength;
  if (actualBytes > INLINE_LOG_BYTES) throw new Error(tr('本次日志证据超过大小限制，请缩小范围；未发送。'));
  return { selectedEntries, evidence: captured.evidence, references: captured.references, lines,
    evidenceRefs: Object.freeze([...captured.references.values()]), scope: Object.freeze({ totalEntries: rows.length, retainedEntries: selectedEntries.length, retainedLines, bytes: actualBytes,
      partial: sourceTruncated || omittedOversized > 0 || selectedEntries.length < rows.length, omittedOversized,
      firstEntry: selectedEntries.length ? first + 1 : 0, lastEntry: last + 1, label: scopeLabel }) };
}
const HEADINGS = [
  ['conclusion', /^(结论|結論|分析结论|分析結論|摘要|summary|conclusion|要約|結論|요약|결론)(?:\s|[:：]|$)/i],
  ['evidence', /^(依据|依據|证据|證據|evidence|findings|根拠|証拠|근거|증거)(?:\s|[:：]|$)/i],
  ['hypotheses', /^(待验证|待驗證|假设|假設|推测|推測|hypothes|assumption|仮説|가설|추정)/i],
  ['next', /^(下一步|建议|建議|next steps?|recommendation|次の|対応|다음|권장)(?:\s|[:：]|$)/i],
];
export function splitLogAnalysisSections(content) {
  const fullText = String(content || ''), sections = []; let current = null, fenced = false, preamble = '';
  for (const line of fullText.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = !fenced && line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) { current = { heading: heading[1], kind: HEADINGS.find(([, pattern]) => pattern.test(heading[1].replace(/^\d+[.)、]\s*/, '')))?.[0] || 'other', content: '' }; sections.push(current); }
    else if (current) current.content += (current.content ? '\n' : '') + line;
    else preamble += (preamble ? '\n' : '') + line;
  }
  const structured = sections.some(section => section.kind !== 'other');
  if (preamble.trim()) sections.unshift({ heading: '', kind: 'other', content: preamble });
  return { structured, sections: structured ? sections.map(section => ({ ...section, content: section.content.trim() })) : [], fullText };
}
