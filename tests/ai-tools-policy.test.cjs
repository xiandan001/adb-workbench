const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCommandName, validateArguments, DEFAULT_LIMITS } = require('../electron/lib/ai-tools-policy.cjs');

test('command names are exact, bounded and do not accept paths or prototype names', () => {
  for (const name of ['snapshot', 'provider_save', 'quota_query', 'queryProviderUsage']) assert.equal(validateCommandName(name), name);
  for (const name of ['', 'get_balance ', ' get_balance', '../get_balance', 'quota:get', 'a.b', '__proto__', 'constructor', 'prototype', 'a\0b', 'x'.repeat(97), null, {}, Symbol('command')]) assert.throws(() => validateCommandName(name), { code: 'AI_TOOLS_INVALID_COMMAND' });
});

test('valid JSON arguments are independently cloned and deeply frozen', () => {
  const original = { app: 'codex', filter: { types: ['one', 'two'], limit: 10, enabled: true, absent: null }, unicode: '中文 😀' };
  const checked = validateArguments(original);
  assert.deepEqual(checked, original); assert.notEqual(checked, original); assert.notEqual(checked.filter, original.filter);
  assert.equal(Object.isFrozen(checked), true); assert.equal(Object.isFrozen(checked.filter.types), true);
  original.filter.types.push('late injection'); assert.deepEqual(checked.filter.types, ['one', 'two']);
  assert.deepEqual(validateArguments(), {});
  assert.deepEqual(validateArguments(Object.assign(Object.create(null), { safe: 1 })), { safe: 1 });
});

test('argument validation never invokes getters, proxies or toJSON', () => {
  let calls = 0;
  const accessor = {}; Object.defineProperty(accessor, 'secret', { enumerable: true, get() { calls++; return 'private'; } });
  const proxy = new Proxy({}, { getPrototypeOf() { calls++; return Object.prototype; }, ownKeys() { calls++; return []; } });
  const serializer = { toJSON() { calls++; return {}; } };
  for (const value of [accessor, { child: accessor }, proxy, { proxy }, serializer]) assert.throws(() => validateArguments(value), { code: 'AI_TOOLS_INVALID_ARGUMENTS' });
  assert.equal(calls, 0);
});

test('non-JSON types, cycles, holes, extra array properties and symbol channels are rejected', () => {
  const cycle = {}; cycle.self = cycle; const array = [1]; array.extra = 2;
  const sparse = new Array(2); sparse[1] = 1;
  const symbolKey = { okay: 1 }; symbolKey[Symbol('Channel')] = 7;
  const hidden = {}; Object.defineProperty(hidden, 'hidden', { value: 1 });
  for (const value of [null, [], 'string', 1, true, { x: undefined }, { x: () => {} }, { x: Symbol('Channel') }, symbolKey, hidden,
    { x: 1n }, { x: NaN }, { x: Infinity }, { x: new Date() }, { x: Buffer.from('a') }, { x: new Map() }, { x: new Uint8Array([1]) }, cycle, { x: sparse }, { x: array }]) {
    assert.throws(() => validateArguments(value), { code: 'AI_TOOLS_INVALID_ARGUMENTS' });
  }
});

test('prototype and transport placeholder keys are forbidden at every depth', () => {
  for (const key of ['__proto__', 'constructor', 'prototype', '__TAURI_CHANNEL_MARKER__', '__TAURI_TO_IPC_KEY__']) {
    const value = JSON.parse(`{"nested":{"${key}":1}}`);
    assert.throws(() => validateArguments(value), { code: 'AI_TOOLS_INVALID_ARGUMENTS' });
  }
  for (const value of ['__CHANNEL__:0', '__CHANNEL__:123', '__CHANNEL__:not-numeric', '__TAURI_CHANNEL_MARKER__']) assert.throws(() => validateArguments({ channel: value }), { code: 'AI_TOOLS_INVALID_ARGUMENTS' });
  assert.equal({}.polluted, undefined);
});

test('JSON byte, depth, node and string limits reject before unbounded traversal', () => {
  assert.equal(DEFAULT_LIMITS.maxBytes, 256 * 1024);
  assert.deepEqual(validateArguments({ text: '中' }, { maxBytes: 14 }), { text: '中' });
  assert.throws(() => validateArguments({ text: '中' }, { maxBytes: 13 }), { code: 'AI_TOOLS_ARGUMENT_LIMIT' });
  assert.throws(() => validateArguments({ a: { b: { c: 1 } } }, { maxDepth: 2 }), { code: 'AI_TOOLS_ARGUMENT_LIMIT' });
  assert.throws(() => validateArguments({ values: [1, 2, 3] }, { maxNodes: 4 }), { code: 'AI_TOOLS_ARGUMENT_LIMIT' });
  assert.throws(() => validateArguments({ text: '中中' }, { maxStringBytes: 5 }), { code: 'AI_TOOLS_ARGUMENT_LIMIT' });
  assert.throws(() => validateArguments({ values: [1, 2, 3] }, { maxArrayLength: 2 }), { code: 'AI_TOOLS_ARGUMENT_LIMIT' });
  assert.throws(() => validateArguments({ a: 1, b: 2 }, { maxObjectKeys: 1 }), { code: 'AI_TOOLS_ARGUMENT_LIMIT' });
  let shared = { value: 1 }; for (let i = 0; i < 20; i++) shared = { a: shared, b: shared };
  assert.throws(() => validateArguments(shared, { maxNodes: 100 }), { code: 'AI_TOOLS_ARGUMENT_LIMIT' });
});

test('limits cannot be disabled or raised above built-in safety ceilings', () => {
  for (const limits of [{ maxBytes: Infinity }, { maxDepth: -1 }, { maxNodes: 0 }, { maxBytes: DEFAULT_LIMITS.maxBytes + 1 }, { unknown: 10 }]) assert.throws(() => validateArguments({}, limits));
});

test('validation errors never disclose rejected argument or command secrets', () => {
  const secret = 'PRIVATE-FIXTURE-TOKEN-DO-NOT-ECHO';
  const checks = [() => validateArguments({ payload: secret.repeat(30000) }), () => validateArguments({ payload: { toJSON: secret, callable() {} } }), () => validateCommandName(`../${secret}`)];
  for (const check of checks) {
    assert.throws(check, error => { assert.equal(error.message.includes(secret), false); return true; });
  }
});
