import { tr } from './i18n.js';
import spec from '../../electron/lib/device-shortcuts-spec.json' with { type: 'json' };

export const SHORTCUTS_KEY = spec.storageKey;
export const HARMONY_SHORTCUTS_KEY = 'adb-workbench.harmony-device-shortcuts.v1';
export const SHORTCUTS_CHANGED = 'device-shortcuts-changed';
export const BUILTIN_SHORTCUTS = spec.actions;

export function defaultDeviceShortcuts(deviceId = '') {
  const actions = deviceId.startsWith('hdc:') ? ['home', 'back', 'settings', 'apps'] : spec.defaultActions;
  return { version: spec.version, slots: actions.map((action, index) => ({
    id: spec.slots[index], type: 'builtin', action, label: spec.actions.find(item => item.id === action).label
  })) };
}

export function getDeviceShortcutCheck(deviceId, action, checks = []) {
  if (deviceId.startsWith('hdc:') && action.type === 'builtin' && action.action === 'power') {
    return { id: action.id, status: 'unsupported', reason: tr('鸿蒙电源控制已停用，可能导致设备失联；请编辑替换此按钮。') };
  }
  if (action.type === 'builtin' && action.action === 'apps') {
    return { id: action.id, status: 'supported', reason: tr('在当前设备卡片打开应用管理，不发送设备控制命令。') };
  }
  return checks.find(check => check.id === action.id);
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

export function readDeviceShortcuts(storage = globalThis.localStorage, deviceId = '') {
  try {
    const raw = storage.getItem(deviceId.startsWith('hdc:') ? HARMONY_SHORTCUTS_KEY : SHORTCUTS_KEY);
    return { config: raw === null ? defaultDeviceShortcuts(deviceId) : normalizeDeviceShortcuts(JSON.parse(raw)), error: '' };
  } catch (error) { return { config: null, error: tr("快捷操作读取失败，原配置未改动：{0}", { 0: error.message }) }; }
}

export function saveDeviceShortcuts(config, storage = globalThis.localStorage, notify = () => window.dispatchEvent(new Event(SHORTCUTS_CHANGED)), deviceId = '') {
  const normalized = normalizeDeviceShortcuts(config);
  storage.setItem(deviceId.startsWith('hdc:') ? HARMONY_SHORTCUTS_KEY : SHORTCUTS_KEY, JSON.stringify(normalized));
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
  return async ({ api, deviceId, shortcut, confirmShell, onOpenApps }) => {
    if (busy) return { skipped: true };
    if (typeof deviceId !== 'string' || !deviceId.trim()) throw new Error(tr("没有可操作的设备"));
    const action = validateAction(shortcut);
    const check = getDeviceShortcutCheck(deviceId, action);
    if (check?.status === 'unsupported') throw new Error(check.reason);
    busy = true;
    try {
      if (action.type === 'builtin' && action.action === 'apps') {
        if (typeof onOpenApps !== 'function') throw new Error(tr('应用管理入口不可用，请从设备卡片打开。'));
        await onOpenApps();
        return { ok: true, local: true };
      }
      if (action.type === 'shell' && (!confirmShell || !await confirmShell({ deviceId, command: action.command, label: action.label }))) return { cancelled: true };
      if (action.type === 'app') {
        if (!api?.packageLaunch) throw new Error(tr("设备控制需要在桌面应用中使用"));
        const result = await api.packageLaunch({ deviceId, packageName: action.packageName });
        if (!result?.ok) throw new Error(result?.error || tr("应用启动失败；可编辑此按钮选择其他应用"));
        return { ok: true };
      }
      if (!api?.adbShell) throw new Error(tr("设备控制需要在桌面应用中使用"));
      const builtin = action.type === 'builtin' ? BUILTIN_SHORTCUTS.find(item => item.id === action.action) : null;
      if (deviceId.startsWith('hdc:') && builtin) {
        if (['home', 'back'].includes(action.action)) {
          const nativeKey = { home: 'Home', back: 'Back' }[action.action];
          const result = await api.adbShell(deviceId, `uitest uiInput keyEvent ${nativeKey}`);
          if (!result?.success) throw new Error(result?.error || tr('设备未能执行指令'));
          return { ok: true };
        }
        if (action.action === 'settings') {
          const response = await api.packageList({ deviceId });
          const pkg = response?.packages?.find(item => ['com.ohos.settings', 'com.huawei.hmos.settings'].includes(item.packageName));
          if (!response?.ok || !pkg) throw new Error(tr('设备未提供可确认的系统设置应用，请编辑替换按钮'));
          const result = await api.packageLaunch({ deviceId, packageName: pkg.packageName });
          if (!result?.ok) throw new Error(result?.error || tr('应用启动失败'));
          return { ok: true };
        }
        throw new Error(tr('此操作适用于 Android，请编辑替换为鸿蒙设备上的应用或命令'));
      }
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
