const { tr } = require('./localization.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { readSafe, atomicReplace, checksum, fail } = require('./ai-tools-file-safety.cjs');
const { SLUG } = require('./ai-tools-skills-tree.cjs');

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MAX_ARCHIVE = 48 * 1024 * 1024;
function createSkillsStore({ directory, canEncrypt = () => false, encrypt, decrypt, filesystem: io = fs }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) throw fail('AI_TOOLS_SKILL_PATH', tr("技能库目录无效"));
  let state; let observedHash = null;
  const encrypted = () => { try { return canEncrypt() && typeof encrypt === 'function' && typeof decrypt === 'function'; } catch { return false; } };
  const requireEncryption = () => { if (!encrypted()) throw fail('AI_TOOLS_ENCRYPTION_UNAVAILABLE', tr("系统安全加密不可用，不能保存、安装或恢复技能")); };
  function objectPath(kind, id) {
    if (kind === 'index') return path.join(directory, 'index.v1.json');
    if (kind === 'journal') return path.join(directory, 'pending.v1.json');
    if (!['archive', 'backup'].includes(kind) || !UUID.test(id)) throw fail('AI_TOOLS_SKILL_ID', tr("技能数据标识无效"));
    return path.join(directory, kind === 'archive' ? 'archives' : 'backups', `${id}.json`);
  }
  function readObject(kind, id) {
    const current = readSafe(objectPath(kind, id), io, kind === 'index' ? 2 * 1024 * 1024 : MAX_ARCHIVE);
    if (!current.bytes) return { value: null, hash: null };
    requireEncryption();
    try {
      const envelope = JSON.parse(current.bytes.toString('utf8'));
      if (envelope.version !== 1 || Object.keys(envelope).length !== 2 || typeof envelope.encrypted !== 'string') throw new Error('envelope');
      const cipher = Buffer.from(envelope.encrypted, 'base64');
      if (!cipher.length || cipher.toString('base64') !== envelope.encrypted) throw new Error('cipher');
      const plain = decrypt(cipher);
      if (typeof plain !== 'string' || Buffer.byteLength(plain) > MAX_ARCHIVE) throw new Error('limit');
      return { value: JSON.parse(plain), hash: current.hash };
    } catch { throw fail('AI_TOOLS_SKILL_DATA', tr("技能加密文件无法读取，已保留原文件")); }
  }
  function writeObject(kind, id, value, expectedHash = null) {
    requireEncryption();
    let bytes;
    if (value !== null) {
      try {
        const plain = JSON.stringify(value); if (Buffer.byteLength(plain) > MAX_ARCHIVE * 0.7) throw new Error('size');
        const cipher = encrypt(plain); if (!Buffer.isBuffer(cipher) || !cipher.length) throw new Error('cipher');
        bytes = Buffer.from(`${JSON.stringify({ version: 1, encrypted: cipher.toString('base64') })}\n`);
      } catch { throw fail('AI_TOOLS_SKILL_ENCRYPT', tr("技能数据加密失败或超过容量限制")); }
    } else bytes = null;
    atomicReplace(objectPath(kind, id), bytes, expectedHash, io, kind === 'index' ? 2 * 1024 * 1024 : MAX_ARCHIVE);
    return checksum(bytes);
  }
  function validate(value) {
    if (!value || value.version !== 1 || Object.keys(value).sort().join(',') !== 'backups,installations,skills,version' || !Array.isArray(value.skills) || value.skills.length > 50 || !Array.isArray(value.backups) || value.backups.length > 50 || !Array.isArray(value.installations) || value.installations.length > 200) throw new Error('index');
    const ids = new Set(); const names = new Set(); let total = 0; let backupTotal = 0;
    for (const row of value.skills) {
      if (!row || !UUID.test(row.id) || ids.has(row.id) || !SLUG.test(row.name) || names.has(row.name) || !HASH.test(row.hash) || typeof row.description !== 'string' || row.description.length > 512 || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !Number.isSafeInteger(row.fileCount) || row.fileCount < 1 || row.fileCount > 1000 || !Number.isFinite(row.createdAt)) throw new Error('skill');
      ids.add(row.id); names.add(row.name); total += row.bytes;
    }
    const installations = new Set();
    for (const row of value.installations) {
      const key = `${row.toolId}:${row.name}`;
      if (!['claude', 'codex', 'gemini', 'opencode'].includes(row.toolId) || !SLUG.test(row.name) || !UUID.test(row.skillId) || !HASH.test(row.hash) || installations.has(key)) throw new Error('installation');
      installations.add(key);
    }
    for (const row of value.backups) {
      if (!UUID.test(row.id) || ids.has(row.id) || !['claude', 'codex', 'gemini', 'opencode'].includes(row.toolId) || !SLUG.test(row.name) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !Number.isFinite(row.createdAt)) throw new Error('backup');
      ids.add(row.id); backupTotal += row.bytes;
    }
    if (total > 64 * 1024 * 1024 || backupTotal > 256 * 1024 * 1024) throw new Error('quota');
    return value;
  }
  function load() {
    if (state) return state;
    const current = readObject('index'); observedHash = current.hash;
    try { state = current.value ? validate(current.value) : { version: 1, skills: [], installations: [], backups: [] }; }
    catch { throw fail('AI_TOOLS_SKILL_DATA', tr("技能库索引无效，已保留原文件")); }
    return state;
  }
  function unchanged() { load(); if (readSafe(objectPath('index'), io, 2 * 1024 * 1024).hash !== observedHash) throw fail('AI_TOOLS_SKILL_CHANGED', tr("技能库索引已变化，请重新打开应用后操作")); }
  function persist(next) {
    unchanged();
    try { validate(next); } catch { throw fail('AI_TOOLS_SKILL_LIMIT', tr("技能库或备份达到容量限制，未修改原数据")); }
    observedHash = writeObject('index', undefined, next, observedHash); state = next;
  }
  return { load, copy: () => structuredClone(load()), unchanged, persist, readObject, writeObject, requireEncryption, revision: () => { load(); return observedHash; } };
}

module.exports = { createSkillsStore, UUID, HASH };
