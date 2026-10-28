import { tr } from './i18n.js';

export const LOG_HANDOFF_LINES = 2000;
export const LOG_HANDOFF_BYTES = 448 * 1024;
const encoder = new TextEncoder();
const byteLength = value => encoder.encode(value).byteLength;

// Walk backward by Unicode scalar, counting normalized line breaks. Work stops
// at the remaining budget, even when a single entry contains megabytes of text.
function suffix(raw, maximumBytes, maximumLines) {
  let start = raw.length, bytes = 0, lines = 1;
  while (start > 0) {
    const code = raw.charCodeAt(start - 1);
    let units = 1, size = code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    const newline = code === 10 || code === 13;
    if (code === 10 && start > 1 && raw.charCodeAt(start - 2) === 13) units = 2;
    else if (code >= 0xdc00 && code <= 0xdfff && start > 1) {
      const previous = raw.charCodeAt(start - 2);
      if (previous >= 0xd800 && previous <= 0xdbff) { units = 2; size = 4; }
    }
    if (bytes + size > maximumBytes || (newline && lines === maximumLines)) break;
    bytes += size; start -= units;
    if (newline) lines++;
  }
  return { start, lines };
}
function materialize(raw, start) {
  return raw.slice(start).replace(/\r\n?/g, '\n').toWellFormed();
}
function cleanDisplayControls(text) {
  // The OSC body excludes ESC: many unfinished sequences cannot rescan the tail.
  // eslint-disable-next-line no-control-regex -- Match terminal OSC framing, not user text.
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex -- CSI uses disjoint parameter/intermediate/final ranges.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex -- Keep LF and tab, remove broker-forbidden display controls.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

export function prepareLogHandoffContext(rows, sourceTruncated = false) {
  const parts = [], marker = tr('此记录仅保留末尾片段：'), markerBytes = byteLength(marker);
  let bytes = 0, retainedLines = 0, partialEntries = 0;
  for (let index = rows.length - 1; index >= 0 && retainedLines < LOG_HANDOFF_LINES; index--) {
    const remaining = LOG_HANDOFF_BYTES - bytes - (parts.length ? 1 : 0);
    if (remaining <= 0) break;
    const value = rows[index]?.raw;
    const raw = typeof value === 'string' ? value : '';
    const availableLines = LOG_HANDOFF_LINES - retainedLines;
    let selected = suffix(raw, remaining, availableLines), text;
    const partial = selected.start > 0;
    if (partial) {
      if (remaining <= markerBytes) break;
      selected = suffix(raw, remaining - markerBytes, availableLines);
      text = materialize(raw, selected.start);
      if (selected.start > 0 && !/[\r\n]/.test(raw[selected.start - 1])) {
        const boundary = text.indexOf('\n');
        if (boundary >= 0) { text = text.slice(boundary + 1); selected.lines--; }
        else if (parts.length) break; // Prefer complete recent rows over an older cut line.
      }
      text = marker + text; partialEntries++;
    } else text = materialize(raw, 0);
    // Count the selected raw window before cleanup. ANSI-only rows must not
    // free the scan budget and make us inspect thousands of huge records.
    bytes += byteLength(text) + (parts.length ? 1 : 0);
    text = cleanDisplayControls(text);
    parts.push(text); retainedLines += selected.lines;
    if (partial) break;
  }
  const text = parts.reverse().join('\n');
  const truncated = sourceTruncated === true || partialEntries > 0 || parts.length < rows.length;
  const outputLines = parts.length ? text.split('\n').length : 0;
  return { text, bytes: byteLength(text), totalEntries: rows.length, retainedEntries: parts.length, retainedLines: outputLines,
    totalLines: truncated ? null : retainedLines, firstEntry: parts.length ? rows.length - parts.length + 1 : 0,
    lastEntry: parts.length ? rows.length : 0, partialEntries, truncated };
}
