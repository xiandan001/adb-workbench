const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { tr } = require('./localization.cjs');
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const FILES = new Set(['manifest.json', 'markers.json', 'performance.jsonl', 'serial-rs232.jsonl', 'serial-terminal.jsonl', 'device.log', 'video.mp4']);
const fileAllowed = name => FILES.has(name) || /^ssh-[a-f\d]{24}\.jsonl$/.test(name);
const fail = () => new Error(tr('复现会话记录无效或不可读取，原文件已保留。'));
function validateManifest(value) {
  if (!value || value.schemaVersion !== 1 || !UUID.test(value.id || '') || typeof value.title !== 'string' || value.title.length > 100
    || typeof value.deviceId !== 'string' || value.deviceId.length > 512 || !Number.isFinite(value.startedAt) || !Number.isFinite(new Date(value.startedAt).getTime())
    || value.endedAt !== undefined && (!Number.isFinite(value.endedAt) || !Number.isFinite(new Date(value.endedAt).getTime()))
    || !['starting', 'recording', 'stopping', 'completed', 'partial', 'interrupted'].includes(value.status)
    || !Array.isArray(value.files) || value.files.length > 12 || !Array.isArray(value.markers) || value.markers.length > 100
    || !Array.isArray(value.warnings) || value.warnings.length > 30 || value.warnings.some(item => typeof item !== 'string' || item.length > 2000)) throw fail();
  for (const file of value.files) if (!file || !fileAllowed(file.name) || typeof file.label !== 'string' || file.label.length > 240
    || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof file.truncated !== 'boolean') throw fail();
  if (new Set(value.files.map(file => file.name)).size !== value.files.length) throw fail();
  for (const marker of value.markers) if (!marker || !UUID.test(marker.id || '') || typeof marker.note !== 'string' || marker.note.length > 240
    || !Number.isFinite(marker.at) || !Number.isFinite(marker.offsetMs) || marker.offsetMs < 0
    || marker.videoOffsetMs !== null && (!Number.isFinite(marker.videoOffsetMs) || marker.videoOffsetMs < 0)) throw fail();
  return value;
}

function createReproductionStore(directory) {
  const root = path.resolve(directory);
  const writes = new Map();
  async function rootReady(create = false) {
    let stat;
    try { stat = await fs.lstat(root); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return false;
      const parent = path.dirname(root);
      if ((await fs.lstat(parent)).isSymbolicLink() || path.resolve(await fs.realpath(parent)) !== parent) throw fail();
      await fs.mkdir(root); stat = await fs.lstat(root);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(await fs.realpath(root)) !== root) throw fail();
    return true;
  }
  function sessionPath(id) { if (!UUID.test(id || '')) throw fail(); return path.join(root, id); }
  async function checkedDirectory(id) {
    await rootReady(); const result = sessionPath(id), stat = await fs.lstat(result);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(await fs.realpath(result)) !== result) throw fail();
    return result;
  }
  async function filePath(id, name, exists = false) {
    if (!fileAllowed(name)) throw fail();
    const filename = path.join(await checkedDirectory(id), name);
    let stat;
    try { stat = await fs.lstat(filename); } catch (error) { if (error.code !== 'ENOENT' || exists) throw error; }
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1)) throw fail();
    return filename;
  }
  function save(manifest) {
    validateManifest(manifest);
    const content = JSON.stringify(manifest, null, 2) + '\n';
    if (Buffer.byteLength(content) > 256 * 1024) throw fail();
    const id = manifest.id;
    const operation = (writes.get(id) || Promise.resolve()).catch(() => {}).then(() => writeManifest(id, content));
    writes.set(id, operation);
    const settled = () => { if (writes.get(id) === operation) writes.delete(id); };
    operation.then(settled, settled);
    return operation;
  }
  async function writeManifest(id, content) {
    const filename = await filePath(id, 'manifest.json');
    const temporary = path.join(path.dirname(filename), `.manifest-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(content, 'utf8'); await handle.sync(); await handle.close(); handle = null;
      await fs.rename(temporary, filename);
    } finally {
      await handle?.close().catch(() => {});
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  async function load(id) {
    const filename = await filePath(id, 'manifest.json', true);
    if ((await fs.stat(filename)).size > 256 * 1024) throw fail();
    const value = validateManifest(JSON.parse(await fs.readFile(filename, 'utf8')));
    if (value.id !== id) throw fail();
    return value;
  }
  async function list() {
    if (!await rootReady()) return { sessions: [], unreadable: 0 };
    const names = (await fs.readdir(root)).filter(name => UUID.test(name));
    if (names.length > 100) throw new Error(tr('复现会话过多，请先在产物中心整理已有记录。'));
    const sessions = []; let unreadable = 0;
    for (const id of names) { try { sessions.push(await load(id)); } catch { unreadable++; } }
    return { sessions: sessions.sort((a, b) => b.startedAt - a.startedAt), unreadable };
  }
  async function create(manifest) {
    await rootReady(true);
    if ((await fs.readdir(root)).filter(name => UUID.test(name)).length >= 100) throw new Error(tr('复现会话过多，请先在产物中心整理已有记录。'));
    const destination = sessionPath(manifest.id); await fs.mkdir(destination);
    await save(manifest); return destination;
  }
  async function append(id, name, value, maxBytes) {
    const filename = await filePath(id, name);
    const content = JSON.stringify(value) + '\n';
    const bytes = Buffer.byteLength(content); const current = await fs.stat(filename).then(stat => stat.size).catch(error => { if (error.code === 'ENOENT') return 0; throw error; });
    if (current + bytes > maxBytes) return { bytes: current, truncated: true };
    await fs.appendFile(filename, content, { encoding: 'utf8', mode: 0o600 });
    return { bytes: current + bytes, truncated: false };
  }
  async function readTail(id, name, maxBytes = 128 * 1024) {
    const filename = await filePath(id, name, true); const handle = await fs.open(filename, 'r');
    try {
      const stat = await handle.stat(); const buffer = Buffer.alloc(Math.min(maxBytes, stat.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length));
      let start = 0; while (start < bytesRead && (buffer[start] & 0xc0) === 0x80) start++;
      return { text: buffer.subarray(start, bytesRead).toString('utf8'), truncated: stat.size > maxBytes || bytesRead < buffer.length, bytes: stat.size };
    } finally { await handle.close(); }
  }
  return { root, create, save, load, list, filePath, checkedDirectory, append, readTail };
}
module.exports = { createReproductionStore, validateManifest, UUID, fileAllowed };
