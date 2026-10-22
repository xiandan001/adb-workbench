function hexPairs(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new Error('HEX 原始数据必须为连续、成对的十六进制字符');
  }
  return hex.toUpperCase().match(/.{2}/g) || [];
}

function formatHex(hex) {
  return hexPairs(hex).join(' ');
}

function formatAscii(hex) {
  return hexPairs(hex).map(pair => {
    const byte = Number.parseInt(pair, 16);
    if (byte === 9) return '\\t';
    if (byte === 10) return '\\n';
    if (byte === 13) return '\\r';
    if (byte === 92) return '\\\\';
    return byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '\\x' + pair;
  }).join('');
}

module.exports = { formatHex, formatAscii };
