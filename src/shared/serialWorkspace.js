import { tr } from './i18n.js';
export const SERIAL_VIEW_LIMIT = 10000;
const MAX_ROWS = SERIAL_VIEW_LIMIT;
export const SERIAL_WORKSPACES = Object.freeze(['rs232', 'terminal']);

export function emptySerialSnapshot(workspace = 'rs232') {
  return { workspace, status: 'disconnected', path: '', sessionId: '', error: '', sending: false, revision: -1,
    rxBytes: 0, txBytes: 0, evicted: 0, firstId: 0, lastId: 0, unsaved: false, entries: [], needsSnapshot: false };
}

function firstIndexAtOrAfter(entries, id) {
  let low = 0; let high = entries.length;
  while (low < high) { const middle = (low + high) >>> 1; if (entries[middle].id < id) low = middle + 1; else high = middle; }
  return low;
}

function mergeRows(previous, changed, firstId, lastId) {
  if (!(firstId > 0) || lastId < firstId) return [];
  const start = firstIndexAtOrAfter(previous, firstId);
  const end = firstIndexAtOrAfter(previous, lastId + 1);
  const retained = start === 0 && end === previous.length ? previous : previous.slice(start, end);
  const updates = [...new Map((changed || []).map(row => [row.id, row])).values()]
    .filter(row => row.id >= firstId && row.id <= lastId).sort((left, right) => left.id - right.id);
  if (!updates.length) return retained;
  if (!retained.length) return updates.slice(-MAX_ROWS);
  if (updates[0].id > retained.at(-1).id) {
    const appended = retained.concat(updates);
    return appended.length > MAX_ROWS ? appended.slice(-MAX_ROWS) : appended;
  }
  const merged = []; let left = 0; let right = 0;
  while (left < retained.length && right < updates.length) {
    if (retained[left].id < updates[right].id) merged.push(retained[left++]);
    else {
      if (retained[left].id === updates[right].id) left++;
      merged.push(updates[right++]);
    }
  }
  while (left < retained.length) merged.push(retained[left++]);
  while (right < updates.length) merged.push(updates[right++]);
  return merged.length > MAX_ROWS ? merged.slice(-MAX_ROWS) : merged;
}

function mergeSnapshot(current, incoming, replace) {
  if (!incoming || !Number.isFinite(incoming.revision) || incoming.revision < current.revision) return current;
  const firstId = incoming.firstId ?? current.firstId;
  const lastId = incoming.lastId ?? current.lastId;
  const entries = mergeRows(replace ? [] : current.entries, incoming.entries, firstId, lastId);
  const complete = firstId === 0 && lastId === 0 ? entries.length === 0
    : entries.length === lastId - firstId + 1 && entries[0]?.id === firstId && entries.at(-1)?.id === lastId;
  return { ...current, ...incoming, entries, needsSnapshot: !complete };
}

export function applySerialDelta(current, delta) {
  const merged = mergeSnapshot(current, delta, Boolean(delta?.reset));
  if (merged === current) return current;
  const missedUpdate = Number.isFinite(delta?.baseRevision) && delta.baseRevision > current.revision;
  return { ...merged, needsSnapshot: current.needsSnapshot || merged.needsSnapshot || missedUpdate };
}

export function applySerialSnapshot(current, snapshot) {
  return mergeSnapshot(current, snapshot, true);
}

export function emptySerialWorkspaces() {
  return Object.fromEntries(SERIAL_WORKSPACES.map(workspace => [workspace, emptySerialSnapshot(workspace)]));
}

function applyWorkspace(current, incoming, reducer) {
  const workspace = incoming?.workspace;
  if (!SERIAL_WORKSPACES.includes(workspace)) return current;
  const next = reducer(current[workspace], incoming);
  return next === current[workspace] ? current : { ...current, [workspace]: next };
}

export function applySerialWorkspaceSnapshot(current, snapshot) { return applyWorkspace(current, snapshot, applySerialSnapshot); }
export function applySerialWorkspaceDelta(current, delta) { return applyWorkspace(current, delta, applySerialDelta); }

// UI-only session state survives page navigation, never connects or sends on restoration.
const workspace = { selectedPath: '', draft: '', advanced: false, terminalSelectedPath: '', terminalAdvanced: false, commandsOpen: false, following: true, mode: 'rs232', terminal: { enter: 'cr', backspace: 'del', localEcho: false, expanded: false, style: 'current' } };
export function readSerialWorkspace() { return { ...workspace, terminal: { ...workspace.terminal } }; }
export function updateSerialWorkspace(changes) { Object.assign(workspace, changes); }

export function createSerialDiscovery({ list, onResult }) {
  let disposed = false;
  let pending;
  return {
    refresh() {
      if (disposed) return Promise.resolve();
      if (pending) return pending;
      pending = (async () => {
        try {
          const result = await list();
          if (!result?.success) throw new Error(result?.error || tr("无法读取串口，请检查驱动后刷新"));
          if (!disposed) onResult({ ports: result.ports || [], error: '' });
        } catch (error) {
          if (!disposed) onResult({ error: error.message || tr("无法读取串口，请检查驱动后刷新") });
        }
      })().finally(() => { pending = null; });
      return pending;
    },
    dispose() { disposed = true; },
  };
}
