const { formatHex, formatAscii } = require('./serial-format.cjs');
const { contentBytes } = require('./ai-context-limits.json');

function formatSerialEvidenceRow(row) {
  return `[${row.time}] ${row.direction} ${row.bytes} bytes | HEX: ${formatHex(row.hex)} | ASCII: ${formatAscii(row.hex)}`;
}

function captureSerialEvidenceRows(rows, { maxRecords = 2000, maxBytes = contentBytes } = {}) {
  const parts = []; let bytes = 0;
  for (let index = rows.length - 1; index >= 0 && parts.length < maxRecords; index--) {
    const part = formatSerialEvidenceRow(rows[index]);
    const size = Buffer.byteLength(part) + (parts.length ? 1 : 0);
    // A binary frame is an indivisible evidence record, including all its HEX.
    if (bytes + size > maxBytes) break;
    parts.push(part); bytes += size;
  }
  const truncated = parts.length < rows.length;
  return { text: parts.reverse().join('\n'), truncated,
    ...(truncated ? { windowInfo: { originalRecords: rows.length, retainedRecords: parts.length, byteLimit: maxBytes } } : {}) };
}

function selectSerialEvidenceInput(rows, { maxRecords = 2000, maxBytes = contentBytes } = {}) {
  let start = rows.length, bytes = 0;
  while (start > 0 && rows.length - start < maxRecords) {
    const size = rows[start - 1].bytes;
    // HEX alone needs nearly three printable bytes per original byte. Do not
    // clone a complete ring when the selected source window cannot retain it.
    if (bytes + size > Math.floor(maxBytes / 3)) break;
    bytes += size; start--;
  }
  return { rows: rows.slice(start), maxRecords, maxBytes, originalRecords: rows.length };
}

module.exports = { formatSerialEvidenceRow, captureSerialEvidenceRows, selectSerialEvidenceInput };
