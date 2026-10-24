const { tr } = require('./localization.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MAX_CONFIG_BYTES = 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });
const checksum = bytes => bytes === null ? null : createHash('sha256').update(bytes).digest('hex');

function assertSafeParents(file, io = fs) {
  const absolute = path.resolve(file); const root = path.parse(absolute).root;
  let current = root;
  for (const part of path.relative(root, path.dirname(absolute)).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = io.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('AI_TOOLS_CONFIG_LINK', tr("配置目录包含链接或不是普通目录，已停止操作"));
  }
}

function readSafe(file, io = fs, limit = MAX_CONFIG_BYTES) {
  assertSafeParents(file, io);
  let stat;
  try { stat = io.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return { path: file, exists: false, bytes: null, hash: null, mode: 0o600 }; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) throw fail('AI_TOOLS_CONFIG_FILE', tr("配置文件不是普通文件、包含链接或超过容量限制"));
  const fd = io.openSync(file, 'r');
  try {
    const opened = io.fstatSync(fd);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) throw fail('AI_TOOLS_CONFIG_CHANGED', tr("配置文件在读取时发生变化，请重新预览"));
    const bytes = Buffer.alloc(opened.size); let offset = 0;
    while (offset < bytes.length) {
      const count = io.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw fail('AI_TOOLS_CONFIG_CHANGED', tr("配置文件在读取时发生变化，请重新预览"));
      offset += count;
    }
    const after = io.fstatSync(fd); const target = io.lstatSync(file);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || target.ino !== opened.ino || target.dev !== opened.dev || target.isSymbolicLink()) throw fail('AI_TOOLS_CONFIG_CHANGED', tr("配置文件在读取时发生变化，请重新预览"));
    return { path: file, exists: true, bytes, hash: checksum(bytes), mode: stat.mode & 0o777 };
  } finally { io.closeSync(fd); }
}

function checkHash(file, expected, io = fs, limit) {
  const current = readSafe(file, io, limit);
  if (current.hash !== expected) throw fail('AI_TOOLS_CONFIG_CHANGED', tr("配置文件已在外部变化，未覆盖，请重新预览"));
  return current;
}

function atomicReplace(file, bytes, expectedHash, io = fs, limit = MAX_CONFIG_BYTES) {
  checkHash(file, expectedHash, io, limit);
  if (bytes === null) {
    if (expectedHash !== null) { assertSafeParents(file, io); io.unlinkSync(file); }
    return;
  }
  if (!Buffer.isBuffer(bytes) || bytes.length > limit) throw fail('AI_TOOLS_CONFIG_LIMIT', tr("配置文件超过容量限制"));
  io.mkdirSync(path.dirname(file), { recursive: true }); assertSafeParents(file, io);
  const temporary = path.join(path.dirname(file), `.awb-ai-${randomUUID()}.tmp`);
  let owned = false; let fd;
  try {
    fd = io.openSync(temporary, 'wx', 0o600); owned = true;
    io.writeFileSync(fd, bytes); io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
    checkHash(file, expectedHash, io, limit); assertSafeParents(file, io);
    io.renameSync(temporary, file); owned = false;
  } finally {
    if (fd !== undefined) try { io.closeSync(fd); } catch { /* Preserve primary error. */ }
    if (owned) try { io.unlinkSync(temporary); } catch { /* Never remove a path not created by this operation. */ }
  }
}

function decodeConfig(bytes) {
  if (bytes === null) return '';
  const content = bytes.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(bytes) || content.includes('\0')) throw fail('AI_TOOLS_CONFIG_ENCODING', tr("配置文件不是有效 UTF-8 文本，未修改"));
  return content;
}

module.exports = { MAX_CONFIG_BYTES, fail, checksum, assertSafeParents, readSafe, checkHash, atomicReplace, decodeConfig };
