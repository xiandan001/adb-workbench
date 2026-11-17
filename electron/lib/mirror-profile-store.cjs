const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { types } = require('node:util');
const { tr } = require('./localization.cjs');
const MAX_BYTES = 128 * 1024, MAX_PROFILES = 100;
const invalid = () => Object.assign(new Error(tr('已保存投屏配置无效，原文件已保留。')), { code: 'MIRROR_PROFILE_INVALID' });
const fields = (value, keys) => value && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key => keys.includes(key)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
function normalizeIdentity(value) {
  if (!fields(value, ['transport', 'harmonyUdid', 'androidId', 'roBootSerialno', 'roSerialno'])) throw invalid();
  const output = {};
  if (value.transport === 'hdc') {
    if (!/^[a-f0-9]{64}$/.test(value.harmonyUdid || '') || Object.keys(value).some(key => !['transport', 'harmonyUdid'].includes(key))) throw invalid();
    return { transport: 'hdc', harmonyUdid: value.harmonyUdid };
  }
  if (value.transport !== undefined) throw invalid();
  for (const key of ['androidId', 'roBootSerialno', 'roSerialno']) if (value[key] !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(value[key])) throw invalid(); output[key] = value[key];
  }
  if (!Object.keys(output).length) throw invalid(); return output;
}
function profileIdentityKey(identity) {
  try { return createHash('sha256').update(JSON.stringify(normalizeIdentity(identity))).digest('hex'); } catch { return null; }
}
function safeMirrorSettings(value = {}) {
  const settings = {};
  if (['2 Mbps', '4 Mbps', '8 Mbps', '16 Mbps', '32 Mbps'].includes(value.bitrate)) settings.bitrate = value.bitrate;
  if (['0', '1920', '1280', '1024', '720'].includes(value.maxSize)) settings.maxSize = value.maxSize;
  if (['default', 'disabled'].includes(value.audioMode)) settings.audioMode = value.audioMode;
  return settings;
}
function normalizeMirrorProfiles(value) {
  if (!fields(value, ['version', 'profiles']) || value.version !== 1 || !Array.isArray(value.profiles) || types.isProxy(value.profiles)
    || Object.getPrototypeOf(value.profiles) !== Array.prototype || value.profiles.length > MAX_PROFILES
    || Reflect.ownKeys(value.profiles).length !== value.profiles.length + 1) throw invalid();
  for (let index = 0; index < value.profiles.length; index++) if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value.profiles, String(index)) || {}, 'value')) throw invalid();
  const seen = new Set(), profiles = value.profiles.map(item => {
    if (!fields(item, ['id', 'identity', 'settings', 'verifiedAt', 'verification', 'toolVersion', 'globalSettings'])) throw invalid();
    const identity = normalizeIdentity(item.identity), id = profileIdentityKey(identity), settings = safeMirrorSettings(item.settings), globalSettings = safeMirrorSettings(item.globalSettings);
    if (item.id !== id || seen.has(id) || !fields(item.settings, ['bitrate', 'maxSize', 'audioMode']) || Object.keys(item.settings).some(key => settings[key] !== item.settings[key])
      || !fields(item.globalSettings, ['bitrate', 'maxSize', 'audioMode']) || Object.keys(item.globalSettings).some(key => globalSettings[key] !== item.globalSettings[key])
      || !Number.isSafeInteger(item.verifiedAt) || item.verifiedAt < 0 || !['user-confirmed', 'decoded-frame'].includes(item.verification)
      || typeof item.toolVersion !== 'string' || !/^(?:\d{1,5}(?:\.\d{1,5}){1,3})?$/.test(item.toolVersion)) throw invalid();
    seen.add(id); return { id, identity, settings, globalSettings, verifiedAt: item.verifiedAt, verification: item.verification, toolVersion: item.toolVersion };
  });
  const result = { version: 1, profiles }; if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) throw invalid(); return result;
}
function matchingProfile(store, identity) {
  let actual; try { actual = normalizeIdentity(identity); } catch { return null; }
  const matches = store.profiles.filter(item => {
    if ((item.identity.transport || 'adb') !== (actual.transport || 'adb')) return false;
    const keys = Object.keys(actual).filter(key => key !== 'transport' && item.identity[key]);
    return keys.length > 0 && keys.every(key => actual[key] === item.identity[key]);
  });
  return matches.length === 1 ? structuredClone(matches[0]) : null;
}
function createMirrorProfileStore({ filename, io = fs, now = Date.now }) {
  const target = path.resolve(filename), directory = path.dirname(target); let tail = Promise.resolve();
  const same = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino && b.isFile() && b.nlink === 1;
  async function parents(create = false) {
    let cursor = path.parse(directory).root;
    for (const part of directory.slice(cursor.length).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part); let stat;
      try { stat = await io.lstat(cursor); } catch (error) { if (!create || error.code !== 'ENOENT') throw error; await io.mkdir(cursor); stat = await io.lstat(cursor); }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
    }
  }
  async function statFile() { try { const stat = await io.lstat(target); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw invalid(); return stat; } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
  async function read() {
    let stat; try { await parents(); stat = await statFile(); } catch (error) { if (error.code === 'ENOENT') return { store: { version: 1, profiles: [] }, stat: null }; throw error; }
    if (!stat) return { store: { version: 1, profiles: [] }, stat: null };
    const handle = await io.open(target, 'r');
    try {
      if (!same(stat, await handle.stat())) throw invalid();
      const buffer = Buffer.alloc(MAX_BYTES + 1); let size = 0;
      while (size < buffer.length) { const part = await handle.read(buffer, size, buffer.length - size, size); if (!part.bytesRead) break; size += part.bytesRead; }
      const after = await handle.stat(); if (size > MAX_BYTES || size !== stat.size || !same(stat, after) || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw invalid();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
      return { store: normalizeMirrorProfiles(JSON.parse(text)), stat };
    } catch (error) { if (error instanceof SyntaxError) throw invalid(); throw error; } finally { await handle.close(); }
  }
  async function write(store, before, beforeCommit) {
    const text = JSON.stringify(normalizeMirrorProfiles(store)) + '\n'; if (Buffer.byteLength(text) > MAX_BYTES) throw invalid();
    await parents(true); const temporary = path.join(directory, `.mirror-profile-${randomUUID()}.tmp`); let handle;
    try {
      handle = await io.open(temporary, 'wx', 0o600); const opened = await handle.stat(); if (!opened.isFile() || opened.nlink !== 1) throw invalid();
      await handle.writeFile(text); await handle.sync(); await handle.close(); handle = null;
      await parents(); const written = await io.lstat(temporary); if (written.isSymbolicLink() || !same(opened, written)) throw invalid();
      const current = await statFile(); if (Boolean(current) !== Boolean(before) || current && (!same(before, current) || current.size !== before.size || current.mtimeMs !== before.mtimeMs)) throw invalid();
      beforeCommit?.(); await io.rename(temporary, target);
    } finally { await handle?.close().catch(() => {}); await io.unlink(temporary).catch(() => {}); }
  }
  function mutate(action, beforeCommit) { const pending = tail.then(async () => { const { store, stat } = await read(); const next = action(store); await write(next, stat, beforeCommit); return next; }); tail = pending.catch(() => {}); return pending; }
  return { async list() { await tail; return (await read()).store; }, async find(identity) { return matchingProfile(await this.list(), identity); },
    remember(input, beforeCommit) { return mutate(store => { const identity = normalizeIdentity(input.identity), id = profileIdentityKey(identity);
      const item = { id, identity, settings: safeMirrorSettings(input.settings), globalSettings: safeMirrorSettings(input.globalSettings), verifiedAt: now(), verification: input.verification, toolVersion: input.toolVersion || '' };
      return normalizeMirrorProfiles({ version: 1, profiles: [...store.profiles.filter(row => row.id !== id), item] }); }, beforeCommit); },
    forget(id, beforeCommit) { return mutate(store => ({ version: 1, profiles: store.profiles.filter(row => row.id !== id) }), beforeCommit); } };
}
module.exports = { createMirrorProfileStore, normalizeMirrorProfiles, profileIdentityKey, safeMirrorSettings, matchingProfile, MAX_BYTES };
