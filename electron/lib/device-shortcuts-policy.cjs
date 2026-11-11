const { tr } = require('./localization.cjs');
const spec = require('./device-shortcuts-spec.json');

// This synchronous migration validator mirrors the renderer validator; contract tests cover both.
function normalizeDeviceShortcuts(value) {
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

function normalizeDeviceShortcutOverrides(value) {
  const fail = () => { throw new Error(tr('设备独立快捷配置无效，请检查配置或恢复备份')); };
  const exact = (item, keys) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || ![Object.prototype, null].includes(Object.getPrototypeOf(item))
      || Object.keys(item).length !== keys.length || keys.some(key => !Object.hasOwn(item, key))) fail();
  };
  exact(value, ['version', 'devices']);
  if (value.version !== 1 || !Array.isArray(value.devices)) fail();
  if (value.devices.length > spec.maxDeviceOverrides) throw new Error(tr('设备独立快捷配置超过存储上限'));
  const ids = new Set();
  const devices = value.devices.map(item => {
    exact(item, ['deviceId', 'config']);
    if (typeof item.deviceId !== 'string' || !item.deviceId || item.deviceId.length > 300 || /\s/u.test(item.deviceId)
      || [...item.deviceId].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error(tr('设备快捷配置标识无效'));
    if (ids.has(item.deviceId)) fail(); ids.add(item.deviceId);
    return { deviceId: item.deviceId, config: normalizeDeviceShortcuts(item.config) };
  });
  if (ids.size !== value.devices.length) fail();
  const result = { version: 1, devices };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > spec.maxDeviceOverrideBytes) throw new Error(tr('设备独立快捷配置超过存储上限'));
  return result;
}

module.exports = { normalizeDeviceShortcuts, normalizeDeviceShortcutOverrides };
