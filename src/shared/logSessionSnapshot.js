import { tr } from './i18n.js';
import { saveLogEvidenceInSession } from './logWorkspace.js';

export const LOG_CLIPBOARD_BYTES = 8 * 1024 * 1024;
export function logListPreview(value, limit = 2048) {
  const text = String(value ?? ''); let end = Math.min(text.length, limit);
  if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
  return { text: text.slice(0, end) + (end < text.length ? '…' : ''), truncated: end < text.length };
}

export async function buildLogClipboardText(rows, { maxBytes = LOG_CLIPBOARD_BYTES, yieldTask = () => new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
  const parts = [], encoder = new TextEncoder(); let bytes = 0, checkpoint = 0;
  for (let index = 0; index < rows.length; index++) {
    const raw = String(rows[index].raw ?? '');
    if (raw.length > maxBytes) throw new Error(tr('剪贴板最多复制 8 MiB，请改用导出；未截断或复制部分内容。'));
    bytes += encoder.encode(raw).byteLength + Number(index > 0);
    if (bytes > maxBytes) throw new Error(tr('剪贴板最多复制 8 MiB，请改用导出；未截断或复制部分内容。'));
    parts.push(raw);
    if (index % 500 === 499 || bytes - checkpoint >= 256 * 1024) { await yieldTask(); checkpoint = bytes; }
  }
  return parts.join('\n');
}

export function advanceLogAiRevision(previous, turns) {
  const old = previous?.turns || [];
  const changed = old.length !== turns.length || turns.some((turn, index) => {
    const saved = old[index], refs = turn.evidenceRefs || [];
    return !saved || saved.header !== turn.header || saved.content !== turn.content || saved.reasoning !== turn.reasoning
      || !(saved.refsSource === refs && Object.isFrozen(refs)) && (saved.evidenceRefs.length !== refs.length || saved.evidenceRefs.some((ref, at) => ref !== refs[at]));
  });
  return { revision: (previous?.revision || 0) + Number(changed), turns: turns.map(turn => ({ header: turn.header, content: turn.content, reasoning: turn.reasoning,
    refsSource: turn.evidenceRefs, evidenceRefs: Object.isFrozen(turn.evidenceRefs) ? turn.evidenceRefs : [...(turn.evidenceRefs || [])] })) };
}

export function logDocumentKey({ documentId, entries, markers, aiTurns, aiRevision = 0, filter, buffers, timeRange }) {
  return JSON.stringify([documentId, entries.length, entries[0]?.id || '', entries.at(-1)?.id || '',
    markers.map(marker => [marker.id, marker.note]), aiTurns.length, aiRevision, filter, buffers, timeRange]);
}

export function freezeLogSessionSnapshot(value, { rows = value.entries, name = value.name, uiRevision } = {}) {
  return { name, source: value.source, sourceLabel: value.sourceLabel || '', deviceId: value.deviceId || '',
    entries: [...rows], filter: { ...value.filter }, buffers: [...value.buffers], timeRange: { ...(value.timeRange || { kind: 'all' }) },
    evidence: saveLogEvidenceInSession(value.evidence, rows, value), markers: value.markers.map(marker => ({ ...marker, context: [...marker.context] })),
    aiTurns: value.aiTurns.map(turn => ({ ...turn, evidenceRefs: [...(turn.evidenceRefs || [])] })),
    truncated: value.truncated === true, aiRevision: value.aiRevision || 0, uiRevision };
}
