import { tr } from './i18n.js';
export const DEVICE_WORKING_STATE_KEY = 'adb-workbench.device-working-state.v1';
export const DEVICE_WORKING_LIMITS = Object.freeze({ devices: 20, draft: 8192, rows: 50000,
  output: 8 * 1024 * 1024, totalOutput: 32 * 1024 * 1024, renderedRows: 1000, renderedText: 256 * 1024, storage: 512 * 1024 });

const CONFIG_KEYS = ['terminalCommand', 'terminalFontSize', 'showTerminal', 'maintenanceOpen', 'moreToolsOpen', 'panelOrder', 'recordWithLogs', 'terminalScroll'];
const READ_ERROR = 'DEVICE_WORKING_READ';
const WRITE_ERROR = 'DEVICE_WORKING_WRITE';
export function deviceWorkingErrorMessage(code) {
  if (code === READ_ERROR) return tr('设备工作状态读取失败，原数据已保留。');
  if (code === WRITE_ERROR) return tr('设备工作状态保存失败，当前草稿仍保留，可原地重试。');
  return tr(code);
}
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exactKeys = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));

export function defaultDeviceWorkingState() {
  return { terminalCommand: '', terminalFontSize: 12, showTerminal: false, maintenanceOpen: false,
    moreToolsOpen: false, panelOrder: [], recordWithLogs: false, terminalScroll: { top: 0, atBottom: true },
    terminalOutput: [], terminalOutputTruncated: false, draftNotSaved: false, isExecuting: false, storageError: '' };
}

export function normalizeDeviceWorkingConfig(value) {
  if (!exactKeys(value, CONFIG_KEYS)) throw new Error(READ_ERROR);
  const next = defaultDeviceWorkingState();
  if (typeof value.terminalCommand !== 'string' || value.terminalCommand.length > DEVICE_WORKING_LIMITS.draft
    || !Number.isInteger(value.terminalFontSize) || value.terminalFontSize < 10 || value.terminalFontSize > 28
    || ['showTerminal', 'maintenanceOpen', 'moreToolsOpen', 'recordWithLogs'].some(key => typeof value[key] !== 'boolean')
    || !Array.isArray(value.panelOrder) || value.panelOrder.length > 2 || new Set(value.panelOrder).size !== value.panelOrder.length
    || value.panelOrder.some(panel => !['terminal', 'apk'].includes(panel))
    || !exactKeys(value.terminalScroll, ['top', 'atBottom']) || !Number.isFinite(value.terminalScroll.top)
    || value.terminalScroll.top < 0 || value.terminalScroll.top > 1000000000 || typeof value.terminalScroll.atBottom !== 'boolean') throw new Error(READ_ERROR);
  for (const key of CONFIG_KEYS) next[key] = value[key];
  return Object.fromEntries(CONFIG_KEYS.map(key => [key, next[key]]));
}

export function parseDeviceWorkingStates(raw) {
  if (raw == null) return [];
  if (typeof raw !== 'string' || raw.length > DEVICE_WORKING_LIMITS.storage) throw new Error(READ_ERROR);
  const value = JSON.parse(raw);
  if (!exactKeys(value, ['version', 'devices']) || value.version !== 1 || !Array.isArray(value.devices)
    || value.devices.length > DEVICE_WORKING_LIMITS.devices) throw new Error(READ_ERROR);
  const seen = new Set();
  return value.devices.map(item => {
    if (!exactKeys(item, ['deviceId', 'config']) || typeof item.deviceId !== 'string' || !item.deviceId.trim()
      || item.deviceId.length > 300 || [...item.deviceId].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      || seen.has(item.deviceId)) throw new Error(READ_ERROR);
    seen.add(item.deviceId);
    return { deviceId: item.deviceId, config: normalizeDeviceWorkingConfig(item.config) };
  });
}

export function boundDeviceTerminalOutput(rows) {
  const result = []; let remaining = DEVICE_WORKING_LIMITS.output / 2, truncated = rows.length > DEVICE_WORKING_LIMITS.rows;
  for (let index = rows.length - 1; index >= Math.max(0, rows.length - DEVICE_WORKING_LIMITS.rows); index--) {
    const row = rows[index];
    if (!row || !['command', 'output', 'error'].includes(row.type)) continue;
    const text = String(row.text ?? '');
    if (remaining <= 0) { truncated = true; break; }
    const kept = text.length > remaining ? structuredClone(text.slice(-remaining)) : text;
    if (kept.length !== text.length) truncated = true;
    result.push({ type: row.type, text: kept, ...(row.type === 'command' ? { prompt: row.prompt === '#' ? '#' : '$' } : {}) });
    remaining -= kept.length;
  }
  return { rows: result.reverse(), truncated };
}

export function visibleDeviceTerminalOutput(rows) {
  const visible = []; let remaining = DEVICE_WORKING_LIMITS.renderedText, clipped = false;
  for (let index = rows.length - 1; index >= 0 && visible.length < DEVICE_WORKING_LIMITS.renderedRows; index--) {
    if (remaining <= 0) break;
    const row = rows[index], text = row.text.length > remaining ? structuredClone(row.text.slice(-remaining)) : row.text;
    clipped ||= text.length !== row.text.length;
    visible.push({ ...row, text, position: index + 1 }); remaining -= text.length;
  }
  return { rows: visible.reverse(), clipped: clipped || visible.length < rows.length };
}

