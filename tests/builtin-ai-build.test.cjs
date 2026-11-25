const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { staticKeys, validateKeys, maskedHeader, keyPatterns, assertNoPlaintext, auditTree } = require('../scripts/build-builtin-ai.cjs');
const config = require('../electron-builder.json');
const fixtureKey = 'fake-builtin-AI-test-only';

test('accepting credentials is non-executing and accepts one literal array only', () => {
  const source = 'module.exports = { AGNES_API_KEYS: [' + JSON.stringify(fixtureKey) + '] };';
  assert.deepEqual(validateKeys(staticKeys(source)), [fixtureKey]);
  assert.deepEqual(validateKeys([fixtureKey, fixtureKey]), [fixtureKey, fixtureKey]);
  assert.deepEqual(staticKeys('module.exports = { "AGNES_API_KEYS": [] }'), []);
  for (const data of [
    constSource(),
    'module.exports = { AGNES_API_KEYS: [process.env.AGNES_API_KEYS] };',
    'module.exports = { get AGNES_API_KEYS() { throw new Error(); } };',
    'module.exports = { AGNES_API_KEYS: ["' + fixtureKey + '"], unrelated: true };',
    'module.exports = { AGNES_API_KEYS: ["' + fixtureKey,
  ]) {
    assert.throws(() => staticKeys(data), error => !error.message.includes(fixtureKey));
  }
  function constSource() { return 'const value = "' + fixtureKey + '"; module.exports = { AGNES_API_KEYS: [value] };'; }
  assert.throws(() => validateKeys([fixtureKey + '\n']));
  assert.throws(() => validateKeys([]));
});

test('generated native header contains masked bytes that reconstruct exactly the build value', () => {
  const header = maskedHeader([fixtureKey]);
  assert.ok(!header.includes(fixtureKey));
  const components = name => header.match(new RegExp(name + '0\\[\\] = \\{([\\d,]+)\\}'))[1].split(',').map(Number);
  const mask = components('mask'), encrypted = components('encrypted');
  assert.equal(Buffer.from(encrypted.map((value, i) => value ^ mask[i])).toString('ascii'), fixtureKey);
});

test('package scanner rejects exact credential bytes including straddling chunks and UTF-16', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'veylobuiltin-test-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'app.asar');
  const patterns = keyPatterns([fixtureKey]);
  for (const encoding of ['utf8', 'utf16le']) {
    await fs.writeFile(file, Buffer.from('start' + fixtureKey + 'tail', encoding));
    await assert.rejects(assertNoPlaintext(file, patterns, 6),
      error => /Plaintext builtin AI/.test(error.message) && !error.message.includes(fixtureKey));
  }
  await fs.writeFile(file, 'sanitized');
  await assertNoPlaintext(file, patterns, 2);
  const subfolder = path.join(folder, 'app.asar.unpacked', 'electron');
  await fs.mkdir(subfolder, { recursive: true });
  await fs.writeFile(path.join(subfolder, 'api-keys.cjs'), 'This private input is forbidden even if empty.');
  await assert.rejects(auditTree(folder, patterns), /Private or intermediate/);
  await fs.unlink(path.join(subfolder, 'api-keys.cjs'));
  const nativeSource = path.join(folder, 'app.asar.unpacked', 'native', 'builtin-ai');
  await fs.mkdir(nativeSource, { recursive: true });
  await fs.writeFile(path.join(nativeSource, 'binding.gyp'), '{}');
  await assert.rejects(auditTree(folder, patterns), /Private or intermediate/);
});

test('electron-builder explicitly excludes key source and audit scans the separately shipped native module', () => {
  assert.deepEqual(config.files.filter(glob => glob.includes('api-keys')), ['!electron/api-keys.cjs', '!electron/api-keys.template.cjs']);
  assert.ok(config.files.includes('!native/builtin-ai/**/*'));
  assert.equal(config.afterPack, './scripts/build-builtin-ai.cjs');
  const native = config.extraResources.find(entry => entry.to === 'veylo-builtin-ai.node');
  assert.equal(native.from, 'build/generated/builtin-ai/veylo-builtin-ai.node');
  assert.ok(config.extraResources.every(entry => !entry.from.includes('receipt.json')));
});
