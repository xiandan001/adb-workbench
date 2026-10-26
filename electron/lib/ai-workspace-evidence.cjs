const { createHash } = require('node:crypto');
const { tr } = require('./localization.cjs');
const { redactText } = require('./feedback-policy.cjs');

const MAX_SOURCE_BYTES = 8 * 1024;
const MAX_EVIDENCE_BYTES = 48 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });
const digest = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 24);

function checks() {
  return [
    { id: 'device_info', label: tr('设备基础信息'), description: tr('只读采集型号、Android 版本和启动时长。') },
    { id: 'logcat_snapshot', label: tr('近期设备日志'), description: tr('只读最近 400 行日志，不清空或持续抓取。') },
    { id: 'performance_snapshot', label: tr('性能基础读数'), description: tr('只读内存、CPU 统计和存储空间。') },
  ];
}

function stripControls(text) {
  return String(text).replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function sanitize(value) {
  return redactText(stripControls(value)).replace(/((?:--)?(?:password|passwd|api[_-]?key|access[_-]?token|secret)\s+)[^\s]+/gi, '$1[REDACTED]');
}

function boundedText(value, bytes = MAX_SOURCE_BYTES) {
  const input = Buffer.from(String(value), 'utf8');
  if (input.length <= bytes) return { text: input.toString('utf8'), truncated: false };
  // Keep recent evidence; never cut into a UTF-8 continuation byte.
  let start = input.length - bytes;
  while (start < input.length && (input[start] & 0xc0) === 0x80) start++;
  return { text: input.subarray(start).toString('utf8'), truncated: true };
}

function freezeEntry(source, index, now) {
  const original = stripControls(source.text);
  const safe = sanitize(original);
  const limited = boundedText(safe);
  const originalLines = original.split('\n'), safeLines = safe.split('\n');
  return { id: `E${index + 1}`, source: source.kind, label: sanitize(source.label),
    target: sanitize(source.target || ''), capturedAt: new Date(source.capturedAt ?? now).toISOString(),
    timeBasis: source.timeBasis || tr('采集时间；内容中的设备时钟未经同步'),
    text: limited.text, truncated: Boolean(source.truncated || limited.truncated),
    redactions: original === safe ? 0 : Math.max(1, originalLines.filter((line, i) => line !== safeLines[i]).length) };
}

function createEvidenceAdapter({ getLogs = () => [], getSerial = () => ({}), getSsh = () => [], readSsh, runAdb, now = Date.now }) {
  function descriptors() {
    const result = [];
    for (const log of getLogs()) {
      if (!log.entries?.length) continue;
      const id = `log:${digest(`${log.source}:${log.deviceId || ''}:${log.identity}`)}`;
      result.push({ id, label: log.source === 'file' ? tr('已打开的日志文件') : tr('ADB 日志缓冲'), kind: 'log',
        detail: log.deviceId || tr('文件来源'), read: () => ({ kind: 'log', label: log.source === 'file' ? tr('已打开的日志文件') : tr('ADB 日志缓冲'),
          target: log.deviceId || tr('文件来源'), text: log.entries.map(row => row.raw || '').join('\n'), truncated: log.truncated }) });
    }
    for (const [workspace, state] of Object.entries(getSerial())) {
      const rows = (state.entries || []).filter(row => row.sessionId === state.sessionId);
      if (!rows.length || !state.sessionId) continue;
      const label = workspace === 'terminal' ? tr('串口终端') : tr('RS232 调试');
      result.push({ id: `serial:${workspace}:${digest(state.sessionId)}`, kind: 'serial', label, detail: state.path,
        read: () => ({ kind: 'serial', label, target: `${state.path} · ${workspace}`,
          timeBasis: tr('每行前缀为本机接收或发送时间，非设备事件时间'),
          text: rows.slice(-1000).map(row => `[${row.time}] ${row.direction}: ${row.text || row.hex || ''}`).join('\n'),
          truncated: rows.length > 1000 || Number(state.evicted) > 0 }) });
    }
    for (const item of getSsh()) {
      result.push({ id: `ssh:${digest(`${item.sessionId}:${item.terminalId}`)}`, kind: 'ssh', label: item.title,
        detail: `${item.name} · ${item.host}`, read: () => ({ kind: 'ssh', label: item.title, target: `${item.name} · ${item.host}`,
          timeBasis: tr('终端缓冲快照；无可靠逐行时间，不可据此确定跨源先后顺序'),
          ...readSsh(item) }) });
    }
    return result;
  }

  async function adbRead(deviceId, args, signal) {
    if (signal?.aborted) throw fail('CANCELLED', tr('操作已取消'));
    let child;
    const stop = () => { try { child?.kill(); } catch {} };
    signal?.addEventListener('abort', stop, { once: true });
    try {
      const result = await runAdb(['-s', deviceId, ...args], { timeoutMs: 12000, maxBuffer: 128 * 1024,
        isCancelled: () => Boolean(signal?.aborted), onProcess: process => { child = process; if (signal?.aborted) stop(); } });
      if (signal?.aborted) throw fail('CANCELLED', tr('操作已取消'));
      if (!result.ok) throw fail('AI_EVIDENCE_ADB', tr('设备读取失败，请检查所选设备的连接和授权后重试。'));
      return String(result.stdout || '');
    } finally { signal?.removeEventListener('abort', stop); }
  }

  async function collect({ deviceId, selectedChecks = [], sourceIds = [], text = '', signal }) {
    if (!Array.isArray(selectedChecks) || selectedChecks.length > 3 || selectedChecks.some(id => !checks().some(check => check.id === id))
      || new Set(selectedChecks).size !== selectedChecks.length || !Array.isArray(sourceIds) || sourceIds.length > 8 || new Set(sourceIds).size !== sourceIds.length
      || typeof text !== 'string' || Buffer.byteLength(text) > 48 * 1024) throw fail('AI_EVIDENCE_INPUT', tr('证据选择无效或内容过长。'));
    if (selectedChecks.length && (typeof deviceId !== 'string' || !/^[A-Za-z0-9_.:[\]-]{1,160}$/.test(deviceId))) throw fail('AI_DEVICE_REQUIRED', tr('请选择有效的目标设备。'));
    // Snapshot buffered sources before awaiting any device read. Re-listing also
    // rejects a source whose session/file changed after the selection was shown.
    const available = descriptors();
    const raw = sourceIds.map(id => {
      const item = available.find(source => source.id === id);
      if (!item) throw fail('AI_SOURCE_CHANGED', tr('所选来源已变化，请刷新来源后重新选择。'));
      return { ...item.read(), capturedAt: now() };
    });
    if (text.trim()) raw.push({ kind: 'text', label: tr('手动补充'), target: '', text, capturedAt: now(), timeBasis: tr('用户提供内容，事件时间未经验证') });
    if (selectedChecks.length) {
      const state = await adbRead(deviceId, ['get-state'], signal);
      if (state.trim() !== 'device') throw fail('AI_DEVICE_OFFLINE', tr('所选设备已离线，未切换到其他设备。'));
      for (const id of selectedChecks) {
        let output;
        if (id === 'device_info') {
          const values = [];
          for (const property of ['ro.product.manufacturer', 'ro.product.model', 'ro.build.version.release', 'ro.build.version.sdk']) {
            values.push(`${property}: ${(await adbRead(deviceId, ['shell', 'getprop', property], signal)).trim()}`);
          }
          values.push(`uptime: ${(await adbRead(deviceId, ['shell', 'cat', '/proc/uptime'], signal)).trim()}`);
          output = values.join('\n');
        } else if (id === 'logcat_snapshot') output = await adbRead(deviceId, ['logcat', '-d', '-v', 'threadtime', '-t', '400'], signal);
        else {
          const values = [];
          for (const args of [['shell', 'cat', '/proc/meminfo'], ['shell', 'cat', '/proc/stat'], ['shell', 'df', '/data']]) {
            values.push(`${args.slice(1).join(' ')}\n${await adbRead(deviceId, args, signal)}`);
          }
          output = values.join('\n');
        }
        raw.push({ kind: 'adb', label: checks().find(check => check.id === id).label, target: deviceId, text: output, capturedAt: now() });
      }
      if ((await adbRead(deviceId, ['get-state'], signal)).trim() !== 'device') throw fail('AI_DEVICE_OFFLINE', tr('所选设备已离线，未切换到其他设备。'));
    }
    if (signal?.aborted) throw fail('CANCELLED', tr('操作已取消'));
    if (!raw.length || raw.every(item => !item.text.trim())) throw fail('AI_EVIDENCE_EMPTY', tr('没有可分析的证据，请选择来源或补充文本。'));
    const entries = raw.map((item, index) => freezeEntry(item, index, now()));
    const bytes = Buffer.byteLength(JSON.stringify(entries));
    if (bytes > MAX_EVIDENCE_BYTES) throw fail('AI_EVIDENCE_LIMIT', tr('证据总量超过 48 KiB，请减少来源后重新生成预览。'));
    return { entries, bytes, truncated: entries.some(item => item.truncated) };
  }
  return { list: () => descriptors().map(({ read: _read, ...item }) => item), collect };
}

module.exports = { createEvidenceAdapter, checks, sanitize, boundedText, freezeEntry, MAX_EVIDENCE_BYTES };
