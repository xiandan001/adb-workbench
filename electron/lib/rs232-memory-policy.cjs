const { tr } = require('./localization.cjs');
const { types } = require('node:util');
const RS232_MEMORY_KEY = 'adb-workbench.rs232-memory.v1';
const RS232_MEMORY_BYTES = 32768;
const safeIds = new Set([14,37,39,42,46,48,50,52,54,56,58,62,63,84,111].map(value => `lango-${String(value).padStart(3,'0')}`));
const commandId = value => typeof value === 'string' && (/^lango-\d{3}$/.test(value) && Number(value.slice(6)) >= 1 && Number(value.slice(6)) <= 111 || /^lango-report-[1-4]$/.test(value) || /^custom-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value));
const fail = () => { throw Error(tr('协议操作记忆无效，原数据已保留。')); };
const text = (value, maximum) => typeof value === 'string' && value.length <= maximum && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
function fields(value, keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value), own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => !keys.includes(key)) || keys.some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value'))) fail();
}
function list(value, maximum) {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) fail();
  return Array.from({ length: value.length }, (_, index) => { const descriptor = Object.getOwnPropertyDescriptor(value, String(index)); if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(); return descriptor.value; });
}
const defaultRs232Memory = () => ({ version: 1, scopes: [] });
function normalizeRs232Memory(value) {
  fields(value, ['version', 'scopes']); if (value.version !== 1) fail();
  const scopesSeen = new Set();
  const scopes = list(value.scopes, 20).map(scope => {
    fields(scope, ['workspace', 'schemeId', 'selectedId', 'category', 'parameters', 'viewMode']);
    if (!['rs232', 'terminal'].includes(scope.workspace) || !text(scope.schemeId, 200) || scope.schemeId && !scope.schemeId.trim()
      || scope.selectedId !== '' && !commandId(scope.selectedId) || !text(scope.category, 40) || !['raw', 'transactions'].includes(scope.viewMode)) fail();
    const scopeKey = JSON.stringify([scope.workspace, scope.schemeId]); if (scopesSeen.has(scopeKey)) fail(); scopesSeen.add(scopeKey);
    const seen = new Set(), parameters = list(scope.parameters, 16).map(item => {
      fields(item, ['commandId', 'template', 'values']); fields(item.values, ['XX']);
      if (!safeIds.has(item.commandId) || seen.has(item.commandId) || !text(item.template, 512) || !item.template.trim()
        || item.template.trim().split(/\s+/u).some(token => !/^(?:[0-9a-f]{2}|\{XX\})$/i.test(token))
        || !Number.isSafeInteger(item.values.XX) || item.values.XX < 0 || item.values.XX > 255) fail();
      seen.add(item.commandId); return { commandId: item.commandId, template: item.template, values: { XX: item.values.XX } };
    });
    return { workspace: scope.workspace, schemeId: scope.schemeId, selectedId: scope.selectedId, category: scope.category, parameters, viewMode: scope.viewMode };
  });
  const next = { version: 1, scopes };
  if (new TextEncoder().encode(JSON.stringify(next)).byteLength > RS232_MEMORY_BYTES) fail();
  return next;
}

module.exports = { RS232_MEMORY_KEY, RS232_MEMORY_BYTES, normalizeRs232Memory };
