const { createHash } = require('node:crypto');
const { tr } = require('./localization.cjs');
const keyFor = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
function tail(value, max = 8192) {
  const text = String(value || '');
  const bytes = Buffer.from(text.slice(-max), 'utf8');
  let start = Math.max(0, bytes.length - max);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}
function createSourceSnapshots({ serial, ssh }) {
  return async (selection, cursors = {}, initial = false) => {
    const next = { ...cursors }, items = [];
    for (const ref of selection.serial) {
      const key = `serial:${ref.workspace}`, label = ref.workspace === 'terminal' ? tr('串口终端') : tr('RS232 调试');
      if (next[key]?.closed) continue;
      const snapshot = serial.snapshot(ref.workspace);
      if (snapshot.sessionId !== ref.sessionId) {
        items.push({ unavailable: true, warning: tr('{0} 的会话已变化，已停止采集该来源，未切换到其他会话。', { 0: label }) }); next[key] = { closed: true }; continue;
      }
      const rows = snapshot.entries || [], newest = rows.at(-1);
      if (initial) { next[key] = { id: newest?.id ?? null, textHash: newest ? keyFor(String(newest.text || newest.hex || '')) : '' }; continue; }
      const previous = next[key] || {};
      const lastIndex = previous.id === null ? -1 : rows.findIndex(row => row.id === previous.id);
      const start = Math.max(0, lastIndex, rows.length - 256);
      const lost = previous.id !== null && previous.id !== undefined && lastIndex < 0 || rows.length - Math.max(lastIndex, 0) > 256;
      const result = []; let size = 0, partial = false;
      for (const row of rows.slice(start).reverse()) {
        const original = String(row.text || row.hex || ''), hash = keyFor(original);
        if (row.id === previous.id && hash === previous.textHash) continue;
        const text = tail(original, 4096);
        partial ||= text !== original;
        const line = JSON.stringify({ id: row.id, time: row.time, direction: row.direction, text, partial: text !== original, update: row.id === previous.id });
        if (size + Buffer.byteLength(line) > 64 * 1024) break;
        result.push(line); size += Buffer.byteLength(line);
      }
      next[key] = { id: newest?.id ?? null, textHash: newest ? keyFor(String(newest.text || newest.hex || '')) : '' };
      const truncated = lost || partial || result.length < rows.slice(start).filter(row => row.id !== previous.id).length;
      items.push({ name: `serial-${ref.workspace}.jsonl`, label, text: result.reverse().join('\n'), truncated,
        ...(truncated ? { warning: tr('{0} 的缓冲增长超过本次采样窗口，部分原始数据未包含。', { 0: label }) } : {}) });
    }
    const sources = selection.ssh.length ? ssh.getAnalysisSources() : [];
    for (const ref of selection.ssh) {
      const key = `ssh:${ref.sessionId}:${ref.terminalId}`, label = tr('SSH 终端');
      if (next[key]?.closed) continue;
      const source = sources.find(item => item.sessionId === ref.sessionId && item.terminalId === ref.terminalId);
      if (!source) { items.push({ unavailable: true, warning: tr('{0} 的会话已变化，已停止采集该来源，未切换到其他会话。', { 0: label }) }); next[key] = { closed: true }; continue; }
      if (initial) { next[key] = { offset: source.endOffset }; continue; }
      const offset = next[key]?.offset ?? source.endOffset;
      if (offset === source.endOffset) continue;
      const snapshot = ssh.readAnalysisTerminal({ ...source, startOffset: Math.max(source.startOffset, offset) });
      const truncated = offset < source.startOffset || source.endOffset - offset > 8192;
      next[key] = { offset: source.endOffset };
      items.push({ name: `ssh-${keyFor(key)}.jsonl`, label: `${label} · ${source.title || source.name}`, text: tail(snapshot.text), truncated,
        ...(truncated ? { warning: tr('{0} 的缓冲增长超过本次采样窗口，部分原始数据未包含。', { 0: label }) } : {}) });
    }
    return { cursors: next, items };
  };
}
function listSources({ serial, ssh }) {
  return {
    serial: ['rs232', 'terminal'].map(workspace => ({ workspace, ...serial.snapshot(workspace) })).filter(item => item.sessionId).map(item => ({ workspace: item.workspace, sessionId: item.sessionId, label: `${item.workspace === 'terminal' ? tr('串口终端') : tr('RS232 调试')} · ${item.path || ''}` })),
    ssh: ssh.getAnalysisSources().slice(0, 20).map(item => ({ sessionId: item.sessionId, terminalId: item.terminalId, label: `${item.name} · ${item.title}` })),
  };
}
module.exports = { createSourceSnapshots, listSources };
