const { tr } = require('./localization.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function text(value, label, max, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error(tr("{0}无效", { 0: label }));
  return value.trim();
}
function validateProfile(value) {
  if (!value || typeof value !== 'object') throw new Error(tr("SSH 连接配置无效"));
  const host = text(value.host, tr("主机地址"), 253).toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (/[\s/\\@?#]/.test(host)) throw new Error(tr("主机地址只需填写 IP 或主机名，不含协议和路径"));
  const port = value.port === undefined ? 22 : Number(value.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(tr("端口必须为 1–65535"));
  const username = text(value.username, tr("用户名"), 128);
  if (!['password', 'key'].includes(value.authType)) throw new Error(tr("请选择密码或私钥认证"));
  const result = { name: text(value.name || `${username}@${host}`, tr("连接名称"), 120), host, port, username, authType: value.authType };
  if (value.id !== undefined) {
    if (typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.id)) throw new Error(tr("连接标识无效"));
    result.id = value.id;
  }
  return result;
}
const identity = profile => JSON.stringify([profile.host, profile.port, profile.username, profile.authType]);
function normalizeCredential(value, authType) {
  if (!value || typeof value !== 'object') return null;
  if (authType === 'password') {
    if (value.password === undefined) return null;
    if (typeof value.password !== 'string' || value.password.length > 4096) throw new Error(tr("密码长度无效"));
    return { password: value.password };
  }
  if (value.privateKey === undefined) return null;
  const privateKey = Buffer.isBuffer(value.privateKey) ? value.privateKey.toString('utf8') : value.privateKey;
  if (typeof privateKey !== 'string' || !privateKey.length || Buffer.byteLength(privateKey) > 1024 * 1024) throw new Error(tr("私钥文件无效或超过 1 MiB"));
  if (value.passphrase !== undefined && (typeof value.passphrase !== 'string' || value.passphrase.length > 4096)) throw new Error(tr("私钥口令长度无效"));
  return { privateKey, ...(value.passphrase === undefined ? {} : { passphrase: value.passphrase }) };
}

function createSshProfileStore({ directory, canEncrypt = () => false, encrypt, decrypt }) {
  const file = path.join(directory, 'ssh-connections.json');
  let data;
  const publicProfile = item => ({ ...item.profile, hasSavedCredential: Boolean(item.secret) });
  function load() {
    if (data) return data;
    let parsed;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw Error('invalid file');
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed.schema !== 1 || !Array.isArray(parsed.profiles) || parsed.profiles.length > 200 || !Array.isArray(parsed.knownHosts) || parsed.knownHosts.length > 1000) throw Error('schema');
      const ids = new Set();
      parsed.profiles = parsed.profiles.map(item => {
        const profile = validateProfile(item.profile);
        if (!profile.id || ids.has(profile.id) || (item.secret && (typeof item.secret !== 'string' || item.secret.length > 2 * 1024 * 1024))) throw Error('profile');
        ids.add(profile.id);
        return { profile, ...(item.secret ? { secret: item.secret } : {}) };
      });
      for (const host of parsed.knownHosts) {
        if (typeof host.host !== 'string' || host.host.length > 253 || !Number.isInteger(host.port) || host.port < 1 || host.port > 65535
          || typeof host.fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(host.fingerprint)
          || typeof host.keyType !== 'string' || host.keyType.length > 80) throw Error('known host');
      }
    } catch (error) {
      if (error.code === 'ENOENT') parsed = { schema: 1, profiles: [], knownHosts: [] };
      else throw new Error(tr("SSH 本地配置无法读取，已保留原文件，请备份后检查 ssh-connections.json"));
    }
    data = parsed;
    return data;
  }
  function persist(next) {
    const content = `${JSON.stringify(next, null, 2)}\n`;
    if (Buffer.byteLength(content) > 32 * 1024 * 1024) throw new Error(tr("SSH 本地配置超过 32 MiB，请先删除不需要的保存凭据"));
    fs.mkdirSync(directory, { recursive: true });
    const temporary = path.join(directory, `.ssh-connections-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file);
      data = next;
    } finally {
      try { fs.unlinkSync(temporary); }
      catch (error) { if (error.code !== 'ENOENT') console.warn('[SSH] encrypted temporary file cleanup pending'); }
    }
  }
  function list() { return load().profiles.map(publicProfile); }
  function get(profileId) {
    const found = load().profiles.find(item => item.profile.id === profileId);
    if (!found) throw new Error(tr("已保存的 SSH 连接不存在，请重新填写"));
    return found;
  }
  function readCredential(item) {
    if (!item?.secret) return null;
    if (!canEncrypt()) throw new Error(tr("本机安全加密不可用，请重新输入凭据"));
    try { return normalizeCredential(JSON.parse(decrypt(Buffer.from(item.secret, 'base64'))), item.profile.authType); }
    catch { throw new Error(tr("保存的 SSH 凭据无法解密，请重新输入并保存")); }
  }
  function resolve({ profileId, profile: input, credential }) {
    const existing = profileId ? get(profileId) : input?.id ? get(input.id) : null;
    const profile = input ? validateProfile(input) : existing?.profile;
    if (!profile) throw new Error(tr("请填写 SSH 连接"));
    const provided = normalizeCredential(credential, profile.authType);
    const saved = !provided && existing && identity(existing.profile) === identity(profile) ? readCredential(existing) : null;
    const auth = provided || saved;
    if (!auth) throw new Error(profile.authType === 'key' ? tr("请选择私钥并填写所需口令；不会将旧主机凭据用于新地址") : tr("请输入 SSH 密码；不会将旧主机凭据用于新地址"));
    return { ...profile, profileId: profile.id, ...auth };
  }
  function save({ profile: input, credential, rememberCredentials = false }) {
    const current = load();
    const profile = validateProfile(input);
    const existing = profile.id ? get(profile.id) : null;
    if (!existing && current.profiles.length >= 200) throw new Error(tr("最多保存 200 个连接，请先删除不需要的连接"));
    let secret;
    if (rememberCredentials) {
      if (!canEncrypt()) throw new Error(tr("本机安全加密不可用，不能保存凭据；可取消记住凭据后连接"));
      const auth = normalizeCredential(credential, profile.authType);
      if (auth) secret = encrypt(JSON.stringify(auth)).toString('base64');
      else if (existing && identity(existing.profile) === identity(profile)) secret = existing.secret;
      if (!secret) throw new Error(tr("请先提供要保存的 SSH 凭据"));
    }
    const entry = { profile: { ...profile, id: profile.id || randomUUID() }, ...(secret ? { secret } : {}) };
    persist({ ...current, profiles: existing ? current.profiles.map(item => item === existing ? entry : item) : [...current.profiles, entry] });
    return publicProfile(entry);
  }
  function remove(profileId) {
    get(profileId);
    persist({ ...load(), profiles: load().profiles.filter(item => item.profile.id !== profileId) });
  }
  async function verifyHostKey(challenge, ask) {
    const { host, port, fingerprint, keyType, signal } = challenge;
    if (signal?.aborted) return false;
    if (typeof fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(fingerprint)) throw new Error(tr("SSH 主机指纹无效"));
    const current = load();
    const previous = current.knownHosts.find(item => item.host === host && item.port === port);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error(tr("SSH 主机指纹发生变化，已拒绝连接。请先联系服务器管理员核实"));
      return true;
    }
    if (current.knownHosts.length >= 1000) throw new Error(tr("已保存的 SSH 主机指纹达到上限"));
    if (!await ask(challenge) || signal?.aborted) return false;
    // Another concurrent login may have trusted this host while the dialog was open.
    const latest = load();
    const concurrent = latest.knownHosts.find(item => item.host === host && item.port === port);
    if (concurrent && concurrent.fingerprint !== fingerprint) throw new Error(tr("SSH 主机指纹发生变化，已拒绝连接"));
    if (!concurrent) persist({ ...latest, knownHosts: [...latest.knownHosts, { host, port, fingerprint, keyType }] });
    return true;
  }
  return { list, save, remove, resolve, verifyHostKey };
}

module.exports = { createSshProfileStore, validateProfile, normalizeCredential };
