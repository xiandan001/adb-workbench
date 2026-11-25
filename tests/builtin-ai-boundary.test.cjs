const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../electron/lib/ai-keys.cjs'), 'utf8');

function loadBridge({ builtin, packaged, resourcesPath }) {
  const root = path.resolve('fixture', 'resources');
  const filename = path.join(root, packaged ? 'app.asar' : 'source', 'electron', 'lib', 'ai-keys.cjs');
  const module = { exports: {} }, lookups = [];
  vm.runInNewContext(source, {
    module,
    __filename: filename,
    __dirname: path.dirname(filename),
    process: { resourcesPath, env: new Proxy({}, { get() { throw new Error('runtime must not read credentials from the environment'); } }) },
    require(name) {
      if (name === 'node:path') return path;
      if (name === './localization.cjs') return { tr: message => message };
      if (name === './ai-model-request-limits.cjs') return { contextTokens: 524288 };
      lookups.push(name);
      if (!builtin) throw new Error('module missing');
      return builtin;
    },
  });
  return { bridge: module.exports, lookups, root };
}

test('packaged built-in AI only loads the compiled addon and forwards an opaque slot', () => {
  const calls = [], response = {}, resourcesPath = path.resolve('installed', 'resources');
  const builtin = {
    url: 'https://apihub.agnes-ai.com/v1/chat/completions', model: 'agnes-3.0-flash', keyCount: 2,
    currentSlot: () => 1, nextSlot: () => 0, initialSlot: () => 0,
    dispatch(...args) { calls.push(args); return response; },
  };
  const { bridge, lookups } = loadBridge({ builtin, packaged: true, resourcesPath });
  assert.deepEqual(lookups, [path.join(resourcesPath, 'veylo-builtin-ai.node')]);
  assert.equal(bridge.getCurrentKeySlot(), 1);
  assert.equal(bridge.getNextKeySlot(), 0);
  assert.equal(bridge.getInitialKeySlot(), 0);
  assert.equal(bridge.AGNES_API_URL, builtin.url);
  assert.equal(bridge.AGNES_MODEL, builtin.model);
  const options = { builtinKeySlot: 1 }, callback = () => {};
  assert.equal(bridge.dispatchBuiltinRequest(options, callback), response);
  assert.deepEqual(calls, [[1, options, callback]]);
  for (const builtinKeySlot of [undefined, -1, 2, '0', 0.5]) {
    assert.throws(() => bridge.dispatchBuiltinRequest({ builtinKeySlot }, callback), { code: 'AI_BUILTIN_UNAVAILABLE' });
  }
  assert.equal(calls.length, 1);
});

test('a missing addon fails closed without looking up a plaintext key file', () => {
  for (const packaged of [true, false]) {
    const { bridge, lookups, root } = loadBridge({ packaged });
    assert.deepEqual(lookups, [path.join(root, ...(packaged ? [] : ['source', 'build', 'generated', 'builtin-ai']), 'veylo-builtin-ai.node')]);
    assert.equal(bridge.keyCount, 0);
    assert.equal(bridge.getCurrentKeySlot(), -1);
    assert.throws(() => bridge.dispatchBuiltinRequest({ builtinKeySlot: 0 }, () => {}), { code: 'AI_BUILTIN_UNAVAILABLE' });
  }
});
