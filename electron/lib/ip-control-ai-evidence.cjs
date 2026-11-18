const { isIP } = require('node:net');
const { tr } = require('./localization.cjs');
const { sourceBytes, recentLines } = require('./ai-workspace-limits.cjs');
const { formatHex } = require('./serial-format.cjs');

const invalid = () => Object.assign(new Error(tr('AI 上下文引用无效。')), { safe: true, code: 'AI_HANDOFF' });
const modeName = mode => mode === 'tcp-client' ? tr('TCP Client') : mode === 'tcp-server' ? tr('TCP Server') : tr('UDP');
function endpoint(host, port) {
  if (typeof host !== 'string' || host.length > 128 || !isIP(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw invalid();
  return tr('[IP已隐藏]') + ':' + port;
}

// Runs in the existing evidence worker, never on the socket event loop.
// A TCP row is a byte chunk, not necessarily one protocol message.
function captureIpControlEvidence(snapshot, checkCancelled) {
  const { entries, mode, sessionId, host, port, localPort, lastId, dropped } = snapshot;
  if (!['tcp-client', 'tcp-server', 'udp'].includes(mode) || typeof sessionId !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(sessionId)
    || !Array.isArray(entries) || entries.length > recentLines || !Number.isSafeInteger(lastId)
    || !Number.isSafeInteger(dropped) || dropped < 0 || lastId < dropped + entries.length
    || !Number.isInteger(localPort) || localPort < 0 || localPort > 65535) throw invalid();
  if (!entries.length) throw Object.assign(new Error(tr('没有可带入 AI 工作区的上下文。')), { safe: true, code: 'AI_HANDOFF' });
  const target = endpoint(host, port);
  const lines = entries.map((row, index) => {
    checkCancelled();
    if (row.id !== lastId - entries.length + index + 1 || !Number.isSafeInteger(row.at) || !Number.isFinite(new Date(row.at).getTime())
      || !['RX', 'TX'].includes(row.direction) || typeof row.hex !== 'string' || row.hex.length > 65536 * 2) throw invalid();
    const peer = mode === 'tcp-server' ? ' peer=' + endpoint(row.peerHost, row.peerPort) : '';
    return '[' + new Date(row.at).toISOString() + '] #' + row.id + ' ' + row.direction + peer + ' ' + (row.hex.length / 2) + ' B | HEX: ' + formatHex(row.hex);
  });
  const truncated = entries.length < lastId;
  return { origin: 'ip-control', title: tr('IP Control') + ' · ' + modeName(mode) + ' · ' + target, deviceId: '',
    question: tr('请分析这段 IP Control 网络收发记录。'),
    timeBasis: tr('本机会话 {0} · 本地端口 {1} · 本机收发时间（非设备事件时间）· 已选 {2}/{3} 条，缓冲区已淘汰 {4} 条。', {
      0: sessionId, 1: localPort, 2: entries.length, 3: lastId, 4: dropped }),
    text: lines.join('\n'), truncated, ...(truncated ? { windowInfo: { originalRecords: lastId, retainedRecords: entries.length, byteLimit: sourceBytes } } : {}) };
}
module.exports = { captureIpControlEvidence };
