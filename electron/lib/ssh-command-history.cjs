const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const FILE_NAME = 'ssh-command-history.v1.json';
const MAX_COMMAND_BYTES = 4096;
const MAX_ENTRIES = 500;
const MAX_HOSTS = 64;
const MAX_PLAINTEXT_BYTES = 2 * 1024 * 1024;
const MAX_CIPHERTEXT_BYTES = MAX_PLAINTEXT_BYTES + 64 * 1024;
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MEMORY_WARNING = '本机安全加密不可用，SSH 命令历史仅保留在本次会话内存中，退出即消失；不会写入明文。';
const PAUSED_MEMORY_WARNING = '无法读取已保存历史及暂停设置，本次默认暂停。可手动恢复仅本次会话记录；不会修改已有加密历史。';
const failure = (code, message) => Object.assign(new Error(message), { code });
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const safeText = value => typeof value === 'string' && Buffer.from(value, 'utf8').toString('utf8') === value
  && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

function normalizeIdentity(value) {
  if (!value || typeof value !== 'object' || !safeText(value.host) || !value.host.trim() || value.host.length > 253) throw failure('SSH_HISTORY_IDENTITY_INVALID', 'SSH 历史主机身份无效');
  const host = value.host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (!host || /[\s/\\@?#]/.test(host) || host.includes('[') || host.includes(']')) throw failure('SSH_HISTORY_IDENTITY_INVALID', 'SSH 历史主机地址无效');
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw failure('SSH_HISTORY_IDENTITY_INVALID', 'SSH 历史端口无效');
  if (!safeText(value.username) || !value.username.trim() || value.username.length > 128) throw failure('SSH_HISTORY_IDENTITY_INVALID', 'SSH 历史用户名无效');
  return { host, port: value.port, username: value.username.trim() };
}
const identityKey = identity => JSON.stringify([identity.host, identity.port, identity.username]);

function commandRejection(command) {
  if (typeof command !== 'string' || !command.length || command.length > MAX_COMMAND_BYTES || Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES || !safeText(command)
    || Array.from(command).some(character => { const code = character.charCodeAt(0); return code >= 128 && code <= 159 || code === 0x2028 || code === 0x2029; })) return 'invalid-command';
  if (/^\s/.test(command)) return 'leading-space';
  if (!command.trim()) return 'invalid-command';
  return null;
}

function appearsSensitive(command) {
  // This is a conservative convenience filter, not a guarantee. Leading space or pause is the privacy control.
  const assignment = /(?:^|[\s;&|])(?:[A-Za-z_][A-Za-z0-9_]*_)?(?:PASSWORD|PASSWD|PASSPHRASE|TOKEN|SECRET|API_KEY|APIKEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|PGPASSWORD|CREDENTIALS?)(?:_[A-Za-z0-9_]+)?\s*=/i;
  const option = /(?:^|\s)--?(?:password|passwd|passphrase|token|secret|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|auth[-_]?token|authorization|credentials?)(?:[-_][\w-]+)?(?:\s+|=|$)/i;
  const property = /["'](?:password|passwd|passphrase|token|secret|api[_-]?key|client[_-]?secret|access[_-]?token)["']\s*[:=]/i;
  return assignment.test(command) || option.test(command) || property.test(command)
    || /(?:^|[\s;&|])sshpass(?:\s|$)/i.test(command)
    || /\bAuthorization\s*:\s*(?:Bearer|Basic)\b/i.test(command)
    || /\b(?:https?|ftps?|ssh):\/\/[^/\s:@]+:[^/\s@]+@/i.test(command)
    || /\b(?:curl|wget)\b.*?(?:\s-u|--user|--proxy-user)(?:=|\s+)\S*:/i.test(command)
    || /\b(?:mysql|mariadb)\b.*?\s-p\S+/i.test(command)
    || /\b(?:docker|podman)\s+login\b.*?\s-p(?:\S|\s+\S)/i.test(command);
}

function validatePayload(value) {
  if (!exactKeys(value, ['version', 'hosts']) || value.version !== 1 || !Array.isArray(value.hosts) || value.hosts.length > MAX_HOSTS) throw new Error('schema');
  const identities = new Set(); const ids = new Set();
  for (const host of value.hosts) {
    if (!exactKeys(host, ['identity', 'paused', 'updatedAt', 'entries']) || !exactKeys(host.identity, ['host', 'port', 'username'])
      || typeof host.paused !== 'boolean' || !Number.isSafeInteger(host.updatedAt) || host.updatedAt < 0 || !Array.isArray(host.entries) || host.entries.length > MAX_ENTRIES) throw new Error('host');
    const normalized = normalizeIdentity(host.identity); const key = identityKey(normalized);
    if (host.identity.host !== normalized.host || host.identity.username !== normalized.username || identities.has(key)) throw new Error('identity');
    identities.add(key); const commands = new Set(); let previousTime = host.updatedAt;
    for (const entry of host.entries) {
      if (!exactKeys(entry, ['id', 'command', 'lastUsed', 'count']) || typeof entry.id !== 'string' || !UUID.test(entry.id) || ids.has(entry.id)
        || commandRejection(entry.command) || commands.has(entry.command) || !Number.isSafeInteger(entry.lastUsed) || entry.lastUsed < 0 || entry.lastUsed > previousTime
        || !Number.isSafeInteger(entry.count) || entry.count < 1) throw new Error('entry');
      ids.add(entry.id); commands.add(entry.command); previousTime = entry.lastUsed;
    }
  }
  return value;
}

function createSshCommandHistory({ directory, canEncrypt = () => false, encrypt, decrypt, now = Date.now } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) throw failure('SSH_HISTORY_DIRECTORY_INVALID', 'SSH 历史保存目录无效');
  const file = path.join(path.resolve(directory), FILE_NAME);
  let data; let persistent; let observedChecksum = null; let defaultPaused = false; let warning = '';
  const available = () => { try { return Boolean(canEncrypt()) && typeof encrypt === 'function' && typeof decrypt === 'function'; } catch { return false; } };
  const state = () => ({ persistent, warning });
  function downgrade(message = MEMORY_WARNING) { persistent = false; warning = message; }

  function readDisk() {
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size < 1 || stat.size > MAX_FILE_BYTES) throw new Error('invalid history file');
    const handle = fs.openSync(file, 'r');
    try {
      const actual = fs.fstatSync(handle);
      if (!actual.isFile() || actual.ino !== stat.ino || actual.dev !== stat.dev || actual.size !== stat.size) throw new Error('history changed');
      const bytes = Buffer.alloc(actual.size); let offset = 0;
      while (offset < bytes.length) { const count = fs.readSync(handle, bytes, offset, bytes.length - offset, offset); if (!count) throw new Error('incomplete history'); offset += count; }
      const after = fs.fstatSync(handle); const target = fs.lstatSync(file);
      if (after.size !== actual.size || after.mtimeMs !== actual.mtimeMs || target.ino !== actual.ino || target.dev !== actual.dev || target.isSymbolicLink()) throw new Error('history changed');
      return bytes;
    } finally { fs.closeSync(handle); }
  }

  function load() {
    if (data) { if (persistent && !available()) downgrade(); return data; }
    try {
      const raw = readDisk(); persistent = available();
      if (!persistent) warning = MEMORY_WARNING;
      if (!raw) { data = { version: 1, hosts: [] }; return data; }
      const envelope = JSON.parse(raw.toString('utf8'));
      if (!exactKeys(envelope, ['version', 'encrypted']) || envelope.version !== 1 || typeof envelope.encrypted !== 'string' || !envelope.encrypted.length
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.encrypted)) throw new Error('envelope');
      const cipher = Buffer.from(envelope.encrypted, 'base64');
      if (!cipher.length || cipher.length > MAX_CIPHERTEXT_BYTES || cipher.toString('base64') !== envelope.encrypted) throw new Error('ciphertext');
      observedChecksum = checksum(raw);
      if (!persistent) { defaultPaused = true; downgrade(PAUSED_MEMORY_WARNING); data = { version: 1, hosts: [] }; return data; }
      const plain = decrypt(cipher);
      if (typeof plain !== 'string' || Buffer.byteLength(plain, 'utf8') > MAX_PLAINTEXT_BYTES) throw new Error('plaintext limit');
      data = validatePayload(JSON.parse(plain)); return data;
    } catch { throw failure('SSH_HISTORY_READ_FAILED', 'SSH 命令历史无法读取，已保留原文件，请备份后检查 ssh-command-history.v1.json'); }
  }

  function checkUnchanged() {
    try {
      const raw = readDisk(); const actual = raw ? checksum(raw) : null;
      if (actual !== observedChecksum) throw new Error('changed');
    } catch { throw failure('SSH_HISTORY_CHANGED', 'SSH 命令历史文件已变化，已保留原文件；请重新打开软件后再操作'); }
  }

  function persist(next) {
    const plain = JSON.stringify(next);
    if (Buffer.byteLength(plain, 'utf8') > MAX_PLAINTEXT_BYTES) throw failure('SSH_HISTORY_LIMIT', 'SSH 命令历史超过 2 MiB 容量限制');
    if (!persistent) { data = next; return; }
    let encrypted;
    try {
      encrypted = encrypt(plain);
      if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_CIPHERTEXT_BYTES) throw new Error('encryption unavailable');
    } catch { downgrade(); data = next; return; }
    const content = Buffer.from(`${JSON.stringify({ version: 1, encrypted: encrypted.toString('base64') })}\n`, 'utf8');
    const temporary = path.join(path.dirname(file), `.ssh-command-history-${randomUUID()}.tmp`);
    let handle; let created = false;
    try {
      checkUnchanged(); fs.mkdirSync(path.dirname(file), { recursive: true });
      handle = fs.openSync(temporary, 'wx', 0o600); created = true;
      fs.writeFileSync(handle, content); fs.fsyncSync(handle); fs.closeSync(handle); handle = undefined;
      checkUnchanged(); fs.renameSync(temporary, file); created = false;
      observedChecksum = checksum(content); data = next;
    } catch (error) {
      if (error.code === 'SSH_HISTORY_CHANGED') throw error;
      throw failure('SSH_HISTORY_SAVE_FAILED', 'SSH 命令历史保存失败，原有历史未被替换；请检查磁盘空间和权限');
    } finally {
      if (handle !== undefined) { try { fs.closeSync(handle); } catch { /* Preserve the original save error. */ } }
      if (created) { try { fs.unlinkSync(temporary); } catch { /* Only an owned encrypted temporary may remain; never remove another path. */ } }
    }
  }

  const copy = current => ({ version: 1, hosts: current.hosts.map(host => ({ ...host, identity: { ...host.identity }, entries: host.entries.map(entry => ({ ...entry })) })) });
  const findHost = (current, id) => current.hosts.find(host => identityKey(host.identity) === identityKey(id));
  function timestamp(current) {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw failure('SSH_HISTORY_TIME_INVALID', 'SSH 历史记录时间无效');
    return Math.max(value, ...current.hosts.map(host => host.updatedAt));
  }
  function ensureHost(next, id, time) {
    let host = findHost(next, id);
    if (!host) {
      if (next.hosts.length >= MAX_HOSTS) {
        const candidates = next.hosts.filter(item => !item.paused).sort((a, b) => a.updatedAt - b.updatedAt);
        if (!candidates.length) return null;
        next.hosts.splice(next.hosts.indexOf(candidates[0]), 1);
      }
      host = { identity: id, paused: defaultPaused, updatedAt: time, entries: [] }; next.hosts.push(host);
    }
    return host;
  }
  function touch(next, host, time) { host.updatedAt = time; next.hosts.splice(next.hosts.indexOf(host), 1); next.hosts.unshift(host); }
  function trim(next) {
    while (Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_PLAINTEXT_BYTES) {
      let oldest;
      for (const host of next.hosts) {
        const entry = host.entries.at(-1);
        if (entry && (!oldest || entry.lastUsed <= oldest.entries.at(-1).lastUsed)) oldest = host;
      }
      if (!oldest) throw failure('SSH_HISTORY_LIMIT', 'SSH 命令历史超过 2 MiB 容量限制');
      oldest.entries.pop();
    }
  }
  function list(identity) {
    const id = normalizeIdentity(identity); const current = load(); const host = findHost(current, id);
    return { entries: host ? host.entries.map(entry => ({ ...entry })) : [], paused: host?.paused ?? defaultPaused, ...state() };
  }
  function record(identity, command) {
    const id = normalizeIdentity(identity); const current = load(); const previous = findHost(current, id);
    if (previous?.paused ?? defaultPaused) return { recorded: false, reason: 'paused', ...state() };
    const rejected = commandRejection(command) || (appearsSensitive(command) ? 'sensitive' : null);
    if (rejected) return { recorded: false, reason: rejected, ...state() };
    const time = timestamp(current); const next = copy(current); const host = ensureHost(next, id, time);
    if (!host) return { recorded: false, reason: 'host-limit', ...state() };
    const old = host.entries.find(entry => entry.command === command);
    const entry = { id: old?.id || randomUUID(), command, lastUsed: time, count: old ? Math.min(Number.MAX_SAFE_INTEGER, old.count + 1) : 1 };
    host.entries = [entry, ...host.entries.filter(item => item.command !== command)].slice(0, MAX_ENTRIES);
    touch(next, host, time); trim(next); persist(next);
    return { recorded: true, id: entry.id, ...state() };
  }
  function remove(identity, entryId) {
    const id = normalizeIdentity(identity);
    if (typeof entryId !== 'string' || !UUID.test(entryId)) throw failure('SSH_HISTORY_ENTRY_INVALID', 'SSH 历史记录标识无效');
    const current = load(); const host = findHost(current, id);
    if (!host?.entries.some(entry => entry.id === entryId)) return list(id);
    const next = copy(current); const changed = findHost(next, id); changed.entries = changed.entries.filter(entry => entry.id !== entryId);
    persist(next); return list(id);
  }
  function clear(identity) {
    const id = normalizeIdentity(identity); const current = load(); const host = findHost(current, id);
    if (!host?.entries.length) return list(id);
    const next = copy(current); findHost(next, id).entries = []; persist(next); return list(id);
  }
  function setPaused(identity, paused) {
    const id = normalizeIdentity(identity);
    if (typeof paused !== 'boolean') throw failure('SSH_HISTORY_PAUSE_INVALID', 'SSH 历史暂停参数无效');
    const current = load(); const existing = findHost(current, id);
    if ((existing?.paused ?? defaultPaused) === paused) return list(id);
    const time = timestamp(current); const next = copy(current); const host = ensureHost(next, id, time);
    if (!host) throw failure('SSH_HISTORY_HOST_LIMIT', '已达到 64 个主机的历史上限，请先恢复一个不再需要暂停的主机');
    host.paused = paused; touch(next, host, time); trim(next); persist(next); return list(id);
  }
  return { list, record, remove, clear, setPaused };
}

module.exports = { createSshCommandHistory };
