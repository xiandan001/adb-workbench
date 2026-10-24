const { tr } = require('./localization.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const YAML = require('yaml');
const { fail, readSafe, assertSafeParents } = require('./ai-tools-file-safety.cjs');

const MAX_BYTES = 16 * 1024 * 1024;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const safePart = name => name && name !== '.' && name !== '..' && !/[\\/:*?"<>|]/.test(name)
  && !Array.from(name).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  && !/[. ]$/.test(name) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
const sortEntries = entries => entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
function treeHash(entries) {
  const digest = createHash('sha256');
  for (const entry of sortEntries([...entries])) digest.update(JSON.stringify([entry.path, entry.type, entry.mode || 0, entry.data || ''])).update('\0');
  return digest.digest('hex');
}
function validateTree(tree) {
  if (tree === null) return null;
  if (!tree || !Array.isArray(tree.entries) || tree.entries.length > 2048) throw fail('AI_TOOLS_SKILL_INVALID', tr("技能文件清单无效"));
  const names = new Set(); const directories = new Set(['']); let bytes = 0; let files = 0;
  for (const entry of sortEntries([...tree.entries])) {
    if (!entry || typeof entry.path !== 'string' || entry.path.length > 1024 || !['file', 'directory'].includes(entry.type)) throw fail('AI_TOOLS_SKILL_INVALID', tr("技能文件清单无效"));
    const parts = entry.path.split('/');
    if (parts.length > 9 || !parts.every(safePart) || names.has(entry.path.toLowerCase()) || !directories.has(parts.slice(0, -1).join('/').toLowerCase())) throw fail('AI_TOOLS_SKILL_PATH', tr("技能目录含不安全路径、重名或过深层级"));
    names.add(entry.path.toLowerCase());
    if (entry.type === 'directory') { directories.add(entry.path.toLowerCase()); continue; }
    if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 || typeof entry.data !== 'string') throw fail('AI_TOOLS_SKILL_INVALID', tr("技能文件元数据无效"));
    const content = Buffer.from(entry.data, 'base64');
    if (content.toString('base64') !== entry.data) throw fail('AI_TOOLS_SKILL_INVALID', tr("技能文件内容无效"));
    files += 1; bytes += content.length;
    if (files > 1000 || bytes > MAX_BYTES) throw fail('AI_TOOLS_SKILL_LIMIT', tr("技能超过 1000 个文件或 16 MiB 限制"));
  }
  if (tree.hash !== treeHash(tree.entries) || tree.bytes !== bytes || tree.fileCount !== files) throw fail('AI_TOOLS_SKILL_INVALID', tr("技能文件校验失败"));
  return tree;
}

function scanTree(directory, io = fs) {
  assertSafeParents(path.join(directory, '_check'), io);
  let root;
  try { root = io.lstatSync(directory); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!root.isDirectory() || root.isSymbolicLink()) throw fail('AI_TOOLS_SKILL_LINK', tr("技能根目录必须是普通目录，不能是链接"));
  const entries = []; let bytes = 0; let fileCount = 0;
  const visit = (relative, depth) => {
    if (depth > 8) throw fail('AI_TOOLS_SKILL_LIMIT', tr("技能目录超过 8 层限制"));
    const directoryPath = relative ? path.join(directory, ...relative.split('/')) : directory;
    const before = io.lstatSync(directoryPath);
    if (!before.isDirectory() || before.isSymbolicLink()) throw fail('AI_TOOLS_SKILL_LINK', tr("技能目录包含链接"));
    const children = io.readdirSync(directoryPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const child of children) {
      if (!safePart(child.name)) throw fail('AI_TOOLS_SKILL_PATH', tr("技能文件名称无效"));
      const name = relative ? `${relative}/${child.name}` : child.name; const file = path.join(directoryPath, child.name);
      const stat = io.lstatSync(file);
      if (stat.isSymbolicLink()) throw fail('AI_TOOLS_SKILL_LINK', tr("技能目录包含符号链接或目录链接，未导入"));
      if (stat.isDirectory()) { entries.push({ path: name, type: 'directory' }); visit(name, depth + 1); }
      else {
        if (!stat.isFile() || stat.nlink !== 1) throw fail('AI_TOOLS_SKILL_LINK', tr("技能包含硬链接或特殊文件，未导入"));
        if (++fileCount > 1000 || bytes + stat.size > MAX_BYTES) throw fail('AI_TOOLS_SKILL_LIMIT', tr("技能超过 1000 个文件或 16 MiB 限制"));
        const read = readSafe(file, io, MAX_BYTES); bytes += read.bytes.length;
        entries.push({ path: name, type: 'file', mode: stat.mode & 0o777, data: read.bytes.toString('base64') });
      }
      if (entries.length > 2048) throw fail('AI_TOOLS_SKILL_LIMIT', tr("技能目录条目过多"));
    }
    const after = io.lstatSync(directoryPath);
    if (before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs || after.isSymbolicLink()) throw fail('AI_TOOLS_SKILL_CHANGED', tr("技能目录在读取时发生变化，请重新选择"));
  };
  visit('', 0);
  return validateTree({ entries: sortEntries(entries), bytes, fileCount, hash: treeHash(entries) });
}

function skillMetadata(tree, sourceDirectory) {
  const entry = tree?.entries.find(row => row.type === 'file' && row.path.toLowerCase() === 'skill.md');
  if (!entry) throw fail('AI_TOOLS_SKILL_REQUIRED', tr("所选目录必须直接包含 SKILL.md，不能导入整个项目或 vendor 目录"));
  const bytes = Buffer.from(entry.data, 'base64');
  if (bytes.length > 65536) throw fail('AI_TOOLS_SKILL_LIMIT', tr("SKILL.md 超过 64 KiB 限制"));
  const content = bytes.toString('utf8');
  if (!Buffer.from(content).equals(bytes) || content.includes('\0')) throw fail('AI_TOOLS_SKILL_TEXT', tr("SKILL.md 必须是 UTF-8 纯文本"));
  let meta = {};
  if (/^---\r?\n/.test(content)) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    if (!match) throw fail('AI_TOOLS_SKILL_METADATA', tr("SKILL.md 元数据没有闭合"));
    const doc = YAML.parseDocument(match[1], { uniqueKeys: true });
    if (doc.errors.length || doc.warnings.length) throw fail('AI_TOOLS_SKILL_METADATA', tr("SKILL.md 元数据格式无效"));
    try { meta = doc.toJS({ maxAliasCount: 0 }) || {}; } catch { throw fail('AI_TOOLS_SKILL_METADATA', tr("SKILL.md 元数据不支持引用")); }
  }
  const name = String(meta.name || path.basename(sourceDirectory)).trim().toLowerCase();
  if (!SLUG.test(name)) throw fail('AI_TOOLS_SKILL_NAME', tr("技能名称只能使用小写字母、数字和短横线，长度 1–64"));
  if (meta.description !== undefined && typeof meta.description !== 'string') throw fail('AI_TOOLS_SKILL_METADATA', tr("技能描述必须是文本"));
  return { name, description: (meta.description || '').slice(0, 512), content };
}

