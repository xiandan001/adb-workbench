const { types } = require('node:util');

const DEFAULT_LIMITS = Object.freeze({ maxBytes: 256 * 1024, maxDepth: 20, maxNodes: 10000, maxStringBytes: 128 * 1024, maxArrayLength: 2048, maxObjectKeys: 256 });
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype', '__TAURI_CHANNEL_MARKER__', '__TAURI_TO_IPC_KEY__']);
const failure = (code, message) => Object.assign(new Error(message), { code });
const invalidArguments = () => failure('AI_TOOLS_INVALID_ARGUMENTS', 'AI 工具参数必须是无特殊对象、访问器或传输占位符的普通 JSON');
const argumentLimit = () => failure('AI_TOOLS_ARGUMENT_LIMIT', 'AI 工具参数超过安全限制，请缩小请求范围');

function validateCommandName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(name) || FORBIDDEN_KEYS.has(name)) throw failure('AI_TOOLS_INVALID_COMMAND', 'AI 工具命令名称无效');
  return name;
}

function plainRecord(value) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalidArguments();
}

function recordDescriptors(value, allowedKeys) {
  plainRecord(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || FORBIDDEN_KEYS.has(key) || allowedKeys && !allowedKeys.includes(key))) throw invalidArguments();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some(key => !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) throw invalidArguments();
  return descriptors;
}

function normalizeLimits(overrides) {
  let descriptors;
  try { descriptors = recordDescriptors(overrides, Object.keys(DEFAULT_LIMITS)); }
  catch { throw failure('AI_TOOLS_INVALID_LIMITS', 'AI 工具参数限制配置无效'); }
  const result = { ...DEFAULT_LIMITS };
  for (const [key, descriptor] of Object.entries(descriptors)) {
    const value = descriptor.value;
    if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[key]) throw failure('AI_TOOLS_INVALID_LIMITS', 'AI 工具参数限制只能收紧，不能关闭或超过上限');
    result[key] = value;
  }
  return result;
}

function validateArguments(value = {}, overrides = {}) {
  const limits = normalizeLimits(overrides); plainRecord(value);
  const ancestors = new WeakSet(); let bytes = 0; let nodes = 0;
  const addBytes = count => { bytes += count; if (bytes > limits.maxBytes) throw argumentLimit(); };
  function string(value) {
    if (value.length > limits.maxStringBytes || Buffer.byteLength(value, 'utf8') > limits.maxStringBytes) throw argumentLimit();
    if (Buffer.from(value, 'utf8').toString('utf8') !== value || value.startsWith('__CHANNEL__:') || value === '__TAURI_CHANNEL_MARKER__') throw invalidArguments();
    addBytes(Buffer.byteLength(JSON.stringify(value), 'utf8')); return value;
  }
  function visit(current, depth) {
    if (++nodes > limits.maxNodes || depth > limits.maxDepth) throw argumentLimit();
    if (current === null) { addBytes(4); return null; }
    if (typeof current === 'string') return string(current);
    if (typeof current === 'boolean') { addBytes(current ? 4 : 5); return current; }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw invalidArguments();
      addBytes(JSON.stringify(current).length); return Object.is(current, -0) ? 0 : current;
    }
    if (!current || typeof current !== 'object' || types.isProxy(current) || ancestors.has(current)) throw invalidArguments();
    const array = Array.isArray(current);
    if (array ? Object.getPrototypeOf(current) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(current))) throw invalidArguments();
    if (array && current.length > limits.maxArrayLength) throw argumentLimit();
    const keys = Reflect.ownKeys(current);
    if (keys.some(key => typeof key !== 'string' || FORBIDDEN_KEYS.has(key))) throw invalidArguments();
    if (array ? keys.length !== current.length + 1 : keys.length > limits.maxObjectKeys) {
      if (!array && keys.length > limits.maxObjectKeys) throw argumentLimit();
      throw invalidArguments();
    }
    const descriptors = Object.getOwnPropertyDescriptors(current);
    const entries = array ? Array.from({ length: current.length }, (_, index) => String(index)) : keys;
    if (entries.some(key => !Object.hasOwn(descriptors, key) || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) throw invalidArguments();
    if (array && keys.some(key => key !== 'length' && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= current.length))) throw invalidArguments();
    const result = array ? [] : {}; ancestors.add(current); addBytes(2);
    try {
      for (let index = 0; index < entries.length; index++) {
        const key = entries[index]; if (index) addBytes(1);
        if (!array) { string(key); addBytes(1); }
        const child = visit(descriptors[key].value, depth + 1);
        if (array) result.push(child); else Object.defineProperty(result, key, { value: child, enumerable: true, configurable: true, writable: true });
      }
    } finally { ancestors.delete(current); }
    return Object.freeze(result);
  }
  return visit(value, 0);
}


module.exports = { validateCommandName, validateArguments, DEFAULT_LIMITS };
