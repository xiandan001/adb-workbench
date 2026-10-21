const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { startRecordingLog } = require('../electron/lib/recording-log.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'adb-record-log-'));
  t.after(async () => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('adb-record-log-')); await fs.rm(directory, { recursive: true, force: true }); });
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { setImmediate(() => child.emit('close', 0)); };
  const commands = [];
  return { child, commands, videoPath: path.join(directory, 'record.mp4'), spawnAdb: args => { commands.push(args); return child; } };
}

test('associated log uses independent device-scoped stream, never clears, and flushes final bytes once', async t => {
  const h = await fixture(t);
  const capture = await startRecordingLog({ deviceId: 'device-a', videoPath: h.videoPath }, { spawnAdb: h.spawnAdb });
  h.child.stdout.write(Buffer.from('first\nlast\n'));
  const [one, two] = await Promise.all([capture.stop(), capture.stop()]);
  assert.deepEqual(one, two); assert.equal(one.truncated, false);
  assert.equal(await fs.readFile(one.path, 'utf8'), 'first\nlast\n');
  assert.deepEqual(h.commands, [['-s', 'device-a', 'logcat', '-v', 'threadtime', '-T', '1']]);
});

test('log cap is explicit without blocking video and early command failure is surfaced', async t => {
  const h = await fixture(t);
  const states = [];
  const capture = await startRecordingLog({ deviceId: 'a', videoPath: h.videoPath, onState: state => states.push(state) }, { spawnAdb: h.spawnAdb, maxBytes: 5 });
  h.child.stdout.write(Buffer.from('123456789'));
  assert.equal(states.at(-1).truncated, true, 'overflow is reported before stopping recording');
  const result = await capture.stop();
  assert.equal(result.truncated, true); assert.equal(result.bytes, 5);
  assert.equal(await fs.readFile(result.path, 'utf8'), '12345');
  const second = await fixture(t);
  const failed = await startRecordingLog({ deviceId: 'a', videoPath: second.videoPath, onState: state => states.push(state) }, { spawnAdb: second.spawnAdb });
  second.child.stderr.write('device disconnected'); second.child.emit('close', 1);
  assert.match(states.at(-1).error, /disconnected/, 'early failure is reported while recording can continue');
  assert.match((await failed.stop()).error, /disconnected/);
});
