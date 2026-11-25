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
