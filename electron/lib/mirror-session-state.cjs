const { randomUUID } = require('node:crypto');
const { normalizeMirrorLogEvent } = require('./mirror-diagnostics.cjs');
const ACTIVE = new Set(['starting', 'unconfirmed', 'running']);

function createMirrorSessionState({ now = Date.now, id = randomUUID, notify = () => {} } = {}) {
  const sessions = new Map(); let listener = notify;
  const view = row => row && { ...row };
  const publish = () => { try { listener({ sessions: [...sessions.values()].map(view) }); } catch { /* Observing cannot change mirroring. */ } };
  const current = ticket => { const row = sessions.get(ticket?.deviceId); return row?.id === ticket?.id && row.generation === ticket.generation ? row : null; };
  const change = (row, patch) => { Object.assign(row, patch, { updatedAt: now() }); publish(); return view(row); };
  function begin({ deviceId, transport, generation = 0 }) {
    const previous = sessions.get(deviceId);
    if (previous && ACTIVE.has(previous.phase) && previous.generation === generation) return { ticket: { id: previous.id, deviceId, generation }, alreadyActive: true };
    if (sessions.size >= 100 && !previous) {
      const ended = [...sessions.values()].filter(row => !ACTIVE.has(row.phase)).sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (ended) sessions.delete(ended.deviceId);
      else throw Object.assign(new Error('MIRROR_SESSION_CAPACITY'), { code: 'MIRROR_SESSION_CAPACITY' });
    }
    const row = { id: id(), deviceId, transport, generation, phase: 'starting', pictureConfirmed: false, readiness: 'none', reason: 'NONE',
      attemptNumber: 0, startedAt: now(), updatedAt: now(), endedAt: null, profileStatus: 'none' };
    sessions.set(deviceId, row); publish(); return { ticket: { id: row.id, deviceId, generation }, alreadyActive: false };
  }
  function observe(ticket, event) {
    const row = current(ticket), diagnostic = normalizeMirrorLogEvent(event);
    if (!row || !diagnostic || row.transport !== diagnostic.transport || diagnostic.attemptNumber === 0
      || !ACTIVE.has(row.phase) || (diagnostic.attemptNumber || 0) < row.attemptNumber) return false;
    const patch = { attemptNumber: diagnostic.attemptNumber || row.attemptNumber };
    for (const key of ['reason', 'audioMode', 'toolVersion']) if (diagnostic[key] !== undefined) patch[key] = diagnostic[key];
    if (diagnostic.event === 'ready') Object.assign(patch, { phase: 'running', readiness: diagnostic.readiness,
      pictureConfirmed: row.pictureConfirmed || diagnostic.readiness === 'decoded-frame' });
    if (diagnostic.event === 'startup-unconfirmed') patch.phase = 'unconfirmed';
    if (['exit', 'failure', 'stop'].includes(diagnostic.event)) Object.assign(patch, { phase: diagnostic.event === 'failure' ? 'failed' : 'exited', endedAt: now(),
      ...(diagnostic.exitCode !== undefined ? { exitCode: diagnostic.exitCode } : {}) });
    change(row, patch); return true;
  }
  return { begin, observe, current: ticket => view(current(ticket)), get: deviceId => view(sessions.get(deviceId)), active: ticket => ACTIVE.has(current(ticket)?.phase),
    snapshot: () => ({ sessions: [...sessions.values()].map(view) }), setNotify(value) { listener = value || (() => {}); },
    beginAudioFallback(ticket, fromAttempt) {
      const row = current(ticket);
      if (!row || row.transport !== 'adb' || row.phase !== 'starting' || fromAttempt !== 1 || row.attemptNumber !== fromAttempt) return false;
      change(row, { attemptNumber: 2, phase: 'starting', reason: 'AUDIO_CAPTURE', audioMode: 'disabled', readiness: 'none', pictureConfirmed: false }); return true;
    },
    confirm(ticket, readiness = 'user-confirmed') { const row = current(ticket); if (!row || !['running', 'unconfirmed'].includes(row.phase)) return false; change(row, { phase: 'running', pictureConfirmed: true, readiness }); return true; },
    update(ticket, patch) { const row = current(ticket); return row ? change(row, patch) : null; },
    fail(ticket, reason = 'UNKNOWN') { const row = current(ticket); return row && ACTIVE.has(row.phase) ? change(row, { phase: 'failed', endedAt: now(), reason }) : null; } };
}
const mirrorSessions = createMirrorSessionState();
module.exports = { createMirrorSessionState, mirrorSessions, ACTIVE };
