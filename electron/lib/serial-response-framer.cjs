const { tr } = require('./localization.cjs');
const AB_HEADER = 0xab;
const XBH_HEADER = 0xfe;
const XBH_SIGNATURE = [0x58, 0x42, 0x48, 0x43, 0x4d, 0x44];
// CRC-16/CCITT: poly 0x1021, init 0xffff, non-reflected, no final XOR.
const CRC_NIBBLES = [
  0x0000, 0x1021, 0x2042, 0x3063, 0x4084, 0x50a5, 0x60c6, 0x70e7,
  0x8108, 0x9129, 0xa14a, 0xb16b, 0xc18c, 0xd1ad, 0xe1ce, 0xf1ef
];

function crcMatches(bytes, start, length) {
  let crc = 0xffff;
  const checksum = start + length - 2;
  for (let index = start; index < checksum; index++) {
    crc = ((crc << 4) & 0xffff) ^ CRC_NIBBLES[(crc >>> 12) ^ (bytes[index] >>> 4)];
    crc = ((crc << 4) & 0xffff) ^ CRC_NIBBLES[(crc >>> 12) ^ (bytes[index] & 0x0f)];
  }
  return crc === bytes.readUInt16BE(checksum);
}

function candidateAt(bytes, start) {
  const header = bytes[start];
  if (header !== AB_HEADER && header !== XBH_HEADER) return null;
  const protocol = header === AB_HEADER ? 'ab' : 'xbh';
  const declared = bytes[start + 1];
  if (declared === undefined) return { protocol };
  if (declared < (protocol === 'ab' ? 5 : 8)) return null;
  if (protocol === 'xbh') {
    // Validate every available signature byte before waiting on a long candidate.
    for (let index = 0; index < XBH_SIGNATURE.length && start + index + 2 < bytes.length; index++) {
      if (bytes[start + index + 2] !== XBH_SIGNATURE[index]) return null;
    }
  }
  return { protocol, length: protocol === 'ab' ? declared : declared + 3 };
}

function appendSegment(segments, kind, bytes, start, end, protocol) {
  if (start < end) segments.push({ kind, ...(protocol ? { protocol } : {}), bytes: Buffer.from(bytes.subarray(start, end)) });
}

// Stateless ordinary AB / XBHCMD framing. AB uses CRC; XBHCMD uses its fixed
// signature and declared tail, not CRC. Unknown bytes retain their original order.
function splitSerialResponses(bytes, { final = false } = {}) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new TypeError(tr("串口分帧输入必须是 Buffer 或 Uint8Array"));
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const segments = [];
  let rawStart = 0;
  let offset = 0;
  while (offset < input.length) {
    const candidate = candidateAt(input, offset);
    if (!candidate) { offset++; continue; }
    const { length, protocol } = candidate;
    if (length === undefined || input.length - offset < length) {
      if (final) { offset++; continue; }
      appendSegment(segments, 'raw', input, rawStart, offset);
      appendSegment(segments, 'pending', input, offset, input.length, protocol);
      return segments;
    }
    const valid = protocol === 'ab' ? crcMatches(input, offset, length) : input[offset + length - 1] === 0xcf;
    if (!valid) { offset++; continue; }
    appendSegment(segments, 'raw', input, rawStart, offset);
    appendSegment(segments, 'frame', input, offset, offset + length, protocol);
    offset += length;
    rawStart = offset;
  }
  appendSegment(segments, 'raw', input, rawStart, input.length);
  return segments;
}

module.exports = { splitSerialResponses };
