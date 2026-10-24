import { tr } from './i18n.js';
import spec from '../../electron/lib/device-shortcuts-spec.json' with { type: 'json' };

export const SHORTCUTS_KEY = spec.storageKey;
export const SHORTCUTS_CHANGED = 'device-shortcuts-changed';
export const BUILTIN_SHORTCUTS = spec.actions;

export function defaultDeviceShortcuts() {
  return { version: spec.version, slots: spec.defaultActions.map((action, index) => ({
    id: spec.slots[index], type: 'builtin', action, label: spec.actions.find(item => item.id === action).label
  })) };
}

// Keep validation identical to device-shortcuts-policy.cjs, including during data migration.
export function normalizeDeviceShortcuts(value) {
  const fail = () => { throw new Error(tr("快捷操作配置无效，请检查四个按钮的名称和操作")); };
  const hasControl = value => [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
  const object = (item, keys) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(item))
      || Object.keys(item).length !== keys.length || keys.some(key => !Object.hasOwn(item, key))) fail();
  };
  object(value, ['version', 'slots']);
  if (value.version !== spec.version || !Array.isArray(value.slots) || value.slots.length !== 4) fail();
  const ids = new Set();
  const operations = new Set();
  const slots = value.slots.map(item => {
    const field = { builtin: 'action', app: 'packageName', shell: 'command' }[item?.type];
    if (!field) fail();
    object(item, ['id', 'label', 'type', field]);
    if (!spec.slots.includes(item.id) || ids.has(item.id) || typeof item.label !== 'string'
      || !item.label.trim() || item.label.length > 16 || hasControl(item.label)) fail();
    ids.add(item.id);
    const input = item[field];
    if (typeof input !== 'string' || input !== input.trim() || !input) fail();
    if (item.type === 'builtin' && !spec.actions.some(action => action.id === input)) fail();
    if (item.type === 'app' && (input.length > 300 || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(input))) fail();
    if (item.type === 'shell' && (input.length > 2000 || hasControl(input) || /[;&|`<>]|\$\(/.test(input))) fail();
    const operation = `${item.type}:${input}`;
    if (operations.has(operation)) fail();
    operations.add(operation);
    return { id: item.id, label: item.label.trim(), type: item.type, [field]: input };
  });
  if (ids.size !== 4) fail();
  return { version: spec.version, slots };
}

export function readDeviceShortcuts(storage = globalThis.localStorage) {
  try {
    const raw = storage.getItem(SHORTCUTS_KEY);
    return { config: raw === null ? defaultDeviceShortcuts() : normalizeDeviceShortcuts(JSON.parse(raw)), error: '' };
  } catch (error) { return { config: null, error: tr("快捷操作读取失败，原配置未改动：{0}", { 0: error.message }) }; }
}

export function saveDeviceShortcuts(config, storage = globalThis.localStorage, notify = () => window.dispatchEvent(new Event(SHORTCUTS_CHANGED))) {
  const normalized = normalizeDeviceShortcuts(config);
  storage.setItem(SHORTCUTS_KEY, JSON.stringify(normalized));
  notify();
  return normalized;
}

function validateAction(shortcut) {
  const others = ['home', 'back', 'recents', 'notifications'].filter(action => shortcut?.type !== 'builtin' || shortcut.action !== action).slice(0, 3);
  return normalizeDeviceShortcuts({ version: 1, slots: [{ ...shortcut, id: 'slot-1' }, ...others.map((action, index) => ({
    id: `slot-${index + 2}`, type: 'builtin', action, label: action
  }))] }).slots[0];
}

export function createShortcutExecutor() {
  let busy = false;
  return async ({ api, deviceId, shortcut, confirmShell }) => {
    if (busy) return { skipped: true };
    if (typeof deviceId !== 'string' || !deviceId.trim()) throw new Error(tr("没有可操作的设备"));
    const action = validateAction(shortcut);
    busy = true;
    try {
      if (action.type === 'shell' && (!confirmShell || !await confirmShell({ deviceId, command: action.command, label: action.label }))) return { cancelled: true };
      if (action.type === 'app') {
        if (!api?.packageLaunch) throw new Error(tr("设备控制需要在桌面应用中使用"));
        const result = await api.packageLaunch({ deviceId, packageName: action.packageName });
        if (!result?.ok) throw new Error(result?.error || tr("应用启动失败；可编辑此按钮选择其他应用"));
        return { ok: true };
      }
      if (!api?.adbShell) throw new Error(tr("设备控制需要在桌面应用中使用"));
      const builtin = action.type === 'builtin' ? BUILTIN_SHORTCUTS.find(item => item.id === action.action) : null;
      if (builtin?.packageName) {
        const probe = await api.adbShell(deviceId, `pm path ${builtin.packageName}`);
        if (!probe.success) throw new Error(probe.error || tr("无法读取设备应用信息"));
        if (!/^package:/m.test(probe.output || '')) throw new Error(tr("设备未安装对应应用，请编辑此按钮替换操作"));
      }
      const result = await api.adbShell(deviceId, `${builtin?.command || action.command} 2>&1`);
      if (!result?.success || /(?:^|\n)\s*(?:Error(?:\s+type\s+\d+)?\s*:|Exception|java\.[\w.]+Exception)/i.test(result.output || '')) {
        throw new Error(result?.error || result?.output || tr("设备未能执行指令"));
      }
      return { ok: true };
    } finally { busy = false; }
  };
}
