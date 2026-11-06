const fs = require('node:fs/promises');
const { StringDecoder } = require('node:string_decoder');
const { tr } = require('./localization.cjs');

const WINDOW_MS = 10000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_LINE_CHARS = 256 * 1024;
const MAX_ENTRIES = 20;
const MAX_SOURCE_CHARS = 12000;
const MAX_TOTAL_CHARS = 60000;

function recordNearMarker(value, marker, performanceFile, clockUncertain) {
  if (!value || typeof value !== 'object') return null;
  if (performanceFile ? !value.snapshot || typeof value.snapshot !== 'object' : value.sourceTime !== 'host-receipt' || typeof value.text !== 'string') return null;
  const monotonic = Number.isFinite(value.offsetMs) && value.offsetMs >= 0;
  if (!monotonic && (clockUncertain || !Number.isFinite(value.at))) return null;
  const relativeMs = monotonic ? value.offsetMs - marker.offsetMs : value.at - marker.at;
  if (Math.abs(relativeMs) > WINDOW_MS) return null;
  const fullText = performanceFile ? JSON.stringify(value.snapshot, null, 2) : value.text;
  return { at: Number.isFinite(value.at) ? value.at : null, relativeMs, clockBasis: monotonic ? 'host-monotonic' : 'host-wall',
    text: fullText.slice(0, 2000), truncated: fullText.length > 2000 };
}

async function scanSource(store, session, file, marker, budget, clockUncertain) {
  const result = { name: file.name, label: file.label, entries: [], scannedBytes: 0, truncated: Boolean(file.truncated), malformed: 0, unaligned: 0 };
  if (file.name === 'device.log') return { ...result, clockBasis: 'device-unsynchronized' };
  if (!budget.bytes || budget.chars <= 0) return { ...result, truncated: true };
  const handle = await fs.open(await store.filePath(session.id, file.name, true), 'r');
  try {
    const size = (await handle.stat()).size;
    const limit = Math.min(size, MAX_FILE_BYTES, budget.bytes);
    const buffer = Buffer.alloc(Math.min(64 * 1024, limit));
    const decoder = new StringDecoder('utf8');
    let pending = '', droppingLine = false;
    const consume = line => {
      if (!line.trim()) return;
      if (line.length > MAX_LINE_CHARS) { result.truncated = true; return; }
      let value;
      try { value = JSON.parse(line); } catch { result.malformed++; return; }
      if (!Number.isFinite(value?.offsetMs) && clockUncertain) result.unaligned++;
      const entry = recordNearMarker(value, marker, file.name === 'performance.jsonl', clockUncertain);
      if (!entry) return;
      result.entries.push(entry);
      result.entries.sort((a, b) => Math.abs(a.relativeMs) - Math.abs(b.relativeMs));
      if (result.entries.length > MAX_ENTRIES) { result.entries.pop(); result.truncated = true; }
    };
    while (result.scannedBytes < limit) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, limit - result.scannedBytes), result.scannedBytes);
      if (!bytesRead) break;
      result.scannedBytes += bytesRead;
      budget.bytes -= bytesRead;
      const parts = decoder.write(buffer.subarray(0, bytesRead)).split('\n');
      for (let index = 0; index < parts.length; index++) {
        if (!droppingLine) pending += parts[index];
        if (pending.length > MAX_LINE_CHARS) { pending = ''; droppingLine = true; result.truncated = true; }
        if (index < parts.length - 1) {
          if (!droppingLine) consume(pending);
          pending = ''; droppingLine = false;
        }
      }
      await new Promise(resolve => setImmediate(resolve));
    }
    if (result.scannedBytes === size && !droppingLine) consume(pending + decoder.end());
    else if (pending || droppingLine || result.scannedBytes < size) result.truncated = true;
    let remaining = Math.min(MAX_SOURCE_CHARS, budget.chars);
    const retained = [];
    for (const entry of result.entries) {
      if (!remaining) { result.truncated = true; break; }
      const text = entry.text.slice(0, remaining);
      const truncated = entry.truncated || text.length < entry.text.length;
      result.truncated ||= truncated;
      retained.push({ ...entry, text, truncated });
      remaining -= text.length;
      budget.chars -= text.length;
    }
    result.entries = retained.sort((a, b) => a.relativeMs - b.relativeMs);
    return result;
  } finally { await handle.close(); }
}

async function readMarkerNeighborhood(store, session, markerId) {
  const marker = session.markers.find(item => item.id === markerId);
  if (!marker) throw new Error(tr('所选问题标记不存在，未读取其他证据。'));
  const clockUncertain = Math.abs(marker.at - session.startedAt - marker.offsetMs) > 2000;
  const budget = { bytes: MAX_TOTAL_BYTES, chars: MAX_TOTAL_CHARS };
  const files = session.files.filter(file => file.name === 'device.log' || file.name.endsWith('.jsonl'));
  // Performance is small and useful even when a large terminal stream exhausts the scan budget.
  files.sort((a, b) => Number(b.name === 'performance.jsonl') - Number(a.name === 'performance.jsonl'));
  const sources = [];
  for (const file of files) {
    try { sources.push(await scanSource(store, session, file, marker, budget, clockUncertain)); }
    catch { sources.push({ name: file.name, label: file.label, entries: [], error: tr('证据文件无法读取，原文件未修改。') }); }
  }
  return { marker, windowMs: WINDOW_MS, clockUncertain, scannedBytes: MAX_TOTAL_BYTES - budget.bytes, sources };
}

module.exports = { readMarkerNeighborhood, recordNearMarker, WINDOW_MS, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_TOTAL_CHARS };
