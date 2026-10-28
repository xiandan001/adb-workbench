const { createHash } = require('node:crypto');
const { tr } = require('./localization.cjs');
const { redactText } = require('./feedback-policy.cjs');
const limits = require('./ai-workspace-limits.cjs');
const { normalizeSelection, selectLines } = require('./ai-workspace-selection.cjs');
const { APP_CHECKS, diagnosticChecks, diagnosticCommand, normalizeDiagnostic } = require('./ai-workspace-diagnostics.cjs');

const MAX_SOURCE_BYTES = limits.sourceBytes;
const MAX_EVIDENCE_BYTES = limits.evidenceBytes;
const fail = (code, message) => Object.assign(new Error(message), { code });
const digest = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 24);

function checks() {
  return diagnosticChecks();
}

function stripControls(text) {
  return String(text).replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function sanitize(value) {
  return redactText(stripControls(value)).replace(/((?:--)?(?:password|passwd|api[_-]?key|access[_-]?token|secret)\s+)[^\s]+/gi, '$1[REDACTED]');
}

function boundedText(value, bytes = 8 * 1024) {
  const string = String(value);
  let startCharacter = Math.max(0, string.length - bytes);
  if (startCharacter && /[\uDC00-\uDFFF]/.test(string[startCharacter])) startCharacter++;
  const input = Buffer.from(string.slice(startCharacter), 'utf8');
  if (input.length <= bytes) return { text: input.toString('utf8'), truncated: startCharacter > 0 };
  // Keep recent evidence; never cut into a UTF-8 continuation byte.
  let start = input.length - bytes;
  while (start < input.length && (input[start] & 0xc0) === 0x80) start++;
  return { text: input.subarray(start).toString('utf8'), truncated: true };
}

function captureRows(rows, read) {
  const parts = []; let size = 0, clipped = false;
  for (let index = rows.length - 1; index >= 0 && parts.length < limits.captureRecords; index--) {
    const available = limits.logcatBufferBytes - size - (parts.length ? 1 : 0);
    if (available < 1) break;
    const limited = boundedText(read(rows[index]), available);
    parts.push(limited.text); size += Buffer.byteLength(limited.text) + (parts.length > 1 ? 1 : 0);
    if (limited.truncated) { clipped = true; break; }
  }
  const truncated = clipped || parts.length < rows.length;
  return { text: parts.reverse().join('\n'), truncated,
    ...(truncated ? { windowInfo: { originalRecords: rows.length, retainedRecords: parts.length, byteLimit: limits.logcatBufferBytes } } : {}) };
}

function freezeEntry(source, index, now, selection = normalizeSelection()) {
  // Bound both bytes and line objects before regex/split work. A single buffered
  // record can contain many lines, so the record limit alone is insufficient.
  const capture = boundedText(source.text, limits.logcatBufferBytes);
  let recent = capture.text, cut = recent.length, lines = 0;
  while (cut > 0 && lines < limits.captureRecords) { cut = recent.lastIndexOf('\n', cut - 1); if (cut < 0) break; lines++; }
  const lineWindowed = lines === limits.captureRecords && cut >= 0;
  if (lineWindowed) recent = recent.slice(cut + 1);
  const windowed = Boolean(source.windowInfo || capture.truncated || lineWindowed);
  const original = stripControls(recent);
  const selected = selectLines(original, source.kind, selection);
  // Preserve one-to-one line positions even when a multiline key is redacted.
  const mask = block => block.split(/\r\n?|\n/).map(() => '[REDACTED]').join('\n');
  const protectedLines = original.replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/g, mask)
    .replace(/^[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/, mask).replace(/\r\n?/g, '\n').split('\n');
  let rows = selected.indexes.map(position => ({ position, text: sanitize(protectedLines[position]) }));
  const textBudget = MAX_SOURCE_BYTES - selection.maxLines * 10;
  let bytes = rows.reduce((total, row) => total + Buffer.byteLength(row.text) + 1, -1);
  let first = 0;
  while (bytes > textBudget && first < rows.length - 1) bytes -= Buffer.byteLength(rows[first++].text) + 1;
  rows = rows.slice(first);
  let cutLine = false;
  if (rows.length === 1 && Buffer.byteLength(rows[0].text) > textBudget) {
    rows[0].text = boundedText(rows[0].text, textBudget).text; cutLine = true;
  }
  const events = [];
  rows.forEach((row, line) => {
    const event = selected.observations[row.position];
    if (event && events.length < 256) events.push({ line: line + 1, timestamp: event.timestamp, clockBasis: event.clockBasis });
  });
  const uncertain = rows.some(row => !selected.observations[row.position]
    || selected.observations[row.position].clockBasis !== 'explicit-offset');
  return { id: `E${index + 1}`, source: source.kind, label: sanitize(source.label),
    evidenceKind: source.checkId ? `adb:${source.checkId}` : source.kind,
    target: sanitize(source.target || ''), capturedAt: new Date(source.capturedAt ?? now).toISOString(),
    timeBasis: source.timeBasis || tr('采集时间；内容中的设备时钟未经同步'),
    text: rows.map((row, line) => `[L${line + 1}] ${row.text}`).join('\n'), numbered: true,
    targetKey: source.kind === 'adb' || source.deviceId ? digest(`device:${source.deviceId || source.target}`)
      : source.target && source.kind !== 'text' && source.target !== tr('文件来源') ? digest(`${source.kind}:${source.target}`) : null,
    truncated: Boolean(source.truncated || windowed || cutLine || rows.length < selected.selectedLineCount),
    redactions: rows.filter(row => row.text !== selected.lines[row.position]).length,
    lineCount: rows.length, originalLineCount: selected.originalLineCount,
    selectedLineCount: selected.selectedLineCount, retainedLineCount: rows.length,
    ...(windowed ? { selectionWarning: tr('仅筛选最近的有界缓冲窗口；行数与行号只覆盖此窗口，更早的匹配可能未包含。'),
      ...(source.windowInfo ? { windowInfo: source.windowInfo } : {}) } : { originalLineNumbers: rows.map(row => row.position + 1) }), events,
    ...(uncertain || selected.omittedUnknownTimeLines ? { timeWarning: tr('时间仅代表各来源自身时钟；无年份或未知时间的内容不能确定跨源先后关系。时间筛选会排除无法匹配的时间行。') } : {}) };
}

function createEvidenceAdapter({ getLogs = () => [], getSerial = () => ({}), getSsh = () => [], readSsh, runAdb, now = Date.now, processor }) {
  function descriptors() {
    const result = [];
    for (const log of getLogs()) {
      if (!log.entries?.length) continue;
      const id = `log:${digest(`${log.source}:${log.deviceId || ''}:${log.identity}`)}`;
      result.push({ id, label: log.source === 'file' ? tr('已打开的日志文件') : tr('ADB 日志缓冲'), kind: 'log',
        detail: log.deviceId || tr('文件来源'), read: () => ({ kind: 'log', label: log.source === 'file' ? tr('已打开的日志文件') : tr('ADB 日志缓冲'),
          target: log.deviceId || tr('文件来源'), deviceId: log.deviceId || null,
          ...captureRows(log.entries, row => row.raw || ''), ...(log.truncated ? { truncated: true } : {}) }) });
    }
    for (const [workspace, state] of Object.entries(getSerial())) {
      const rows = (state.entries || []).filter(row => row.sessionId === state.sessionId);
      if (!rows.length || !state.sessionId) continue;
      const label = workspace === 'terminal' ? tr('串口终端') : tr('RS232 调试');
      result.push({ id: `serial:${workspace}:${digest(state.sessionId)}`, kind: 'serial', label, detail: state.path,
        read: () => ({ kind: 'serial', label, target: `${state.path} · ${workspace}`,
          timeBasis: tr('每行前缀为本机接收或发送时间，非设备事件时间'),
          ...captureRows(rows, row => `[${row.time}] ${row.direction}: ${boundedText(row.text || row.hex || '', limits.logcatBufferBytes).text}`),
          ...(Number(state.evicted) > 0 ? { truncated: true } : {}) }) });
    }
    for (const item of getSsh()) {
      result.push({ id: `ssh:${digest(`${item.sessionId}:${item.terminalId}`)}`, kind: 'ssh', label: item.title,
        detail: `${item.name} · ${item.host}`, read: () => ({ kind: 'ssh', label: item.title, target: `${item.name} · ${item.host}`,
          timeBasis: tr('终端缓冲快照；无可靠逐行时间，不可据此确定跨源先后顺序'),
          ...readSsh(item) }) });
    }
    return result;
  }

  async function adbRead(deviceId, args, signal, maxBuffer = 128 * 1024) {
    if (signal?.aborted) throw fail('CANCELLED', tr('操作已取消'));
    let child;
    const stop = () => { try { child?.kill(); } catch {} };
    signal?.addEventListener('abort', stop, { once: true });
    try {
      const result = await runAdb(['-s', deviceId, ...args], { timeoutMs: 12000, maxBuffer,
        isCancelled: () => Boolean(signal?.aborted), onProcess: process => { child = process; if (signal?.aborted) stop(); } });
      if (signal?.aborted) throw fail('CANCELLED', tr('操作已取消'));
      if (!result.ok) throw fail('AI_EVIDENCE_ADB', tr('设备读取失败，请检查所选设备的连接和授权后重试。'));
      return String(result.stdout || '');
    } finally { signal?.removeEventListener('abort', stop); }
  }

  async function collect({ deviceId, selectedChecks = [], sourceIds = [], text = '', selection: requestedSelection, diagnostic: requestedDiagnostic, signal }) {
    const selection = normalizeSelection(requestedSelection);
    const diagnostic = normalizeDiagnostic(requestedDiagnostic);
    if (!Array.isArray(selectedChecks) || selectedChecks.length > 7 || selectedChecks.some(id => !checks().some(check => check.id === id))
      || new Set(selectedChecks).size !== selectedChecks.length || !Array.isArray(sourceIds) || sourceIds.length > 8 || new Set(sourceIds).size !== sourceIds.length
      || typeof text !== 'string' || Buffer.byteLength(text) > MAX_SOURCE_BYTES) throw fail('AI_EVIDENCE_INPUT', tr('证据选择无效或内容过长。'));
    if (selectedChecks.length && (typeof deviceId !== 'string' || !/^[A-Za-z0-9_.:[\]-]{1,160}$/.test(deviceId))) throw fail('AI_DEVICE_REQUIRED', tr('请选择有效的目标设备。'));
    for (const id of selectedChecks) if (APP_CHECKS.includes(id)) diagnosticCommand(id, diagnostic);
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
        let output, unavailable = false;
        if (APP_CHECKS.includes(id)) {
          try { output = await adbRead(deviceId, diagnosticCommand(id, diagnostic), signal, 256 * 1024); }
          catch (error) { if (signal?.aborted || error.code === 'CANCELLED') throw error; unavailable = true; output = ''; }
        } else if (id === 'device_info') {
          const values = [];
          for (const property of ['ro.product.manufacturer', 'ro.product.model', 'ro.build.version.release', 'ro.build.version.sdk']) {
            values.push(`${property}: ${(await adbRead(deviceId, ['shell', 'getprop', property], signal)).trim()}`);
          }
          values.push(`uptime: ${(await adbRead(deviceId, ['shell', 'cat', '/proc/uptime'], signal)).trim()}`);
          output = values.join('\n');
        } else if (id === 'logcat_snapshot') output = await adbRead(deviceId, ['logcat', '-d', '-v', 'threadtime', '-t', '2000'], signal, limits.logcatBufferBytes);
        else {
          const values = [];
          for (const args of [['shell', 'cat', '/proc/meminfo'], ['shell', 'cat', '/proc/stat'], ['shell', 'df', '/data']]) {
            values.push(`${args.slice(1).join(' ')}\n${await adbRead(deviceId, args, signal)}`);
          }
          output = values.join('\n');
        }
        raw.push({ kind: 'adb', checkId: id, label: checks().find(check => check.id === id).label, target: deviceId, text: output, capturedAt: now(),
          ...(APP_CHECKS.includes(id) ? { diagnostic, unavailable } : {}) });
      }
      if ((await adbRead(deviceId, ['get-state'], signal)).trim() !== 'device') throw fail('AI_DEVICE_OFFLINE', tr('所选设备已离线，未切换到其他设备。'));
    }
    if (signal?.aborted) throw fail('CANCELLED', tr('操作已取消'));
    if (!raw.length || raw.every(item => !item.text.trim() && !item.unavailable)) throw fail('AI_EVIDENCE_EMPTY', tr('没有可分析的证据，请选择来源或补充文本。'));
    const process = processor || require('./ai-workspace-compute.cjs').computeWorkspaceJob;
    const frozen = await process('freeze', { sources: raw, selection, now: now() }, { signal });
    const entries = frozen.entries;
    if (entries.every(entry => !entry.text.trim())) throw fail('AI_EVIDENCE_EMPTY', tr('没有可分析的证据，请选择来源或补充文本。'));
    const bytes = frozen.bytes;
    if (bytes > MAX_EVIDENCE_BYTES) throw fail('AI_EVIDENCE_LIMIT', tr('证据总量超过 1 MiB，请减少来源或缩小选段后重新生成预览。'));
    return { entries, bytes, selection, truncated: entries.some(item => item.truncated) };
  }
  return { list: () => descriptors().map(({ read: _read, ...item }) => item), collect,
    async verifyTarget(deviceId, signal) {
      if (typeof deviceId !== 'string' || !/^[A-Za-z0-9_.:[\]-]{1,160}$/.test(deviceId)) throw fail('AI_DEVICE_REQUIRED', tr('请选择有效的目标设备。'));
      if ((await adbRead(deviceId, ['get-state'], signal)).trim() !== 'device') throw fail('AI_DEVICE_OFFLINE', tr('所选设备已离线，未切换到其他设备。'));
    } };
}

module.exports = { createEvidenceAdapter, checks, sanitize, boundedText, freezeEntry, MAX_SOURCE_BYTES, MAX_EVIDENCE_BYTES };
