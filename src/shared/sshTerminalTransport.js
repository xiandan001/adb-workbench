import { tr } from './i18n.js';
import { createSerialTerminalWriter } from './serialTerminalTransport.js';

function requireIdentity(sessionId, terminalId) {
  if (!sessionId || !terminalId) throw new Error(tr("SSH 会话或终端标识无效"));
}

function decodeHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    const high = hex.charCodeAt(index * 2); const low = hex.charCodeAt(index * 2 + 1);
    bytes[index] = ((high <= 57 ? high - 48 : (high & 31) + 9) << 4) | (low <= 57 ? low - 48 : (low & 31) + 9);
  }
  return bytes;
}

export function createSshTerminalReader({ sessionId, terminalId, api, write, onError = () => {},
  onShellMarker = () => {}, onShellIntegration = () => {}, onTruncated = () => {}, onReplayChange = () => {},
  intervalMs = 16, idleIntervalMs = 100, schedule = setTimeout, cancel = clearTimeout }) {
  requireIdentity(sessionId, terminalId);
  let offset = 0; let replayEnd = null; let replaying = true; let generation = 0;
  let active = false; let disposed = false; let running = false; let timer;
  let quietPolls = 0; let requested = false;
  const seenMarkers = new Set();
  async function poll() {
    if (!active || disposed || running) return;
    running = true; requested = false; const requestedGeneration = generation;
    let activity = false; let backlog = false;
    try {
      const result = await api.sshTerminalRead({ sessionId, terminalId, offset });
      if (!active || disposed || generation !== requestedGeneration) return;
      if (!result?.success) throw new Error(result?.error || tr("SSH 终端输出读取失败"));
      if (result.sessionId !== sessionId || result.terminalId !== terminalId) throw new Error(tr("SSH 输出所属终端已变化"));
      const { startOffset, endOffset, nextOffset, hex } = result;
      const start = Math.max(offset, startOffset);
      if (![startOffset, endOffset, nextOffset].every(value => Number.isSafeInteger(value) && value >= 0)
        || startOffset > endOffset || nextOffset < start || nextOffset > endOffset
        || typeof hex !== 'string' || hex.length % 2 || !/^[0-9a-f]*$/i.test(hex) || hex.length > 128 * 1024 || hex.length / 2 !== nextOffset - start) throw new Error(tr("SSH 输出游标或数据无效，已暂停读取"));
      const bytes = decodeHex(hex); activity = bytes.length > 0;
      backlog = nextOffset < endOffset;
      if (replayEnd === null) replayEnd = endOffset;
      if (result.truncated) onTruncated({ skippedBytes: Math.max(0, startOffset - offset), startOffset });
      if (result.shellIntegration) onShellIntegration(result.shellIntegration);
      const markers = (Array.isArray(result.shellMarkers) ? result.shellMarkers : [])
        .filter(marker => marker && marker.id !== undefined && Number.isSafeInteger(marker.offset) && marker.offset >= start && marker.offset <= nextOffset
          && ['prompt-start', 'prompt', 'running'].includes(marker.kind)).sort((a, b) => a.offset - b.offset);
      let written = 0;
      // Markers must be applied at their byte boundary, not after the batch's
      // echoed input. Empty reads can also carry a new prompt boundary.
      for (const marker of markers) {
        if (seenMarkers.has(marker.id)) continue;
        const boundary = marker.offset - start;
        if (boundary > written) { await write(bytes.subarray(written, boundary), replaying); offset = start + boundary; }
        if (disposed || !active || generation !== requestedGeneration) return;
        written = boundary; seenMarkers.add(marker.id);
        if (seenMarkers.size > 1024) seenMarkers.delete(seenMarkers.values().next().value);
        activity = true; onShellMarker(marker, replaying);
      }
      if (disposed || !active || generation !== requestedGeneration) return;
      if (written < bytes.length) await write(bytes.subarray(written), replaying);
      if (disposed) return;
      offset = nextOffset;
      if (generation === requestedGeneration && replaying && offset >= replayEnd) { replaying = false; onReplayChange(false); }
    } catch (failure) {
      if (!disposed && generation === requestedGeneration) { active = false; onError(failure.message || tr("SSH 终端输出读取失败")); }
    } finally {
      running = false;
      if (active && !disposed) {
        const immediate = requested || backlog || generation !== requestedGeneration;
        if (activity || immediate) quietPolls = 0;
        const delay = immediate ? 0 : activity ? intervalMs : Math.min(Math.max(intervalMs, idleIntervalMs), intervalMs * 2 ** Math.min(quietPolls++, 4));
        timer = schedule(() => { timer = undefined; void poll(); }, delay);
      }
    }
  }
  return {
    start() { if (disposed || active) return; generation++; active = true; requested = true; quietPolls = 0; replayEnd = null; replaying = true; onReplayChange(true); cancel(timer); void poll(); },
    requestRead() { if (disposed || !active) return; requested = true; quietPolls = 0; cancel(timer); timer = undefined; if (!running) void poll(); },
    pause() { generation++; active = false; requested = false; cancel(timer); },
    state() { return { offset, replaying, active, running }; },
    dispose() { disposed = true; active = false; cancel(timer); },
  };
}

export function createSshTerminalWriter({ sessionId, terminalId, api, onError = () => {}, delayMs = 0, ...options }) {
  requireIdentity(sessionId, terminalId);
  return createSerialTerminalWriter({ ...options, sessionId, delayMs,
    write: args => api.sshTerminalWrite({ ...args, terminalId }),
    onError });
}
