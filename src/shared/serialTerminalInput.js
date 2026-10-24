import { tr } from './i18n.js';
export const MAX_TERMINAL_INPUT_BYTES = 64 * 1024;
export const TERMINAL_BATCH_BYTES = 512;
const encoder = new TextEncoder();
const ENDINGS = { cr: '\r', lf: '\n', crlf: '\r\n' };

export function terminalInputBytes(content) {
  if (typeof content !== 'string') throw new Error(tr("终端输入必须是文本"));
  if (content.length > MAX_TERMINAL_INPUT_BYTES) throw new Error(tr("单次终端输入不能超过 64 KiB"));
  const size = encoder.encode(content).length;
  if (size > MAX_TERMINAL_INPUT_BYTES) throw new Error(tr("单次终端输入不能超过 64 KiB"));
  return size;
}

export function splitTerminalInput(content, maxBytes = TERMINAL_BATCH_BYTES) {
  terminalInputBytes(content);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > TERMINAL_BATCH_BYTES) throw new Error(tr("终端输入分批上限无效"));
  const chunks = [];
  let chunk = '';
  let size = 0;
  for (const character of content) {
    const length = encoder.encode(character).length;
    if (size + length > maxBytes) { chunks.push(chunk); chunk = ''; size = 0; }
    chunk += character;
    size += length;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export function normalizeTerminalNewlines(content, enter = 'cr') {
  return content.replace(/\r\n|\r|\n/g, ENDINGS[enter] || ENDINGS.cr);
}

export function mapTerminalKey(data, event = {}, settings = {}) {
  if (event.altKey || event.ctrlKey || event.metaKey) return data;
  if (event.key === 'Enter' && ['\r', '\n', '\r\n'].includes(data)) return ENDINGS[settings.enter] || ENDINGS.cr;
  if (event.key === 'Backspace' && ['\x08', '\x7f'].includes(data)) return settings.backspace === 'bs' ? '\x08' : '\x7f';
  return data;
}

export function prepareTerminalPaste(content, enter = 'cr') {
  terminalInputBytes(content);
  const normalized = normalizeTerminalNewlines(content, enter);
  const bytes = terminalInputBytes(normalized);
  const requiresConfirmation = [...content].some(character => {
    const code = character.charCodeAt(0);
    return (code < 32 && code !== 9) || (code >= 127 && code <= 159);
  });
  return { content: normalized, bytes, requiresConfirmation };
}

// Local echo is display-only. Escape/control bytes must not become terminal queries.
export function localEchoTerminalInput(content) {
  return [...normalizeTerminalNewlines(content, 'lf')].map(character => {
    const code = character.charCodeAt(0);
    if (code === 10) return '\r\n';
    if (code === 8 || code === 127) return '\b \b';
    if (code === 3) return '^C\r\n';
    if (code === 9) return '\t';
    if (code >= 128 && code <= 159) return `\\x${code.toString(16).toUpperCase()}`;
    return code < 32 ? `^${String.fromCharCode(code + 64)}` : character;
  }).join('');
}
