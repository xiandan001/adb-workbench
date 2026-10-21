const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { gzip, gzipSync, gunzipSync } = require('zlib');
const { promisify } = require('util');
const policy = require('./data-migration-policy.cjs');
const gzipAsync = promisify(gzip);

const MAX_COMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 2000;
const FORMAT = 'adb-workbench-backup';

function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function comparable(file) { return process.platform === 'win32' ? file.toLowerCase() : file; }

async function safeRoot(directory) {
  const root = path.resolve(directory);
  const stat = await fs.promises.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('数据目录不能是链接或普通文件');
  const real = await fs.promises.realpath(root);
  if (comparable(real) !== comparable(root)) throw new Error('数据目录不能经过符号链接');
  return root;
}

// Every caller supplies an internally selected relative path; no filesystem links are followed.
async function safePath(root, relative, { createParents = false } = {}) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || path.isAbsolute(relative)
    || relative.split('/').some(part => !part || part === '.' || part === '..' || !/^[a-zA-Z0-9._-]+$/.test(part))) {
    throw new Error('备份路径无效');
  }
  const parts = relative.split('/');
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = await fs.promises.lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (index < parts.length - 1 && createParents) {
        await fs.promises.mkdir(current);
        stat = await fs.promises.lstat(current);
      } else continue;
    }
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) throw new Error('数据路径包含链接或无效目录');
    if (index === parts.length - 1 && !stat.isFile()) throw new Error('数据路径不是普通文件');
    const real = await fs.promises.realpath(current);
    const within = path.relative(root, real);
    if (within.startsWith('..') || path.isAbsolute(within)) throw new Error('数据路径超出允许目录');
  }
  return current;
}

async function boundedRead(root, relative, limit = MAX_FILE_BYTES) {
  const target = await safePath(root, relative);
  const stat = await fs.promises.lstat(target);
  if (stat.size > limit) throw new Error(`数据文件超过大小限制：${relative}`);
  const bytes = await fs.promises.readFile(target);
  if (bytes.length > limit) throw new Error(`数据文件超过大小限制：${relative}`);
  return bytes;
}

function validatePayload(input) {
  if (!plainObject(input) || input.schemaVersion !== 1 || typeof input.appVersion !== 'string'
    || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(input.appVersion)
    || typeof input.createdAt !== 'string' || !Number.isFinite(Date.parse(input.createdAt))
    || !Array.isArray(input.files) || input.files.length > MAX_FILES) throw new Error('备份版本或结构不受支持');
  const preferences = policy.normalizePreferences(input.preferences);
  const names = new Set();
  let totalBytes = Buffer.byteLength(JSON.stringify(preferences));
  const files = input.files.map(file => {
    if (!plainObject(file) || typeof file.name !== 'string' || !policy.isAllowedFile(file.name)
      || names.has(file.name.toLowerCase()) || !Object.hasOwn(file, 'data')) throw new Error('备份包含不支持或重复的数据文件');
    names.add(file.name.toLowerCase());
    const originalBytes = Buffer.byteLength(JSON.stringify(file.data));
    if (originalBytes > MAX_FILE_BYTES) throw new Error('单个数据文件超过 64 MB，未导入或截断');
    const data = policy.sanitizeFile(file.name, file.data);
    totalBytes += Buffer.byteLength(JSON.stringify(data));
    if (totalBytes > MAX_EXPANDED_BYTES) throw new Error('备份展开后超过 256 MB，未导入或截断');
    return { name: file.name, data };
  });
  const payload = { schemaVersion: 1, appVersion: input.appVersion, createdAt: input.createdAt, files, preferences };
  return {
    payload,
    summary: {
      fileCount: files.length, sessionCount: files.filter(file => file.name.startsWith('log-analysis-sessions/')).length,
      preferenceCount: Object.keys(preferences).length, appVersion: payload.appVersion,
      createdAt: payload.createdAt, totalBytes, bytes: totalBytes
    }
  };
}

function archiveBytes(input) {
  const { payload } = validatePayload(input);
  const encoded = Buffer.from(JSON.stringify({ format: FORMAT, sha256: digest(payload), payload }));
  if (encoded.length > MAX_EXPANDED_BYTES) throw new Error('备份展开后超过 256 MB，未导出或截断');
  return encoded;
}

function checkCompressedSize(archive) {
  if (archive.length > MAX_COMPRESSED_BYTES) throw new Error('备份超过 128 MB，未导出或截断');
  return archive;
}

function encodeArchive(input) { return checkCompressedSize(gzipSync(archiveBytes(input))); }

function readArchive(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_COMPRESSED_BYTES) throw new Error('备份为空或超过 128 MB');
  let envelope;
  try { envelope = JSON.parse(gunzipSync(buffer, { maxOutputLength: MAX_EXPANDED_BYTES }).toString('utf8')); }
  catch { throw new Error('备份损坏或展开后超过 256 MB'); }
  if (!plainObject(envelope) || envelope.format !== FORMAT || typeof envelope.sha256 !== 'string'
    || envelope.sha256 !== digest(envelope.payload)) throw new Error('备份校验失败，文件已损坏或被修改');
  return validatePayload(envelope.payload);
}

async function createArchive(userData, preferences, appVersion) {
  const root = await safeRoot(userData);
  const names = [];
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (policy.isAllowedFile(entry.name)) names.push(entry.name);
    if (entry.name !== 'log-analysis-sessions') continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('日志会话目录不能是链接或普通文件');
    const directory = path.join(root, entry.name);
    for (const child of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const name = `${entry.name}/${child.name}`;
      if (policy.isAllowedFile(name)) names.push(name);
    }
  }
  if (names.length > MAX_FILES) throw new Error('数据文件超过 2000 个，未导出或截断');
  const files = [];
  let bytes = 0;
  for (const name of names.sort()) {
    const raw = await boundedRead(root, name);
    bytes += raw.length;
    if (bytes > MAX_EXPANDED_BYTES) throw new Error('数据超过 256 MB，未导出或截断');
    let data;
    try { data = JSON.parse(raw.toString('utf8')); }
    catch { throw new Error(`数据文件损坏，未导出：${name}`); }
    files.push({ name, data });
  }
  const encoded = archiveBytes({ schemaVersion: 1, appVersion, createdAt: new Date().toISOString(), files, preferences });
  return checkCompressedSize(await gzipAsync(encoded));
}

module.exports = {
  createArchive, readArchive, encodeArchive, validatePayload, digest, safeRoot, safePath, boundedRead,
  MAX_COMPRESSED_BYTES, MAX_EXPANDED_BYTES, MAX_FILE_BYTES, MAX_FILES
};
