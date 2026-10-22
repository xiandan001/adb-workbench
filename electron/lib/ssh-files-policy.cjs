const path = require('node:path');
const { createHash } = require('node:crypto');

const PAGE_BYTES = 256 * 1024;
const EDIT_BYTES = 2 * 1024 * 1024;
const IMAGE_BYTES = 12 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const MAX_ENTRIES = 10000;
const MAX_DEPTH = 64;

function fail(code, message) { return Object.assign(new Error(message), { code }); }
function remotePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0') || value.length > 8192 || value.split('/').includes('..')) throw fail('SFTP_PATH_INVALID', '远端路径无效，请使用绝对路径且不要包含 ..');
  return path.posix.normalize(value);
}
function remoteName(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[/\0]/.test(value) || Buffer.byteLength(value) > 255) throw fail('SFTP_NAME_INVALID', '文件名称无效');
  return value;
}
function localName(value) {
  remoteName(value);
  if (/[<>:"/\\|?*]/.test(value) || Array.from(value).some(character => character.charCodeAt(0) < 32) || /[. ]$/.test(value) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) throw fail('SFTP_LOCAL_NAME_INVALID', `本地系统不支持文件名称：${value}`);
  return value;
}
function localPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw fail('SFTP_LOCAL_PATH_INVALID', '本地路径无效，请重新选择文件或目录');
  return path.resolve(value);
}
function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function typeOf(stat) {
  const type = stat.mode & 0o170000;
  if (stat.isSymbolicLink?.() || type === 0o120000) return 'symlink';
  if (stat.isDirectory?.() || type === 0o040000) return 'directory';
  if (stat.isFile?.() || type === 0o100000) return 'file';
  return 'special';
}
function metadata(stat) { return { type: typeOf(stat), size: stat.size, mtime: stat.mtime, mode: stat.mode }; }
function sameMetadata(a, b) { return ['type', 'size', 'mtime', 'mode'].every(key => a[key] === b[key]); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function revision(stat, hash) { return digest(JSON.stringify({ ...metadata(stat), hash })); }
function isMissing(error) { return error?.code === 2 || error?.code === 'ENOENT'; }
function textBytes(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > EDIT_BYTES || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) throw fail('SFTP_TEXT_INVALID', '文本内容无效或超过 2 MiB 编辑限制');
  return Buffer.from(text, 'utf8');
}
function decodeText(bytes) {
  if (bytes.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
}
function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function safeImageDimensions(bytes, mime) {
  let width = 0; let height = 0;
  if (mime === 'image/png' && bytes.length >= 24 && bytes.toString('ascii', 12, 16) === 'IHDR') { width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); }
  else if (mime === 'image/gif' && bytes.length >= 10) { width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8); }
  else if (mime === 'image/webp' && bytes.length >= 30) {
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X') { width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3); }
    else if (kind === 'VP8L' && bytes[20] === 0x2f) { const bits = bytes.readUInt32LE(21); width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff); }
    else if (kind === 'VP8 ' && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) { width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff; }
  } else if (mime === 'image/jpeg') {
    let offset = 2;
    while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda || offset + 2 > bytes.length) break;
      if (marker >= 0xd0 && marker <= 0xd8) continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) { height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break; }
      offset += length;
    }
  }
  return width > 0 && height > 0 && width <= 32768 && height <= 32768 && width * height <= 40000000;
}

module.exports = { PAGE_BYTES, EDIT_BYTES, IMAGE_BYTES, CHUNK_BYTES, MAX_ENTRIES, MAX_DEPTH, fail, remotePath, remoteName, localName, localPath, within, typeOf, metadata, sameMetadata, digest, revision, isMissing, textBytes, decodeText, imageMime, safeImageDimensions };
