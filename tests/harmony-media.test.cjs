const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHarmonyMedia, inspectPng } = require('../electron/lib/harmony-media.cjs');
const { createScreenRecordingService } = require('../electron/lib/screen-recording.cjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=', 'base64');

test('oversized decoded image dimensions are rejected even when compressed bytes are small', () => {
  const huge = Buffer.from(PNG);
  huge.writeUInt32BE(30000, 16);
  huge.writeUInt32BE(30000, 20);
  assert.throws(() => inspectPng(huge), /40 MP/);
});

function fixture(t, controls = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-harmony-capture-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const media = createHarmonyMedia({ runHdc: async (id, args, options) => {
    calls.push({ id, args, options });
    if (args.join(' ') === 'shell uitest help') return { ok: true, stdout: controls.unsupported ? 'help\n dumpLayout' : 'help\n screenCap [-p]\n dumpLayout' };
    if (args[2] === 'screenCap') {
      controls.afterCapture?.();
      return controls.captureFailure ? { ok: false, error: 'capture denied' } : { ok: true, stdout: 'saved' };
    }
    if (args[0] === 'file') {
      if (options.signal?.aborted) return { ok: false, cancelled: true, error: 'cancelled' };
      fs.writeFileSync(args[3], controls.corrupt ? 'not a PNG' : PNG);
    }
    return { ok: true, stdout: '' };
  } });
  return { directory, calls, media };
}

test('PNG capture validates the file and cleans only this capture on its original device', async t => {
  const { directory, calls, media } = fixture(t);
  const target = path.join(directory, 'result.png');
  const deviceRef = { id: 'hdc:A', transport: 'hdc', targetKey: 'A', status: 'device' };
  const result = await media.captureScreenshot('hdc:A', target, { command: 'C:\\fixture\\hdc.exe', deviceRef });
  assert.equal(result.ok, true);
  assert.deepEqual(inspectPng(fs.readFileSync(target)), { width: 1, height: 1 });
  const capture = calls.find(call => call.args[2] === 'screenCap');
  assert.match(capture.args[4], /^\/data\/local\/tmp\/awb-[a-f\d-]+\.png$/);
  assert.deepEqual(calls.at(-1).args, ['shell', 'rm', '-f', capture.args[4]]);
  for (const call of calls) { assert.equal(call.id, 'hdc:A'); assert.equal(call.options.deviceRef, deviceRef); }
  assert.deepEqual(fs.readdirSync(directory), ['result.png']);
});

test('unknown capture tools and invalid output cannot silently succeed or overwrite files', async t => {
  const absent = fixture(t, { unsupported: true });
  const missing = await absent.media.captureScreenshot('hdc:A', path.join(absent.directory, 'missing.png'));
  assert.equal(missing.code, 'DEVICE_UNSUPPORTED');
  assert.equal(absent.calls.length, 1);
  const invalid = fixture(t, { corrupt: true });
  const target = path.join(invalid.directory, 'original.png');
  fs.writeFileSync(target, 'keep original');
  const result = await invalid.media.captureScreenshot('hdc:A', target, { overwrite: true });
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep original');
  assert.equal(invalid.calls.at(-1).args[1], 'rm');
  assert.deepEqual(fs.readdirSync(invalid.directory), ['original.png']);
});

test('cancellation cleans the owned remote capture but does not save or affect another session', async t => {
  const abort = new AbortController();
  const { directory, calls, media } = fixture(t, { afterCapture: () => abort.abort() });
  const result = await media.captureScreenshot('hdc:B', path.join(directory, 'cancelled.png'), { signal: abort.signal });
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(calls.at(-1).options.signal, undefined);
  assert.ok(calls.every(call => call.id === 'hdc:B'));
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('unsupported video is honest and never runs Android recorder or toggles system recording', async t => {
  const { directory, media } = fixture(t);
  const capabilities = await media.probeMediaCapabilities('hdc:A');
  assert.equal(capabilities.screenshot.supported, true);
  assert.equal(capabilities.screenRecord.supported, false);
  assert.equal(capabilities.mirror.supported, false);
  const calls = [];
  const recorder = createScreenRecordingService({ directory,
    runAdb: (...args) => { calls.push(args); throw new Error('must not run'); },
    spawnAdb: (...args) => { calls.push(args); throw new Error('must not spawn'); } });
  const result = await recorder.start({ deviceId: 'hdc:A' });
  assert.equal(result.code, 'DEVICE_UNSUPPORTED');
  assert.deepEqual(recorder.list(), []);
  assert.deepEqual(calls, []);
});

test('concurrent device screenshots use distinct owned temporary paths', async t => {
  const { directory, calls, media } = fixture(t);
  const results = await Promise.all(['A', 'B'].map(id => media.captureScreenshot('hdc:' + id, path.join(directory, id + '.png'))));
  assert.ok(results.every(result => result.ok));
  const captures = calls.filter(call => call.args[2] === 'screenCap');
  assert.notEqual(captures[0].args[4], captures[1].args[4]);
  for (const capture of captures) assert.ok(calls.some(call => call.id === capture.id && call.args[1] === 'rm' && call.args[3] === capture.args[4]));
});
