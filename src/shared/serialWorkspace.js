const MAX_ROWS = 5000;

export function emptySerialSnapshot() {
  return { status: 'disconnected', path: '', sessionId: '', error: '', sending: false, revision: -1,
    rxBytes: 0, txBytes: 0, evicted: 0, firstId: 0, lastId: 0, unsaved: false, entries: [], needsSnapshot: false };
}

function mergeSnapshot(current, incoming, replace) {
  if (!incoming || !Number.isFinite(incoming.revision) || incoming.revision < current.revision) return current;
  const rows = new Map((replace ? [] : current.entries).map(row => [row.id, row]));
  for (const row of incoming.entries || []) rows.set(row.id, row);
  const firstId = incoming.firstId ?? current.firstId;
  const lastId = incoming.lastId ?? current.lastId;
  const entries = [...rows.values()].filter(row => firstId > 0 && row.id >= firstId && row.id <= lastId).sort((a, b) => a.id - b.id).slice(-MAX_ROWS);
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

// UI-only session state survives page navigation, never connects or sends on restoration.
const workspace = { selectedPath: '', draft: '', advanced: false, commandsOpen: false, following: true, mode: 'rs232', terminal: { enter: 'cr', backspace: 'del', localEcho: false, expanded: false, style: 'current' } };
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
          if (!result?.success) throw new Error(result?.error || '无法读取串口，请检查驱动后刷新');
          if (!disposed) onResult({ ports: result.ports || [], error: '' });
        } catch (error) {
          if (!disposed) onResult({ error: error.message || '无法读取串口，请检查驱动后刷新' });
        }
      })().finally(() => { pending = null; });
      return pending;
    },
    dispose() { disposed = true; },
  };
}
