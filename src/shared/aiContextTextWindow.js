import policy from '../../electron/lib/ai-context-limits.json' with { type: 'json' };
import { tr } from './i18n.js';

export const AI_CONTEXT_BYTES = policy.contentBytes;
export const TEXT_WINDOW_UNITS = 16384;
const CHUNK = 65536, encoder = new TextEncoder();
const tooLarge = () => new Error(tr('完整 AI 材料超过 20 MiB，请减少内容后重试；原文未替换或截断。'));
const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));
const boundary = (text, index) => index > 0 && index < text.length && /[\uDC00-\uDFFF]/.test(text[index]) && /[\uD800-\uDBFF]/.test(text[index - 1]) ? index - 1 : index;

async function stringBytes(text, quoted, checkpoint) {
  if (text.length > AI_CONTEXT_BYTES) throw tooLarge();
  let bytes = quoted ? 2 : 0;
  for (let start = 0; start < text.length;) {
    const end = boundary(text, Math.min(text.length, start + CHUNK));
    const part = text.slice(start, end);
    bytes += encoder.encode(quoted ? JSON.stringify(part) : part).byteLength - (quoted ? 2 : 0);
    if (bytes > AI_CONTEXT_BYTES) throw tooLarge();
    await checkpoint(end - start); start = end;
  }
  return bytes;
}

export async function contextTextBytes(text) {
  if (typeof text !== 'string') throw new TypeError(tr('AI 材料必须是文本，原内容未更改。'));
  let work = 0;
  return stringBytes(text, false, async units => { work += units; if (work >= CHUNK * 4) { work = 0; await yieldTask(); } });
}

export async function contextPayloadBytes(value) {
  const seen = new Set(); let work = 0, total = 0;
  const checkpoint = async units => { work += units; if (work >= CHUNK * 4) { work = 0; await yieldTask(); } };
  const add = bytes => { total += bytes; if (total > AI_CONTEXT_BYTES) throw tooLarge(); };
  async function visit(item) {
    if (typeof item === 'string') { add(await stringBytes(item, true, checkpoint)); return; }
    if (item === null || typeof item !== 'object') { add(encoder.encode(JSON.stringify(item) ?? 'null').byteLength); return; }
    if (seen.has(item)) throw new TypeError(tr('AI 上下文包含循环引用，无法准备；原内容未更改。'));
    seen.add(item); add(2);
    const entries = Array.isArray(item) ? item.map((value, index) => [index, value]) : Object.entries(item).filter(([, value]) => value !== undefined && typeof value !== 'function');
    for (let index = 0; index < entries.length; index++) {
      if (index) add(1);
      if (!Array.isArray(item)) { add(await stringBytes(entries[index][0], true, checkpoint)); add(1); }
      await visit(entries[index][1]);
    }
    seen.delete(item);
  }
  await visit(value); return total;
}

export function plainTextWindow(text, requested = 0, size = TEXT_WINDOW_UNITS) {
  const count = Math.max(1, Math.ceil(text.length / size)), part = Math.max(0, Math.min(count - 1, Number.isInteger(requested) ? requested : 0));
  const start = boundary(text, part * size), end = boundary(text, Math.min(text.length, (part + 1) * size));
  return { text: text.slice(start, end), part, count, start, end };
}

export function evidenceLineIndex(text) {
  const starts = text ? [0] : [];
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) starts.push(index + 1);
  return { text, starts, count: starts.length };
}

export function evidenceTextWindow(index, { start = 0, end = index.count, part: requested = 0, numbered = false, size = TEXT_WINDOW_UNITS } = {}) {
  const rows = []; let total = 0;
  for (let line = start; line < Math.min(end, index.count); line++) {
    let begin = index.starts[line]; const finish = line + 1 < index.count ? index.starts[line + 1] - 1 : index.text.length;
    if (numbered) begin += /^\[L\d+\] ?/.exec(index.text.slice(begin, Math.min(finish, begin + 40)))?.[0].length || 0;
    const length = finish - begin; rows.push({ line: line + 1, begin, length, offset: total }); total += length + 1;
  }
  const count = Math.max(1, Math.ceil(Math.max(0, total - 1) / size)), part = Math.max(0, Math.min(count - 1, Number.isInteger(requested) ? requested : 0));
  const adjust = position => {
    const row = rows.find(row => position >= row.offset && position < row.offset + row.length);
    return row ? row.offset + boundary(index.text, row.begin + position - row.offset) - row.begin : position;
  };
  const first = adjust(part * size), last = adjust(Math.min(total, (part + 1) * size));
  return { part, count, rows: rows.flatMap(row => {
    const from = Math.max(0, first - row.offset), to = Math.min(row.length, last - row.offset);
    if (to <= from && !(row.length === 0 && row.offset >= first && row.offset < last)) return [];
    return [{ line: row.line, text: index.text.slice(row.begin + from, row.begin + to), continuedBefore: from > 0, continuedAfter: to < row.length }];
  }) };
}

export function evidencePartForLine(index, start, line, numbered = false) {
  let units = 0;
  for (let position = start; position < Math.min(index.count, line - 1); position++) {
    const from = index.starts[position], to = position + 1 < index.count ? index.starts[position + 1] - 1 : index.text.length;
    const prefix = numbered ? /^\[L\d+\] ?/.exec(index.text.slice(from, Math.min(to, from + 32)))?.[0].length || 0 : 0;
    units += to - from - prefix + 1;
  }
  return Math.floor(units / TEXT_WINDOW_UNITS);
}

