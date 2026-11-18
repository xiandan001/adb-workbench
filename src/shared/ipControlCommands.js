import { inspectHex, IP_CONTROL_MODES, validateEndpoint } from './ipControlModel.js';

// Network bytes and command aliases are local to IP Control. A send updates
// only the history key; it cannot rewrite a large or unrelated COM library.
const keys = { favorites: 'adb-workbench.ip-control.favorites.v1', history: 'adb-workbench.ip-control.send-history.v1' };
const count = { favorites: 32, history: 20 }, byteLimit = 512 * 1024;
const encoder = new TextEncoder(), cache = new WeakMap();
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const fail = code => { throw Object.assign(Error(code), { code }); };
const nameKey = name => name.toLowerCase();
const uuid = value => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const validName = name => typeof name === 'string' && name.length > 0 && name.length <= 80 &&
  name.trim() === name && !Array.from(name).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const sameSend = (a,b) => a.mode === b.mode && a.host === b.host && a.port === b.port && a.hex === b.hex;
function canonicalHost(host) {
  const ip = host.trim();
  return ip.includes(':') ? new URL('http://[' + ip + ']').hostname.slice(1,-1) : ip;
}
function validTarget(entry) {
  return IP_CONTROL_MODES.includes(entry.mode) && typeof entry.host === 'string' && entry.host.length <= 128 &&
    Number.isSafeInteger(entry.port) && !validateEndpoint(entry.host, entry.port);
}
function hexValue(value, mode) {
  const { code } = inspectHex(value, mode); if (code) fail(code);
  return value.trim().replace(/[ \t\r\n]+/g, '').toUpperCase();
}
function parse(type, raw) {
  if (raw === null) return [];
  if (typeof raw !== 'string' || raw.length > byteLimit || encoder.encode(raw).length > byteLimit) fail('STORAGE_INVALID');
  let value; try { value = JSON.parse(raw); } catch { fail('STORAGE_INVALID'); }
  if (!exact(value,['version','entries']) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > count[type]) fail('STORAGE_INVALID');
  const ids = new Set(), names = new Set(), previous = [];
  for (const row of value.entries) {
    const fav = type === 'favorites';
    if (!exact(row, fav ? ['id','name','hex'] : ['id','mode','host','port','at','hex']) ||
      !uuid(row.id) || ids.has(row.id) || typeof row.hex !== 'string' || !row.hex.length || row.hex.length % 2 ||
      row.hex.length > (row.mode === 'udp' ? 65507 : 65536) * 2 || /[^0-9A-F]/.test(row.hex)) fail('STORAGE_INVALID');
    ids.add(row.id);
    if (fav) {
      if (!validName(row.name) || names.has(nameKey(row.name))) fail('STORAGE_INVALID'); names.add(nameKey(row.name));
    } else {
      if (!validTarget(row) || canonicalHost(row.host) !== row.host || !Number.isSafeInteger(row.at) || row.at < 0 || previous.some(item => sameSend(item,row))) fail('STORAGE_INVALID');
      previous.push(row);
    }
  }
  return value.entries;
}
function getStorage(value) {
  try { const storage = value ?? globalThis.localStorage; if (!storage) throw Error(); return storage; }
  catch { fail('STORAGE_UNAVAILABLE'); }
}
function remember(storage,type,raw,rows) {
  let byKey = cache.get(storage); if (!byKey) { byKey={}; cache.set(storage,byKey); }
  const entries = Object.freeze(rows.map(item=>Object.freeze(item)));
  byKey[type] = {raw,entries}; return entries;
}
function load(storage,type) {
  let raw; try { raw = storage.getItem(keys[type]); } catch { fail('STORAGE_UNAVAILABLE'); }
  const cached = cache.get(storage)?.[type];
  return cached && raw === cached.raw ? cached.entries : remember(storage,type,raw,parse(type,raw));
}
export function readIpCommands(value) {
  const storage=getStorage(value);
  return { favorites:load(storage,'favorites'), history:load(storage,'history') };
}
const encode = entries => JSON.stringify({version:1,entries});
const byteSize = raw => encoder.encode(raw).length;
function mutate(type, value, change) {
  const storage=getStorage(value), state=readIpCommands(storage), old=state[type], next=change(old);
  if (old === next) return state;
  let raw=encode(next);
  if (type === 'history' && byteSize(raw)>byteLimit) {
    // Drop whole records from the tail. Never truncate a recorded message.
    let size=byteSize(raw);
    while (next.length && size>byteLimit) { const last=next.pop(); size-=byteSize(JSON.stringify(last))+(next.length?1:0); }
    raw=encode(next);
  }
  if (byteSize(raw)>byteLimit) fail('STORAGE_LIMIT');
  try { storage.setItem(keys[type],raw); } catch { fail('STORAGE_UNAVAILABLE'); }
  return {...state,[type]:remember(storage,type,raw,next)};
}
export function saveIpFavorite(value, storage) {
  const name=typeof value?.name === 'string' ? value.name.trim() : '';
  if (!validName(name)) fail('INVALID_NAME');
  const hex=hexValue(value?.hex);
  return mutate('favorites',storage,old=>{
    const editing=value.id !== undefined, index=editing ? old.findIndex(row=>row.id===value.id) : -1;
    if (editing && index<0) fail('NOT_FOUND');
    if (old.some((row,i)=>i!==index && nameKey(row.name)===nameKey(name))) fail('NAME_EXISTS');
    if (!editing && old.length>=count.favorites) fail('FAVORITE_LIMIT');
    const item={id:editing?old[index].id:crypto.randomUUID(),name,hex};
    return editing ? old.map((row,i)=>i===index?item:row) : [item,...old];
  });
}
export function appendIpSendHistory(value,storage) {
  if (!exact(value,['mode','host','port','hex']) || !validTarget(value)) fail('INVALID_ENDPOINT');
  const target={mode:value.mode,host:canonicalHost(value.host),port:value.port,hex:hexValue(value.hex,value.mode)};
  return mutate('history',storage,old=>{
    const prior=old.find(row=>sameSend(row,target)), item={id:prior?.id || crypto.randomUUID(),...target,at:Date.now()};
    return [item,...old.filter(row=>row!==prior)].slice(0,count.history);
  });
}
function remove(type,id,storage) {
  return mutate(type,storage,old=>{
    if (!old.some(row=>row.id===id)) fail('NOT_FOUND');
    return old.filter(row=>row.id!==id);
  });
}
export const removeIpFavorite = (id,storage) => remove('favorites',id,storage);
export const removeIpSendHistory = (id,storage) => remove('history',id,storage);
export const clearIpSendHistory = storage => mutate('history',storage,old=>old.length ? [] : old);
