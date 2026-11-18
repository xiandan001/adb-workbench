const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { createHash, randomUUID } = require('node:crypto');

const LIMIT = 20, MAX_BYTES = 32 * 1024;
const fail = code => ({ ok: false, code });
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));

function normalizeEndpoint(value) {
  if (!value || !['tcp-client', 'tcp-server', 'udp'].includes(value.mode)) return null;
  const { mode, port, localPort } = value;
  if (!exact(value, mode === 'udp' ? ['mode', 'host', 'port', 'localPort'] : ['mode', 'host', 'port'])) return null;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 ||
      mode === 'udp' && (!Number.isSafeInteger(localPort) || localPort < 0 || localPort > 65535)) return null;
  let host = typeof value.host === 'string' ? value.host.trim() : '';
  if (!host || host.length > 128 || !net.isIP(host)) return null;
  if (net.isIPv6(host)) {
    const [ip, zone] = host.split('%');
    if (zone && !/^[a-z\d_.-]+$/i.test(zone)) return null;
    host = new URL('http://[' + ip + ']').hostname.slice(1, -1) + (zone ? '%' + zone : '');
  }
  return { mode, host, port, ...(mode === 'udp' ? { localPort } : {}) };
}

const idFor = endpoint => createHash('sha256').update(JSON.stringify(endpoint)).digest('hex');
const sameFile = (a,b) => a?.dev === b?.dev && a?.ino === b?.ino && a?.size === b?.size && a?.mtimeMs === b?.mtimeMs;
function check(condition) { if (!condition) throw new Error('HISTORY_UNAVAILABLE'); }
function validate(raw) {
  const parsed = JSON.parse(raw); check(exact(parsed, ['version', 'entries']) && parsed.version === 1 && Array.isArray(parsed.entries) && parsed.entries.length <= LIMIT);
  const ids = new Set();
  for (const row of parsed.entries) {
    const { id, lastSuccessAt, ...rest } = row, endpoint = normalizeEndpoint(rest);
    check(endpoint && endpoint.host === rest.host && id === idFor(endpoint) && !ids.has(id) &&
      Number.isSafeInteger(lastSuccessAt) && lastSuccessAt >= 0);
    ids.add(id);
  }
  return parsed.entries;
}

function createIpControlHistory({ filename, io = fs, now = Date.now }) {
  if (!path.isAbsolute(filename)) throw new TypeError('HISTORY_PATH_INVALID');
  const file = path.resolve(filename), dir = path.dirname(file); let queue = Promise.resolve();
  async function safeParents(create) {
    let cursor = path.parse(dir).root;
    for (const segment of dir.slice(cursor.length).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      let st; try { st = await io.lstat(cursor); } catch (e) {
        if (e.code !== 'ENOENT' || !create) throw e;
        await io.mkdir(cursor); st = await io.lstat(cursor);
      }
      check(st.isDirectory() && !st.isSymbolicLink());
    }
  }
  async function statFile() {
    try {
      const st = await io.lstat(file); check(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size <= MAX_BYTES); return st;
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async function load() {
    try { await safeParents(false); } catch(e) { if (e.code === 'ENOENT') return { entries:[], st:null }; throw e; }
    const st = await statFile(); if (!st) return { entries:[], st:null };
    const handle = await io.open(file,'r');
    try {
      check(sameFile(st,await handle.stat()));
      const raw = Buffer.alloc(st.size); let total = 0;
      while (total < raw.length) { const {bytesRead}=await handle.read(raw,total,raw.length-total,total); if (!bytesRead) break; total+=bytesRead; }
      check(total === raw.length && sameFile(st,await handle.stat()));
      return { entries:validate(new TextDecoder('utf-8', {fatal:true}).decode(raw)), st };
    } finally { await handle.close(); }
  }
  async function save(entries, previous) {
    await safeParents(true);
    const tmp = path.join(dir, '.ip-control-history-' + randomUUID() + '.tmp');
    const handle = await io.open(tmp,'wx',0o600);
    try {
      try { await handle.writeFile(JSON.stringify({version:1,entries})+'\n'); await handle.sync(); }
      finally { await handle.close(); }
      await safeParents(false); const st = await statFile(); check(sameFile(previous,st));
      await io.rename(tmp,file);
    } finally { await io.unlink(tmp).catch(()=>{}); }
  }
  function schedule(operation) {
    const task = queue.then(operation).catch(()=>fail('HISTORY_UNAVAILABLE'));
    queue = task.then(()=>{}); return task;
  }
  const update = modify => schedule(async () => {
    const {entries,st} = await load(), next = modify(entries);
    if (next !== entries) await save(next,st); return {ok:true,entries:next};
  });
  return {
    flush: () => queue,
    list: () => schedule(async () => ({ok:true,entries:(await load()).entries})),
    record(value) {
      const endpoint = normalizeEndpoint(value); if (!endpoint) return Promise.resolve(fail('INVALID_ENDPOINT'));
      const id = idFor(endpoint), lastSuccessAt = now();
      return update(entries => [{id,...endpoint,lastSuccessAt}, ...entries.filter(row=>row.id!==id)].slice(0,LIMIT));
    },
    remove(args) {
      if (!exact(args,['id']) || typeof args.id !== 'string' || !/^[a-f0-9]{64}$/.test(args.id)) return Promise.resolve(fail('INVALID_ID'));
      const id = args.id; return update(entries => entries.some(row=>row.id===id) ? entries.filter(row=>row.id!==id) : entries);
    },
    clear: () => update(entries => entries.length ? [] : entries),
  };
}

module.exports = { createIpControlHistory };
