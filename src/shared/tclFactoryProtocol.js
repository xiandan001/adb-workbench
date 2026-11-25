import catalog from '../../electron/lib/rs232-protocol-tcl.json' with { type: 'json' };

const knownShortOpcodes = new Set(catalog.commands.filter(command => !command.needsReview && !command.template.startsWith('AA FE '))
  .map(command => parseInt(command.template.split(' ')[2], 16)));
const hexByte = byte => byte.toString(16).padStart(2, '0').toUpperCase();

export function tclLengthToken(tokens, index) {
  if (tokens[index] === 'LL' && index === 1) return true;
  if (tokens[1]?.toUpperCase() !== 'FE') return false;
  return index === 2 && tokens[index] === 'LH' && tokens[3] === 'LL' ||
    index === 3 && tokens[index] === 'LL' && tokens[2] === 'LH';
}

export function tclCrcToken(tokens, index) {
  return tokens.at(-2) === 'CRC1' && tokens.at(-1) === 'CRC2' && index >= tokens.length - 2;
}

function crc16(bytes) {
  let value = 0xffff;
  for (let index = 0; index < bytes.length - 2; index++) {
    value ^= bytes[index] << 8;
    for (let bit = 0; bit < 8; bit++) value = ((value << 1) ^ (value & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return value;
}

export function completeTclFrame(tokens, bytes) {
  if (bytes[0] !== 0xaa || bytes.length < 5 || bytes.length > 0xffff) return false;
  const length = bytes[1];
  if (length === 0xfe) {
    if (bytes.length < 256) return false;
    if (tokens[2] === 'LH') { bytes[2] = bytes.length >>> 8; bytes[3] = bytes.length & 0xff; }
    if ((bytes[2] << 8 | bytes[3]) !== bytes.length) return false;
  } else {
    if (bytes.length >= 0xfe) return false;
    if (tokens[1] === 'LL') bytes[1] = bytes.length;
    if (bytes[1] !== bytes.length) return false;
  }
  const checksum = crc16(bytes);
  if (tclCrcToken(tokens, tokens.length - 1)) {
    bytes[bytes.length - 2] = checksum >>> 8;
    bytes[bytes.length - 1] = checksum & 0xff;
  }
  return (bytes.at(-2) << 8 | bytes.at(-1)) === checksum;
}

function readManualShortFrame(content) {
  if (typeof content !== 'string' || content.length > 2048 || !/^\s*AA/i.test(content)) return null;
  let text = content.trim();
  const suffix = /\s+CRC1\s+CRC2$/i.exec(text);
  if (suffix) text = text.slice(0, suffix.index);
  const tokens = text.split(/\s+/u);
  if (tokens.some(token => token.length % 2 || !/^[0-9a-f]+$/i.test(token))) return null;
  const packed = tokens.join('');
  if (packed.length < 6 || packed.length > 0xfd * 2) return null;
  const bytes = Array.from({ length: packed.length / 2 }, (_, index) => parseInt(packed.slice(index * 2, index * 2 + 2), 16));
  if (bytes[0] !== 0xaa || bytes[1] < 5 || bytes[1] >= 0xfe) return null;
  return { bytes, explicit: Boolean(suffix) };
}

function manualResult(bytes) {
  const parts = bytes.map(hexByte);
  return { hex: parts.join(' '), crc: parts.slice(-2).join(' ') };
}

function finishManualBody(bytes) {
  bytes.push(0, 0);
  return completeTclFrame(['CRC1', 'CRC2'], bytes) ? manualResult(bytes) : null;
}

// Infer only one recognized short TCL request with both checksum bytes absent.
// Explicit CRC placeholders also permit a documented/custom short opcode.
export function completeManualTclHex(content) {
  const frame = readManualShortFrame(content);
  if (!frame || frame.bytes[1] !== frame.bytes.length + 2 || !frame.explicit && !knownShortOpcodes.has(frame.bytes[2])) return null;
  return finishManualBody(frame.bytes);
}

// The dedicated TCL editor is explicit, so a well-formed custom opcode is allowed.
export function previewManualTclHex(content) {
  const frame = readManualShortFrame(content);
  if (!frame) return null;
  const { bytes, explicit } = frame;
  if (bytes[1] === bytes.length + 2) return finishManualBody(bytes);
  if (explicit || bytes[1] !== bytes.length) return null;
  return { ...manualResult(bytes), crcProvided: true, crcValid: completeTclFrame([], bytes) };
}
