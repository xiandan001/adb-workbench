const { tr } = require('./localization.cjs');
const { createHash } = require('node:crypto');

const MIB = 1024 * 1024;
const MAX_AI_FILES = 600;
const FIXED = new Map([
  ['ai-tools/ai-tools-store.v1.json', 8 * MIB], ['ai-tools/ai-tools-resources.v1.json', 8 * MIB],
  ['ai-tools/projects.v1.json', 2 * MIB], ['ai-tools/router.v1.json', 2 * MIB], ['ai-tools/skills/index.v1.json', 2 * MIB],
]);
const UUID = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const SKILL = new RegExp(`^ai-tools/skills/archives/${UUID}\\.json$`);
const SESSION = /^ai-tools\/session-archives\/[a-f0-9]{64}\.json$/;
const HASH = /^[a-f0-9]{64}$/;
const digestBytes = value => createHash('sha256').update(value).digest('hex');
const invalid = () => new Error(tr("AI 导入计划包含未允许的路径、密文或校验值，原数据未修改"));
function fileLimit(name) { return typeof name === 'string' ? FIXED.get(name) || (SKILL.test(name) ? 48 * MIB : SESSION.test(name) ? 32 * MIB : 0) : 0; }
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) throw invalid();
}
function expected(hash) { if (hash !== null && (typeof hash !== 'string' || !HASH.test(hash))) throw invalid(); }
function cipherBytes(name, bytes) {
  const limit = fileLimit(name); if (!limit || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > limit) throw invalid();
  let envelope;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); envelope = JSON.parse(text);
    record(envelope, ['version', 'encrypted']);
    if (envelope.version !== 1 || typeof envelope.encrypted !== 'string' || !envelope.encrypted || text.trim() !== JSON.stringify(envelope)) throw invalid();
    const cipher = Buffer.from(envelope.encrypted, 'base64'); if (!cipher.length || cipher.toString('base64') !== envelope.encrypted) throw invalid();
  } catch { throw invalid(); }
  return Buffer.from(bytes);
}
function normalizeWrites(input = []) {
  if (!Array.isArray(input) || input.length > MAX_AI_FILES) throw invalid(); const names = new Set(); let total = 0;
  return input.map(row => {
    record(row, ['name', 'bytes', 'expectedHash']); expected(row.expectedHash);
    if (names.has(row.name)) throw invalid(); names.add(row.name);
    const bytes = cipherBytes(row.name, row.bytes); total += bytes.length;
    if (total > 256 * MIB) throw new Error(tr("AI 导入计划超过 256 MiB，请取消包含 AI 会话或减少数据；不会截断"));
    return { name: row.name, bytes, expectedHash: row.expectedHash };
  });
}
function normalizeGuards(input = [], writes = []) {
  if (!Array.isArray(input) || input.length > MAX_AI_FILES) throw invalid(); const names = new Set();
  const guards = input.map(row => {
    record(row, ['name', 'expectedHash']); expected(row.expectedHash);
    if (!fileLimit(row.name) || names.has(row.name)) throw invalid(); names.add(row.name);
    return { name: row.name, expectedHash: row.expectedHash };
  });
  for (const row of writes) { const guard = guards.find(item => item.name === row.name); if (guard && guard.expectedHash !== row.expectedHash) throw invalid(); }
  return guards;
}
function encodeWrites(writes) { return writes.map(row => ({ name: row.name, data: row.bytes.toString('base64'), expectedHash: row.expectedHash, sha256: digestBytes(row.bytes) })); }
function decodeWrites(input) {
  if (!Array.isArray(input) || input.length > MAX_AI_FILES) throw invalid();
  return normalizeWrites(input.map(row => {
    record(row, ['name', 'data', 'expectedHash', 'sha256']); const limit = fileLimit(row.name);
    if (!limit || typeof row.data !== 'string' || row.data.length > Math.ceil(limit / 3) * 4 || typeof row.sha256 !== 'string' || !HASH.test(row.sha256)) throw invalid();
    const bytes = Buffer.from(row.data, 'base64'); if (bytes.toString('base64') !== row.data || digestBytes(bytes) !== row.sha256) throw invalid();
    return { name: row.name, bytes, expectedHash: row.expectedHash };
  }));
}

module.exports = { MAX_AI_FILES, fileLimit, normalizeWrites, normalizeGuards, encodeWrites, decodeWrites };
