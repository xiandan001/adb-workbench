const { tr } = require('./localization.cjs');
const { randomBytes, scrypt, createCipheriv, createDecipheriv } = require('node:crypto');
const { promisify, types } = require('node:util');
const { gzip, gunzip } = require('node:zlib');
const { validatePayload, MAX_COMPRESSED_BYTES, MAX_EXPANDED_BYTES } = require('./data-migration-archive.cjs');

const derive = promisify(scrypt); const compress = promisify(gzip); const expand = promisify(gunzip);
const MAGIC = Buffer.from('ADBWB-MIGRATION-V2\n', 'ascii');
const HEADER_LIMIT = 4096; const TAG_BYTES = 16;
const MAX_ARCHIVE_BYTES = MAX_COMPRESSED_BYTES + MAGIC.length + 4 + HEADER_LIMIT + TAG_BYTES;
const KDF = Object.freeze({ name: 'scrypt', N: 32768, r: 8, p: 1 });
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const failure = (code, message) => Object.assign(new Error(message), { code });
const invalid = () => failure('DATA_MIGRATION_V2_FORMAT', tr("备份格式或版本不受支持，原数据未修改"));
const plain = value => value !== null && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function assertPassword(password) {
  if (typeof password !== 'string' || Buffer.byteLength(password) < 8 || Buffer.byteLength(password) > 1024 || password.includes('\0') || Buffer.from(password).toString() !== password) throw failure('DATA_MIGRATION_PASSWORD', tr("备份密码需要 8–1024 UTF-8 字节，不能包含空字符或无效字符"));
  return password;
}
function isEncrypted(bytes) { return Buffer.isBuffer(bytes) && bytes.length >= MAGIC.length && bytes.subarray(0, MAGIC.length).equals(MAGIC); }
function safeJson(value) {
  const seen = new WeakSet(); let nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > 2000000 || depth > 64) throw failure('DATA_MIGRATION_LIMIT', tr("备份内容层级或数量超过安全限制"));
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item === 'string') { if (Buffer.from(item).toString() !== item) throw invalid(); return; }
    if (types.isProxy(item) || !Array.isArray(item) && !plain(item) || seen.has(item)) throw invalid();
    const array = Array.isArray(item); const keys = Reflect.ownKeys(item); const descriptors = Object.getOwnPropertyDescriptors(item);
    if (array && (Object.getPrototypeOf(item) !== Array.prototype || keys.length !== item.length + 1)) throw invalid();
    if (keys.length > 2000000 - nodes) throw failure('DATA_MIGRATION_LIMIT', tr("备份字段数量超过安全限制"));
    seen.add(item);
    try {
      for (const key of keys) {
        if (array && key === 'length') continue;
        if (typeof key !== 'string' || FORBIDDEN.has(key) || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value') || array && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= item.length)) throw invalid();
        visit(descriptors[key].value, depth + 1);
      }
    } finally { seen.delete(item); }
  };
  if (!plain(value)) throw invalid(); visit(value, 0); return value;
}
function base64(value, length) {
  if (typeof value !== 'string' || value.length > Math.ceil(length / 3) * 4) throw invalid();
  const bytes = Buffer.from(value, 'base64'); if (bytes.length !== length || bytes.toString('base64') !== value) throw invalid(); return bytes;
}
function packet(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_ARCHIVE_BYTES) throw failure('DATA_MIGRATION_LIMIT', tr("备份大小超过允许容量，未读取或截断"));
  if (!isEncrypted(bytes) || bytes.length < MAGIC.length + 4 + TAG_BYTES + 2) throw invalid();
  const length = bytes.readUInt32BE(MAGIC.length); const begin = MAGIC.length + 4; const end = begin + length;
  if (length < 2 || length > HEADER_LIMIT || end + TAG_BYTES >= bytes.length || bytes.length - end - TAG_BYTES > MAX_COMPRESSED_BYTES) throw invalid();
  let header;
  try { header = JSON.parse(bytes.subarray(begin, end).toString('utf8')); } catch { throw invalid(); }
  if (!plain(header) || Object.keys(header).sort().join(',') !== 'cipher,format,iv,kdf,salt,schemaVersion' || header.schemaVersion !== 2 || header.format !== 'adb-workbench-backup-encrypted' || header.cipher !== 'aes-256-gcm'
    || !plain(header.kdf) || Object.keys(header.kdf).sort().join(',') !== 'N,name,p,r' || Object.entries(KDF).some(([key, value]) => header.kdf[key] !== value)) throw invalid();
  return { salt: base64(header.salt, 16), iv: base64(header.iv, 12), aad: bytes.subarray(0, end), ciphertext: bytes.subarray(end, -TAG_BYTES), tag: bytes.subarray(-TAG_BYTES) };
}
async function encode(input, password) {
  assertPassword(password); safeJson(input);
  if (Object.keys(input).sort().join(',') !== 'ai,payload') throw invalid();
  const payload = validatePayload(input.payload).payload; safeJson(input.ai);
  const serialized = Buffer.from(JSON.stringify({ payload, ai: input.ai }));
  if (serialized.length > MAX_EXPANDED_BYTES) throw failure('DATA_MIGRATION_LIMIT', tr("统一备份展开后超过 256 MiB，请取消包含 AI 会话或减少数据；不会截断"));
  let compressed; let key;
  try {
    compressed = await compress(serialized); if (compressed.length > MAX_COMPRESSED_BYTES) throw failure('DATA_MIGRATION_LIMIT', tr("统一备份压缩后超过 128 MiB，请减少数据；不会截断"));
    const salt = randomBytes(16); const iv = randomBytes(12);
    const header = Buffer.from(JSON.stringify({ schemaVersion: 2, format: 'adb-workbench-backup-encrypted', cipher: 'aes-256-gcm', kdf: KDF, salt: salt.toString('base64'), iv: iv.toString('base64') }));
    const length = Buffer.alloc(4); length.writeUInt32BE(header.length); const aad = Buffer.concat([MAGIC, length, header]);
    key = await derive(password, salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 });
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad);
    return Buffer.concat([aad, cipher.update(compressed), cipher.final(), cipher.getAuthTag()]);
  } finally { key?.fill(0); serialized.fill(0); compressed?.fill(0); }
}
async function decode(bytes, password) {
  const value = packet(bytes); assertPassword(password); let key; let compressed; let serialized;
  try {
    key = await derive(password, value.salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 });
    const decipher = createDecipheriv('aes-256-gcm', key, value.iv); decipher.setAAD(value.aad); decipher.setAuthTag(value.tag);
    try { compressed = Buffer.concat([decipher.update(value.ciphertext), decipher.final()]); }
    catch { throw failure('DATA_MIGRATION_DECRYPT', tr("备份密码不正确或文件已损坏，原数据未修改")); }
    let parsed;
    try { serialized = await expand(compressed, { maxOutputLength: MAX_EXPANDED_BYTES }); parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(serialized)); }
    catch { throw failure('DATA_MIGRATION_V2_FORMAT', tr("备份内容损坏或展开后超过 256 MiB，原数据未修改")); }
    safeJson(parsed); if (Object.keys(parsed).sort().join(',') !== 'ai,payload') throw invalid(); safeJson(parsed.ai);
    return { payload: validatePayload(parsed.payload).payload, ai: parsed.ai };
  } finally { key?.fill(0); compressed?.fill(0); serialized?.fill(0); }
}

module.exports = { isEncrypted, assertPassword, encode, decode, MAX_ARCHIVE_BYTES, MAX_EXPANDED_BYTES };
