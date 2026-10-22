// This is transient editing validation only. Executed history comes from the
// main process's authenticated shell markers, never from terminal keystrokes.
const safeText = value => typeof value === 'string' && value.length <= 4096
  && !Array.from(value).some(char => { const code = char.codePointAt(0); return code < 32 || (code >= 127 && code <= 159); });

export function inlineSuffix(prefix, command) {
  return safeText(prefix) && safeText(command) && command.startsWith(prefix) && command.length > prefix.length ? command.slice(prefix.length) : null;
}

export function inlineCandidates(entries, prefix) {
  if (!prefix || !safeText(prefix)) return [];
  const seen = new Set(); const result = [];
  for (const entry of entries || []) {
    if (inlineSuffix(prefix, entry.command) === null || seen.has(entry.command)) continue;
    seen.add(entry.command); result.push(entry);
    if (result.length === 8) break;
  }
  return result;
}

export function advanceInlineInput(expected, input) {
  if (expected === null || typeof input !== 'string') return null;
  if (input === '\x7f' || input === '\x08') {
    // Readline's Unicode/grapheme deletion can differ from JS slicing.
    return !expected || /^[\x20-\x7e]$/.test(expected.at(-1)) ? expected.slice(0, -1) : null;
  }
  const next = expected + input;
  return safeText(input) && safeText(next) ? next : null;
}

export function readInlinePrefix({ active, focused, replaying, shell, boundary, buffer, expected, writer }) {
  if (!active || !focused || replaying || expected === null || !writer || writer.queuedBytes || writer.inFlight || writer.paused
    || shell?.status !== 'ready' || shell.phase !== 'prompt' || !boundary || shell.promptId !== boundary.promptId || buffer?.type !== 'normal') return null;
  const row = buffer.baseY + buffer.cursorY;
  if (!Number.isInteger(boundary.row) || boundary.row < 0 || row < boundary.row || row - boundary.row > 32 || boundary.column < 0) return null;
  let prefix = '';
  for (let index = boundary.row; index <= row; index++) {
    const line = buffer.getLine(index);
    if (!line || (index !== boundary.row && !line.isWrapped)) return null;
    const start = index === boundary.row ? boundary.column : 0;
    if (index === row && buffer.cursorX < start) return null;
    prefix += line.translateToString(false, start, index === row ? buffer.cursorX : undefined);
    if (prefix.length > 4096) return null;
  }
  if (buffer.getLine(row).translateToString(true, buffer.cursorX).length || !safeText(prefix) || prefix !== expected) return null;
  return prefix;
}

export function inlineKey(key, index, count) {
  if (!count) return { action: 'native', consume: false };
  if (key === 'ArrowDown' || key === 'ArrowUp') return { action: 'select', index: (index + (key === 'ArrowDown' ? 1 : -1) + count) % count, consume: true };
  if (key === 'Tab') return { action: 'accept', consume: true };
  if (key === 'Escape') return { action: 'dismiss', consume: true };
  return { action: key === 'Enter' ? 'dismiss' : 'native', consume: false };
}

export function inlinePlacement({ x, y, lineHeight, width, height, viewportWidth, viewportHeight }) {
  const actualWidth = Math.max(0, Math.min(width, viewportWidth - 16));
  const actualHeight = Math.max(0, Math.min(height, viewportHeight - 16));
  return { left: Math.max(8, Math.min(x, viewportWidth - actualWidth - 8)),
    top: Math.max(8, Math.min(y + lineHeight + actualHeight > viewportHeight - 8 ? y - actualHeight : y + lineHeight, viewportHeight - actualHeight - 8)),
    width: actualWidth, maxHeight: actualHeight };
}
