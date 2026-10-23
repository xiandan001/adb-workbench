const path = require('node:path');
const { readSafe, checksum, fail } = require('./ai-tools-file-safety.cjs');

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const clone = value => structuredClone(value);
function exact(value, keys, label) {
  if (!plain(value) || Object.keys(value).some(key => !keys.includes(key))) throw fail('AI_TOOLS_MIGRATION_FORMAT', `${label}结构无效`);
  return value;
}
function text(value, max, label, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw fail('AI_TOOLS_MIGRATION_FORMAT', `${label}无效`);
  return value;
}
function requireEncryption({ canEncrypt, encrypt, decrypt }) {
  let available = false;
  try { available = Boolean(canEncrypt?.()) && typeof encrypt === 'function' && typeof decrypt === 'function'; } catch { /* Fail closed. */ }
  if (!available) throw fail('AI_TOOLS_ENCRYPTION_UNAVAILABLE', '系统安全加密不可用，无法完整迁移 AI 数据；不会忽略内存或已加密内容');
}
function encodeState(value, encryption, limit) {
  requireEncryption(encryption);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > limit) throw fail('AI_TOOLS_MIGRATION_LIMIT', 'AI 数据超过容量限制，未导入或截断');
  let cipher;
  try { cipher = encryption.encrypt(serialized); if (!Buffer.isBuffer(cipher) || !cipher.length) throw new Error('Cipher'); }
  catch { throw fail('AI_TOOLS_ENCRYPTION_FAILED', 'AI 迁移数据加密失败，未修改原文件'); }
  const bytes = Buffer.from(`${JSON.stringify({ version: 1, encrypted: cipher.toString('base64') })}\n`);
  if (bytes.length > limit) throw fail('AI_TOOLS_MIGRATION_LIMIT', 'AI 密文超过容量限制，未导入或截断');
  return bytes;
}
function prepareStateWrite(file, next, expectedHash, encryption, limit) {
  const current = readSafe(file, undefined, limit);
  if (current.hash !== expectedHash) throw fail('AI_TOOLS_MIGRATION_CHANGED', 'AI 数据在预览时已变化，请重新预览');
  const after = encodeState(next, encryption, limit);
  return { path: file, beforeHash: current.hash, after, afterHash: checksum(after), limit };
}
function validatePortableList(value, field, max, label) {
  exact(value, ['version', field], label);
  if (value.version !== 1 || !Array.isArray(value[field]) || value[field].length > max) throw fail('AI_TOOLS_MIGRATION_FORMAT', `${label}版本或条目数无效`);
  return value[field];
}
function portablePathHint(value) {
  text(value, 4096, '来源项目路径');
  if (!path.isAbsolute(value) && !path.win32.isAbsolute(value)) throw fail('AI_TOOLS_MIGRATION_FORMAT', '来源项目路径必须为绝对路径提示');
  return value;
}

module.exports = { UUID, HASH, plain, exact, text, clone, requireEncryption, encodeState, prepareStateWrite, validatePortableList, portablePathHint };
