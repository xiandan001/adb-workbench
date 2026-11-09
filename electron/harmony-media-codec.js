let messages = {};
export function setCodecMessages(value) { messages = value || {}; }
const invalid = code => new Error(messages[code] || code);

function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw invalid('H264_BYTES');
}
function annexBNals(value) {
  const bytes = bytesOf(value), starts = [];
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] || bytes[i + 1]) continue;
    const length = bytes[i + 2] === 1 ? 3 : bytes[i + 2] === 0 && bytes[i + 3] === 1 ? 4 : 0;
    if (length) { starts.push({ begin: i, payload: i + length }); i += length - 1; }
  }
  return starts.map((start, index) => bytes.subarray(start.payload, starts[index + 1]?.begin ?? bytes.length)).filter(nal => nal.length);
}
function joinNals(nals) {
  const size = nals.reduce((sum, nal) => sum + nal.length + 4, 0);
  if (size > 8 * 1024 * 1024) throw invalid('H264_SIZE');
  const result = new Uint8Array(size);
  let offset = 0;
  for (const nal of nals) { result.set([0, 0, 0, 1], offset); result.set(nal, offset + 4); offset += nal.length + 4; }
  return result;
}
export function normalizeH264(value, lengthSize = 4) {
  const bytes = bytesOf(value);
  if (annexBNals(bytes).length) return bytes;
  if (![1, 2, 4].includes(lengthSize)) throw invalid('H264_LENGTH');
  const nals = [];
  for (let offset = 0; offset < bytes.length;) {
    if (offset + lengthSize > bytes.length) throw invalid('H264_LENGTH');
    let length = 0;
    for (let i = 0; i < lengthSize; i++) length = length * 256 + bytes[offset++];
    if (!length || length > bytes.length - offset) throw invalid('H264_LENGTH');
    nals.push(bytes.subarray(offset, offset + length)); offset += length;
  }
  return joinNals(nals);
}
export function h264Configuration(value) {
  const bytes = bytesOf(value);
  let nals = annexBNals(bytes), lengthSize = 4;
  if (!nals.length && bytes[0] === 1 && bytes.length > 7) {
    lengthSize = (bytes[4] & 3) + 1;
    let offset = 6;
    const read = count => {
      for (let index = 0; index < count; index++) {
        if (offset + 2 > bytes.length) throw invalid('H264_CONFIG');
        const length = bytes[offset] * 256 + bytes[offset + 1]; offset += 2;
        if (!length || length > bytes.length - offset) throw invalid('H264_CONFIG');
        nals.push(bytes.subarray(offset, offset + length)); offset += length;
      }
    };
    read(bytes[5] & 31);
    if (offset >= bytes.length) throw invalid('H264_CONFIG');
    read(bytes[offset++]);
  }
  const sps = nals.find(nal => (nal[0] & 31) === 7);
  if (!sps || sps.length < 4) return null;
  const codec = 'avc1.' + [...sps.subarray(1, 4)].map(value => value.toString(16).padStart(2, '0')).join('');
  return { codec, lengthSize, data: joinNals(nals.filter(nal => [7, 8].includes(nal[0] & 31))) };
}
export function hasVideoSlice(value) {
  return annexBNals(value).some(nal => (nal[0] & 31) >= 1 && (nal[0] & 31) <= 5);
}
export function withConfiguration(configuration, frame) {
  const bytes = bytesOf(frame), nals = annexBNals(bytes);
  const existing = new Set(nals.map(nal => nal[0] & 31));
  const missing = annexBNals(configuration).filter(nal => [7, 8].includes(nal[0] & 31) && !existing.has(nal[0] & 31));
  if (!missing.length) return bytes;
  // AUD must remain the first NAL of an access unit. Prefixing before it creates
  // a separate parameter-only unit that Chromium correctly rejects as a keyframe.
  let position = (nals[0]?.[0] & 31) === 9 ? 1 : 0;
  if (existing.has(7) && !existing.has(8)) {
    position = Math.max(position, nals.findLastIndex(nal => (nal[0] & 31) === 7) + 1);
  }
  return joinNals([...nals.slice(0, position), ...missing, ...nals.slice(position)]);
}
