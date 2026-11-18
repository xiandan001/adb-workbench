const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { tr, getLocale, withLocale } = require('./localization.cjs');

const endpoint = (host, port) => (host.includes(':') ? `[${host}]` : host) + ':' + port;
function header(s) {
  const mode = s.mode === 'tcp-client' ? tr('TCP Client') : s.mode === 'tcp-server' ? tr('TCP Server') : tr('UDP');
  return [tr('卓控台 · {0}当前记录', { 0: tr('IP Control') }),
    tr('保存范围：仅当前工作区的有限缓存，不包含另一工作区或已移出的历史记录'),
    tr('网络模式') + ': ' + mode, tr('会话：') + ' ' + s.sessionId,
    (s.mode === 'tcp-server' ? tr('本机监听 IP') : tr('远端 IP')) + ': ' + endpoint(s.host, s.port),
    tr('本地端口') + ': ' + s.localPort, tr('导出时间：{0}', { 0: new Date().toISOString() }),
    tr('已移出缓存：{0} 条{1}', { 0: s.dropped, 1: s.dropped ? tr('（记录已截断）') : '' }), '', ''].join('\n');
}
async function appendRows(file, records, check) {
  let lines = [], bytes = 0;
  for (const row of records) {
    const peer = row.peerHost ? ' ' + endpoint(row.peerHost, row.peerPort) : '';
    const hex = row.data.toString('hex').toUpperCase().replace(/(..)(?=.)/g, '$1 ');
    lines.push(`#${row.id} [${new Date(row.at).toISOString()}] ${row.direction}${peer} · ${row.data.length} B\nHEX: ${hex}\n`);
    bytes += row.data.length;
    if (bytes >= 64 * 1024 || lines.length >= 128) {
      check(); await file.writeFile(lines.join('')); lines = []; bytes = 0;
    }
  }
  if (lines.length) { check(); await file.writeFile(lines.join('')); }
}

const unsafe = () => new Error(tr('保存位置必须是普通文件，不能是链接'));
async function inspect(name) {
  let stat;
  try { stat = await fs.lstat(name, { bigint: true }); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.nlink !== 1n) throw unsafe();
  return stat;
}
const sameFile = (a, b) => a?.dev === b?.dev && a?.ino === b?.ino;
const sameVersion = (a, b) => sameFile(a, b) && a?.ctimeNs === b?.ctimeNs && a?.size === b?.size;

async function writeIpControlSnapshot(target, snapshot, { isCurrent = () => true } = {}) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || !/\.(log|txt)$/i.test(target) ||
    (process.platform === 'win32' && /[:\x00-\x1f]/.test(path.basename(target)))) {
    throw new Error(tr('请保存为 .log 或 .txt 文件'));
  }
  const check = () => { if (!isCurrent()) throw Object.assign(new Error('STALE_RECORDS'), { code: 'STALE_RECORDS' }); };
  return withLocale(getLocale(), async () => {
    check();
    const folder = await fs.realpath(path.dirname(target)), destination = path.join(folder, path.basename(target));
    const before = await inspect(destination), temporary = path.join(folder, '.ip-control-' + randomUUID() + '.tmp');
    const file = await fs.open(temporary, 'wx', 0o600);
    let staged, committed = false;
    try {
      try {
        staged = await file.stat({ bigint: true });
        await file.writeFile(header(snapshot));
        await appendRows(file, snapshot.entries, check);
        await file.sync();
      } finally { await file.close(); }
      check();
      if (!sameFile(staged, await inspect(temporary)) || !sameVersion(before, await inspect(destination)) ||
        await fs.realpath(path.dirname(target)) !== folder) throw unsafe();
      check();
      await fs.rename(temporary, destination);
      committed = true;
    } finally {
      if (!committed && staged && sameFile(staged, await inspect(temporary).catch(() => null))) await fs.unlink(temporary);
    }
  });
}
module.exports = { writeIpControlSnapshot };