function writeTree(directory, tree, io = fs) {
  validateTree(tree); assertSafeParents(path.join(directory, '_check'), io); io.mkdirSync(directory, { mode: 0o700 });
  const owned = io.lstatSync(directory);
  try {
    for (const entry of tree.entries) {
      const destination = path.join(directory, ...entry.path.split('/')); assertSafeParents(destination, io);
      if (entry.type === 'directory') io.mkdirSync(destination, { mode: 0o700 });
      else {
        const fd = io.openSync(destination, 'wx', 0o600);
        try { io.writeFileSync(fd, Buffer.from(entry.data, 'base64')); io.fsyncSync(fd); io.fchmodSync(fd, entry.mode); }
        finally { io.closeSync(fd); }
      }
    }
    if (scanTree(directory, io)?.hash !== tree.hash) throw fail('AI_TOOLS_SKILL_CHANGED', tr("技能准备目录校验失败"));
  } catch (error) {
    try {
      const actual = io.lstatSync(directory); const partial = scanTree(directory, io);
      if (actual.ino !== owned.ino || actual.dev !== owned.dev || actual.isSymbolicLink()) throw new Error('Stage replaced');
      for (const row of partial.entries) {
        const expected = tree.entries.find(entry => entry.path === row.path && entry.type === row.type);
        if (!expected) throw new Error('Unexpected staged entry');
        if (row.type === 'file') {
          const bytes = Buffer.from(row.data, 'base64'); const wanted = Buffer.from(expected.data, 'base64');
          if (bytes.length > wanted.length || !bytes.equals(wanted.subarray(0, bytes.length))) throw new Error('External staged edit');
        }
      }
      removeOwnedTree(directory, partial.hash, io);
    } catch { error.cleanupPending = true; }
    throw error;
  }
}

function removeOwnedTree(directory, expectedHash, io = fs) {
  const current = scanTree(directory, io);
  if (!current) return;
  if (!expectedHash || current.hash !== expectedHash) throw fail('AI_TOOLS_SKILL_CHANGED', tr("技能目录已变化，未删除"));
  for (const entry of [...current.entries].reverse()) {
    const destination = path.join(directory, ...entry.path.split('/')); assertSafeParents(destination, io);
    if (entry.type === 'file') {
      const actual = readSafe(destination, io, MAX_BYTES);
      if (!actual.bytes || actual.bytes.toString('base64') !== entry.data || actual.mode !== entry.mode) throw fail('AI_TOOLS_SKILL_CHANGED', tr("技能文件在清理时发生变化，未删除"));
      io.unlinkSync(destination);
    }
    else io.rmdirSync(destination);
  }
  io.rmdirSync(directory);
}

module.exports = { MAX_BYTES, SLUG, validateTree, scanTree, skillMetadata, writeTree, removeOwnedTree };
