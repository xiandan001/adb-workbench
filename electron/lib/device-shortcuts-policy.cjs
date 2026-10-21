const spec = require('./device-shortcuts-spec.json');

// This synchronous migration validator mirrors the renderer validator; contract tests cover both.
function normalizeDeviceShortcuts(value) {
  const fail = () => { throw new Error('快捷操作配置无效，请检查四个按钮的名称和操作'); };
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

module.exports = { normalizeDeviceShortcuts };
