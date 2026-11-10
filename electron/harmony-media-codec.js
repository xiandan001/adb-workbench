let messages = {};
export function setCodecMessages(value) { messages = value || {}; }
const invalid = code => new Error(messages[code] || code);
const MAX_BYTES = 8 * 1024 * 1024, MAX_NALS = 4096, MAX_PARAMETER_BYTES = 64 * 1024;

function bytesOf(value) {
  if (ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]') {
    if (!value.byteLength || value.byteLength > MAX_BYTES) throw invalid('H264_SIZE');
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return bytesOf(new Uint8Array(value));
  throw invalid('H264_BYTES');
}
function annexBNals(value) {
  const bytes = bytesOf(value), starts = [];
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] || bytes[i + 1]) continue;
    const length = bytes[i + 2] === 1 ? 3 : bytes[i + 2] === 0 && bytes[i + 3] === 1 ? 4 : 0;
    if (length) { starts.push({ begin: i, payload: i + length }); i += length - 1; }
    if (starts.length > MAX_NALS) throw invalid('H264_SIZE');
  }
  if (!starts.length || bytes.subarray(0, starts[0].begin).some(byte => byte !== 0)) throw invalid('H264_LENGTH');
  return validateNals(starts.map((start, index) => bytes.subarray(start.payload, starts[index + 1]?.begin ?? bytes.length)));
}
function validateNals(nals) {
  if (!nals.length || nals.length > MAX_NALS || nals.some(nal => !nal.length || nal[0] & 0x80 || !(nal[0] & 31) || (nal[0] & 31) > 23)) throw invalid('H264_CONFIG');
  return nals;
}
function joinNals(nals) {
  const size = nals.reduce((sum, nal) => sum + nal.length + 4, 0);
  if (size > MAX_BYTES) throw invalid('H264_SIZE');
  const result = new Uint8Array(size);
  let offset = 0;
  for (const nal of nals) { result.set([0, 0, 0, 1], offset); result.set(nal, offset + 4); offset += nal.length + 4; }
  return result;
}
function lengthNals(bytes, lengthSize) {
  if (![1, 2, 4].includes(lengthSize)) throw invalid('H264_LENGTH');
  const nals = [];
  for (let offset = 0; offset < bytes.length;) {
    if (offset + lengthSize > bytes.length) throw invalid('H264_LENGTH');
    let length = 0;
    for (let i = 0; i < lengthSize; i++) length = length * 256 + bytes[offset++];
    if (!length || length > bytes.length - offset) throw invalid('H264_LENGTH');
    nals.push(bytes.subarray(offset, offset + length)); offset += length;
    if (nals.length > MAX_NALS) throw invalid('H264_SIZE');
  }
  return validateNals(nals);
}
function parseRecord(bytes) {
  if (bytes[0] === 1 && bytes.length >= 7 && (bytes[4] & 0xfc) === 0xfc && (bytes[5] & 0xe0) === 0xe0) {
    const lengthSize = (bytes[4] & 3) + 1, nals = [];
    if (![1, 2, 4].includes(lengthSize)) throw invalid('H264_LENGTH');
    let offset = 6;
    const read = (count, type) => {
      for (let index = 0; index < count; index++) {
        if (offset + 2 > bytes.length) throw invalid('H264_CONFIG');
        const length = bytes[offset] * 256 + bytes[offset + 1]; offset += 2;
        if (!length || length > bytes.length - offset) throw invalid('H264_CONFIG');
        if ((bytes[offset] & 31) !== type) throw invalid('H264_CONFIG');
        nals.push(bytes.subarray(offset, offset + length)); offset += length;
      }
    };
    read(bytes[5] & 31, 7);
    if (offset >= bytes.length) throw invalid('H264_CONFIG');
    read(bytes[offset++], 8);
    if (offset < bytes.length && [100, 110, 122, 144, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(bytes[1])) {
      if (offset + 4 > bytes.length || (bytes[offset] & 0xfc) !== 0xfc || (bytes[offset + 1] & 0xf8) !== 0xf8 || (bytes[offset + 2] & 0xf8) !== 0xf8) throw invalid('H264_CONFIG');
      offset += 3; read(bytes[offset++], 13);
    }
    if (offset !== bytes.length) throw invalid('H264_CONFIG');
    return { nals: validateNals(nals), lengthSize };
  }
  return null;
}
function packetNals(bytes, lengthSize = 4, explicitLength = false) {
  if (explicitLength) return lengthNals(bytes, lengthSize);
  // Fully validated length framing wins over an incidental 00 00 01 in a size.
  try { return lengthNals(bytes, lengthSize); } catch { return annexBNals(bytes); }
}
export function normalizeH264(value, lengthSize = 4) {
  return joinNals(packetNals(bytesOf(value), lengthSize));
}
function configurationOf(nals, lengthSize = 4) {
  const sps = nals.find(nal => (nal[0] & 31) === 7);
  if (!sps || sps.length < 4) return null;
  const codec = 'avc1.' + [...sps.subarray(1, 4)].map(value => value.toString(16).padStart(2, '0')).join('');
  return { codec, lengthSize, data: joinNals(nals.filter(nal => [7, 8].includes(nal[0] & 31))) };
}
export function h264Configuration(value) {
  const bytes = bytesOf(value), record = parseRecord(bytes);
  return configurationOf(record?.nals || packetNals(bytes), record?.lengthSize || 4);
}

function parameterId(nal) {
  const rbsp = [];
  for (let i = 1; i < nal.length; i++) {
    if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    rbsp.push(nal[i]);
  }
  let bit = (nal[0] & 31) === 7 ? 24 : 0, zeros = 0;
  const next = () => { if (bit >= rbsp.length * 8) throw invalid('H264_CONFIG'); return (rbsp[bit >> 3] >> (7 - (bit++ & 7))) & 1; };
  while (!next()) { if (++zeros > 8) throw invalid('H264_CONFIG'); }
  let id = 1;
  for (let i = 0; i < zeros; i++) id = id * 2 + next();
  id--;
  if (id > ((nal[0] & 31) === 7 ? 31 : 255)) throw invalid('H264_CONFIG');
  return id;
}
export function createH264StreamState() {
  const sps = new Map(), pps = new Map();
  let lengthSize = 4, explicitLength = false, revision = 0, parameterBytes = 0;
  return { push(value) {
    const bytes = bytesOf(value), record = parseRecord(bytes);
    if (record) { lengthSize = record.lengthSize; explicitLength = true; }
    const nals = record?.nals || packetNals(bytes, lengthSize, explicitLength);
    for (const nal of nals) {
      const type = nal[0] & 31;
      if (type !== 7 && type !== 8) continue;
      if (nal.length > MAX_PARAMETER_BYTES) throw invalid('H264_SIZE');
      const parameters = type === 7 ? sps : pps, id = parameterId(nal), previous = parameters.get(id);
      if (!previous || previous.length !== nal.length || previous.some((byte, index) => byte !== nal[index])) {
        const nextBytes = parameterBytes - (previous?.length || 0) + nal.length;
        if (nextBytes > MAX_PARAMETER_BYTES) throw invalid('H264_SIZE');
        parameters.set(id, nal.slice()); parameterBytes = nextBytes; revision++;
      }
    }
    const parameters = [...sps.values(), ...pps.values()];
    const configuration = sps.size && pps.size ? { ...configurationOf(parameters, lengthSize), revision } : null;
    return { data: record ? new Uint8Array() : joinNals(nals), configuration, sps: sps.size > 0, pps: pps.size > 0,
      key: !record && nals.some(nal => (nal[0] & 31) === 5), hasVideo: !record && nals.some(nal => (nal[0] & 31) >= 1 && (nal[0] & 31) <= 5) };
  } };
}
export function hasVideoSlice(value) {
  return annexBNals(value).some(nal => (nal[0] & 31) >= 1 && (nal[0] & 31) <= 5);
}
export function withConfiguration(configuration, frame) {
  const bytes = bytesOf(frame), nals = annexBNals(bytes);
  const existing = new Set(nals.map(nal => nal[0] & 31));
  const missing = annexBNals(configuration).filter(nal => [7, 8].includes(nal[0] & 31)
    && !nals.some(present => present.length === nal.length && present.every((byte, index) => byte === nal[index])));
  if (!missing.length) return bytes;
  // AUD must remain the first NAL of an access unit. Prefixing before it creates
  // a separate parameter-only unit that Chromium correctly rejects as a keyframe.
  let position = (nals[0]?.[0] & 31) === 9 ? 1 : 0;
  if (existing.has(7) && missing.every(nal => (nal[0] & 31) === 8)) {
    position = Math.max(position, nals.findLastIndex(nal => (nal[0] & 31) === 7) + 1);
  }
  return joinNals([...nals.slice(0, position), ...missing, ...nals.slice(position)]);
}