// Runtime output and pending requests deliberately never enter the private disk snapshot.
export function createDeviceWorkingStore({ storage = globalThis.localStorage, schedule = callback => setTimeout(callback, 350), cancel = clearTimeout } = {}) {
  const records = new Map(), saved = new Map(); let timer, dirty = false, readBlocked = false, storageError = '';
  try { for (const item of parseDeviceWorkingStates(storage?.getItem(DEVICE_WORKING_STATE_KEY))) saved.set(item.deviceId, item.config); }
  catch { readBlocked = true; storageError = READ_ERROR; }
  const notify = record => { for (const listener of record.listeners) listener(); };
  const publishStorageError = message => {
    storageError = message;
    for (const record of records.values()) { record.snapshot = { ...record.snapshot, storageError: message }; notify(record); }
  };
  const trimRecords = protectedId => {
    for (const [id, record] of records) {
      if (records.size <= DEVICE_WORKING_LIMITS.devices) break;
      if (id !== protectedId && !record.snapshot.isExecuting && !record.listeners.size) records.delete(id);
    }
  };
  const ensure = id => {
    if (!records.has(id)) {
      let maintenanceOpen = false;
      try { maintenanceOpen = storage?.getItem(`deviceMaintenance:${id}`) === 'true'; } catch { /* Private legacy preference is optional. */ }
      records.set(id, { snapshot: { ...defaultDeviceWorkingState(), maintenanceOpen, ...saved.get(id), storageError }, listeners: new Set(), outputBytes: 0 });
      trimRecords(id);
    }
    return records.get(id);
  };
  const persist = () => {
    timer = undefined;
    if (readBlocked) { publishStorageError(READ_ERROR); return false; }
    if (!dirty || !storage) return !storageError;
    try {
      const raw = JSON.stringify({ version: 1, devices: [...saved].map(([deviceId, config]) => ({ deviceId, config })) });
      if (raw.length > DEVICE_WORKING_LIMITS.storage) throw new Error(WRITE_ERROR);
      storage.setItem(DEVICE_WORKING_STATE_KEY, raw);
      dirty = false;
      if (storageError) publishStorageError('');
      return true;
    } catch { publishStorageError(WRITE_ERROR); return false; }
  };
  const queue = () => { dirty = true; if (timer === undefined) timer = schedule(persist); };
  const outputLength = record => record.outputBytes;
  const enforceOutputBudget = protectedId => {
    let total = [...records.values()].reduce((sum, record) => sum + outputLength(record), 0);
    for (const [id, record] of records) {
      if (total <= DEVICE_WORKING_LIMITS.totalOutput) break;
      if (id === protectedId || record.snapshot.isExecuting || !record.snapshot.terminalOutput.length) continue;
      total -= outputLength(record);
      record.outputBytes = 0;
      record.snapshot = { ...record.snapshot, terminalOutput: [], terminalOutputTruncated: true };
      notify(record);
    }
  };
  const update = (id, change, { silent = false } = {}) => {
    const record = ensure(id), previous = record.snapshot;
    const patch = typeof change === 'function' ? change(previous) : change;
    if (!patch || Object.keys(patch).every(key => Object.is(previous[key], patch[key]))) return previous;
    const next = { ...previous, ...patch };
    if (patch.terminalCommand !== undefined) {
      if (typeof patch.terminalCommand !== 'string') throw new Error(READ_ERROR);
      next.draftNotSaved = patch.terminalCommand.length > DEVICE_WORKING_LIMITS.draft;
    }
    if (patch.terminalOutput && patch.terminalOutput !== previous.terminalOutput) {
      const bounded = boundDeviceTerminalOutput(patch.terminalOutput);
      next.terminalOutput = bounded.rows;
      next.terminalOutputTruncated = patch.terminalOutputTruncated ?? (previous.terminalOutputTruncated || bounded.truncated);
    }
    let config;
    if (CONFIG_KEYS.some(key => !Object.is(previous[key], next[key]))) {
      const fields = Object.fromEntries(CONFIG_KEYS.map(key => [key, next[key]]));
      if (next.draftNotSaved) fields.terminalCommand = saved.get(id)?.terminalCommand || '';
      config = normalizeDeviceWorkingConfig(fields);
    }
    record.snapshot = next;
    if (patch.terminalOutput) record.outputBytes = next.terminalOutput.reduce((sum, row) => sum + row.text.length * 2, 0);
    records.delete(id); records.set(id, record);
    if (config) {
      saved.delete(id); saved.set(id, config);
      while (saved.size > DEVICE_WORKING_LIMITS.devices) saved.delete(saved.keys().next().value);
      queue();
    }
    if (!silent) notify(record);
    if (patch.terminalOutput || patch.isExecuting !== undefined) enforceOutputBudget(id);
    trimRecords(id);
    return record.snapshot;
  };
  return {
    getSnapshot: id => ensure(id).snapshot,
    subscribe(id, listener) { const record = ensure(id); record.listeners.add(listener); return () => {
      record.listeners.delete(listener); enforceOutputBudget(); trimRecords();
    }; },
    update,
    beginExecution(id) { if (ensure(id).snapshot.isExecuting) return false; update(id, { isExecuting: true }); return true; },
    flush() { if (timer !== undefined) { cancel(timer); timer = undefined; } return persist(); },
  };
}

let defaultStore;
export function deviceWorkingStore() {
  if (!defaultStore) {
    defaultStore = createDeviceWorkingStore();
    globalThis.addEventListener?.('pagehide', () => defaultStore.flush());
    globalThis.addEventListener?.('beforeunload', () => defaultStore.flush());
  }
  return defaultStore;
}
