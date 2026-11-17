const test = require('node:test');
const assert = require('node:assert/strict');
const { readMirrorIdentity } = require('../electron/lib/mirror-device-identity.cjs');

test('Android profile identity reads only fixed strong properties with bounded output and rejects generic serials', async () => {
  const calls = [];
  const value = await readMirrorIdentity('A', { transport: 'adb' }, { runAdb: async (args, options) => {
    calls.push({ args, options }); return { ok: true, stdout: '__MIRROR_ANDROID_ID__aabbccdd11223344\n__MIRROR_SERIAL__0123456789ABCDEF\n__MIRROR_BOOT_SERIAL__unknown\n' };
  }, runHdc: () => { throw Error('Wrong transport'); } });
  assert.deepEqual(Object.keys(value), ['androidId']); assert.match(value.androidId, /^[a-f0-9]{64}$/);
  assert.equal(calls.length, 1); assert.equal(calls[0].options.timeoutMs, 1500); assert.equal(calls[0].options.maxBuffer, 4096);
  assert.doesNotMatch(calls[0].args.join(' '), /(?:input|screen|reboot|kill-server)/);
});

test('Harmony profile identity uses the existing UDID command and never substitutes the network target', async () => {
  let command;
  const value = await readMirrorIdentity('hdc:192.0.2.1:8710', { transport: 'hdc' }, { runAdb: () => { throw Error('Wrong transport'); },
    runHdc: async (_id, args) => { command = args; return { ok: true, stdout: 'udid of current device is: abcdef1234567890' }; } });
  assert.deepEqual(command, ['shell', 'bm', 'get', '-u']); assert.equal(value.transport, 'hdc'); assert.match(value.harmonyUdid, /^[a-f0-9]{64}$/);
  const unknown = await readMirrorIdentity('hdc:192.0.2.1:8710', { transport: 'hdc' }, { runHdc: async () => ({ ok: true, stdout: '192.0.2.1:8710' }) });
  assert.deepEqual(unknown, { transport: 'hdc' });
});
