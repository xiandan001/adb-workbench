const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createScreenRecordingService } = require('../electron/lib/screen-recording.cjs');
const { validateRecordingMp4 } = require('../electron/lib/screen-recording-mp4.cjs');

function box(type, bytes = 8) {
  const value = Buffer.alloc(8 + bytes);
  value.writeUInt32BE(value.length);
  value.write(type, 4, 'ascii');
  return value;
}
const mp4 = () => Buffer.concat([box('ftyp'), box('mdat', 128), box('moov', 24)]);
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-recording-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('adb-recording-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const processes = [];
  const calls = [];
  const events = [];
  const media = [];
  let simulatedNow = 1730000000000;
  const controls = { pullFailure: false, corrupt: false, signalFailure: false, offline: false, ...options };
  const runAdb = async args => {
    calls.push(args);
    if (controls.offline) return { ok: false, stdout: '', stderr: 'device offline' };
    const command = args.slice(3).join(' ');
    const proc = processes.find(item => command.includes(item.remotePath));
    const pidProcess = processes.find(item => command.includes(`/proc/${item.remotePid}`));
    if (args[2] === 'pull') {
      if (controls.pullFailure) return { ok: false, stderr: 'pull failed' };
      fs.writeFileSync(args[4], controls.corrupt ? Buffer.concat([box('ftyp'), box('mdat')]) : mp4());
      return { ok: true, stdout: 'pulled' };
    }
    if (command.includes('kill -2')) {
      if (controls.signalFailure) return { ok: false, stderr: 'signal denied' };
      assert.ok(proc && proc.owned, 'signal is sent only to exact owned recording');
      proc.owned = false;
      setImmediate(() => proc.emit('close', 0));
      return { ok: true, stdout: '' };
    }
    if (command.includes('/cmdline')) {
      return { ok: true, stdout: pidProcess?.owned ? `screenrecord\0--verbose\0${pidProcess.remotePath}\0` : '__AW_PROCESS_GONE__' };
    }
    if (command.startsWith('cat ') && command.endsWith('.pid')) return proc ? { ok: true, stdout: String(proc.remotePid) } : { ok: false, stderr: 'not found' };
    if (command.includes('printf ready')) return { ok: true, stdout: controls.noFile ? '' : 'ready' };
    if (command.includes('printf exists')) return { ok: true, stdout: controls.noFile ? 'absent' : 'exists' };
    if (command.startsWith('rm -f ')) return { ok: true, stdout: '' };
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
  const spawnAdb = args => {
    if (controls.throwSpawn) throw new Error('spawn failed');
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.remotePath = args[3].match(/(\/sdcard\/adb-workbench-screenrecord-[\w-]+\.mp4)/)[1];
    proc.remotePid = 800 + processes.length;
    proc.owned = true;
    processes.push(proc);
    setImmediate(() => {
      if (controls.errorSpawn) { proc.owned = false; proc.emit('error', new Error('spawn ENOENT')); return; }
      if (controls.splitPid) {
        proc.stdout.emit('data', Buffer.from('__AW_SCREENRECORD_PID__=8'));
        proc.stdout.emit('data', Buffer.from(`${String(proc.remotePid).slice(1)}\n`));
      } else {
        proc.stdout.emit('data', Buffer.from(`__AW_SCREENRECORD_PID__=${proc.remotePid}\n`));
      }
      if (controls.earlyClose) {
        proc.stderr.emit('data', Buffer.from('screenrecord: encoder unsupported\n'));
        proc.owned = false;
        proc.emit('close', 1);
      }
    });
    return proc;
  };
  const config = {
    directory, runAdb, spawnAdb, broadcast: payload => events.push(payload),
    now: () => simulatedNow,
    delay: async milliseconds => { simulatedNow += milliseconds; await tick(); },
    startupTimeoutMs: 1000, stopTimeoutMs: 1000,
    onSaved: async item => { media.push(item); return { id: `media-${media.length}` }; },
    ...(options.service || {})
  };
  const service = createScreenRecordingService(config);
  return { directory, service, config, controls, processes, calls, events, media };
}

test('MP4 validation scans headers, rejects missing/truncated boxes and accepts finalized containers', async t => {
  const { directory } = fixture(t);
  const file = path.join(directory, 'check.mp4');
  fs.writeFileSync(file, mp4());
  assert.equal((await validateRecordingMp4(file)).size, mp4().length);
  fs.writeFileSync(file, Buffer.concat([box('ftyp'), box('mdat')]));
  await assert.rejects(validateRecordingMp4(file), /索引/);
  fs.writeFileSync(file, mp4().subarray(0, mp4().length - 1));
  await assert.rejects(validateRecordingMp4(file), /完整/);
  fs.writeFileSync(file, Buffer.concat([box('ftyp'), box('mdat'), box('moov', 0)]));
  await assert.rejects(validateRecordingMp4(file), /索引/);
});

test('start verifies readiness, stop sends guarded SIGINT then publishes validated video and full snapshots', async t => {
  const { service, calls, processes, media, events, directory } = fixture(t);
  const started = await service.start({ deviceId: 'usb-device' });
  assert.equal(started.success, true);
  assert.equal(started.session.status, 'recording');
  assert.equal(service.hasActiveRecordings(), true);
  assert.match(started.session.remotePath, /adb-workbench-screenrecord-.*\.mp4$/);
  const stopped = await service.stop({ deviceId: 'usb-device' });
  assert.equal(stopped.success, true);
  assert.equal(stopped.session.status, 'saved');
  assert.equal(stopped.session.mediaId, 'media-1');
  assert.ok(stopped.session.savedAt >= stopped.session.endedAt);
  assert.equal(fs.existsSync(stopped.path), true);
  assert.equal(service.hasActiveRecordings(), false);
  assert.equal(media.length, 1);
  const signal = calls.find(args => args.join(' ').includes('kill -2'));
  assert.ok(signal[3].includes(`/proc/${processes[0].remotePid}/cmdline`));
  assert.ok(signal[3].includes(started.session.remotePath));
  assert.ok(signal[3].includes("tr '\\000' ' '"), 'shell receives one backslash in the NUL pattern');
  assert.equal(signal[3].includes("tr '\\\\000' ' '"), false);
  assert.equal(calls.some(args => args.join(' ').includes('pkill')), false);
  const cleanup = calls.find(args => args[3]?.startsWith('rm -f'));
  assert.ok(cleanup);
  assert.equal(events.at(-1).sessions[0].status, 'saved');
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'screen-recording-sessions.json'))).sessions[0].status, 'saved');
});

test('duplicate starts are blocked and concurrent stop requests share one save', async t => {
  const { service, calls } = fixture(t);
  const first = service.start({ deviceId: 'usb-device' });
  assert.equal((await service.start({ deviceId: 'usb-device' })).success, false);
  assert.equal((await first).success, true);
  const results = await Promise.all([service.stop({ deviceId: 'usb-device' }), service.stop({ deviceId: 'usb-device' })]);
  assert.equal(results.every(result => result.success), true);
  assert.equal(calls.filter(args => args[2] === 'pull').length, 1);
});

test('native automatic end saves recording without leaving UI recording state', async t => {
  const { service, processes } = fixture(t);
  await service.start({ deviceId: 'usb-device' });
  processes[0].owned = false;
  processes[0].emit('close', 0);
  for (let attempt = 0; attempt < 100 && service.list()[0].status !== 'saved'; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(service.list()[0].status, 'saved');
  assert.equal(service.hasActiveRecordings(), false);
});

test('failed pull keeps remote data and retry recovers original unique recording', async t => {
  const { service, calls, controls } = fixture(t, { pullFailure: true });
  const { session } = await service.start({ deviceId: 'usb-device' });
  const failed = await service.stop({ deviceId: 'usb-device' });
  assert.equal(failed.success, false);
  assert.equal(failed.session.status, 'needs-save');
  assert.equal(calls.some(args => args[3]?.startsWith('rm -f')), false);
  controls.pullFailure = false;
  const recovered = await service.retry({ id: session.id });
  assert.equal(recovered.success, true);
  assert.equal(recovered.session.remotePath, session.remotePath);
  assert.equal(calls.filter(args => args.join(' ').includes('kill -2')).length, 1);
});

test('corrupt pull is never published or deleted and retry validates again', async t => {
  const { service, controls, calls, media, directory } = fixture(t, { corrupt: true });
  await service.start({ deviceId: 'usb-device' });
  const stopped = await service.stop({ deviceId: 'usb-device' });
  assert.equal(stopped.success, false);
  assert.equal(media.length, 0);
  assert.equal(calls.some(args => args[3]?.startsWith('rm -f')), false);
  assert.deepEqual(fs.readdirSync(path.join(directory, 'screenrecord')), []);
  controls.corrupt = false;
  assert.equal((await service.retry({ id: stopped.session.id })).success, true);
});

test('restart changes active session to explicit recovery without device commands', async t => {
  const { service, config, calls, processes } = fixture(t);
  const started = await service.start({ deviceId: 'usb-device' });
  const count = calls.length;
  processes[0].removeAllListeners('close'); // The prior main process no longer exists after a restart.
  const restored = createScreenRecordingService(config);
  assert.equal(calls.length, count);
  assert.equal(restored.list()[0].status, 'needs-save');
  assert.equal((await restored.start({ deviceId: 'usb-device' })).success, false);
  const recovered = await restored.retry({ id: started.session.id });
  assert.equal(recovered.success, true);
  assert.equal(processes[0].owned, false);
});

test('PID reuse never signals unrelated process and uses only session remote file', async t => {
  const { service, processes, calls, config } = fixture(t);
  await service.start({ deviceId: 'usb-device' });
  processes[0].owned = false;
  const original = config.runAdb;
  config.runAdb = async args => args[3]?.includes('/cmdline') ? { ok: true, stdout: '/system/bin/other-app\0' } : original(args);
  const restored = createScreenRecordingService(config);
  assert.equal((await restored.retry({ id: service.list()[0].id })).success, true);
  assert.equal(calls.some(args => args.join(' ').includes('kill -2')), false);
});

test('spawn error and unsupported encoder never pretend recording is ready', async t => {
  const first = fixture(t, { errorSpawn: true });
  assert.equal((await first.service.start({ deviceId: 'a' })).success, false);
  assert.equal(first.service.list()[0].status, 'error');
  const second = fixture(t, { earlyClose: true, noFile: true });
  assert.equal((await second.service.start({ deviceId: 'b' })).success, false);
  assert.equal(second.service.list()[0].status, 'error');
  assert.match(second.service.list()[0].error, /encoder unsupported/);
});

test('disconnect and denied SIGINT retain retry state, quit reports failure rather than discarding it', async t => {
  const { service, controls, calls } = fixture(t);
  await service.start({ deviceId: 'usb-device' });
  controls.signalFailure = true;
  const stopped = await service.stopAllRecordings();
  assert.equal(stopped.success, false);
  assert.equal(stopped.failed.length, 1);
  assert.equal(calls.some(args => args[2] === 'pull'), false);
  assert.equal(service.listUnresolved().length, 1);
  controls.signalFailure = false;
  controls.offline = true;
  assert.equal((await service.retry({ id: stopped.failed[0].id })).success, false);
  controls.offline = false;
  assert.equal((await service.retry({ id: stopped.failed[0].id })).success, true);
});

test('late old-process close does not remove a newer device recording', async t => {
  const { service, processes, controls } = fixture(t, { pullFailure: true });
  await service.start({ deviceId: 'usb-device' });
  await service.stop({ deviceId: 'usb-device' });
  const next = await service.start({ deviceId: 'usb-device' });
  assert.equal(next.success, true);
  processes[0].emit('close', 0);
  await tick();
  assert.equal(service.list().find(session => session.id === next.session.id).status, 'recording');
  controls.pullFailure = false;
  await service.stop({ deviceId: 'usb-device' });
});

test('optional recording logs are associated, stopped and passed to media without invoking AI', async t => {
  let stopped = 0;
  const { service, media } = fixture(t, { service: { logCaptureFactory: async ({ videoPath }) => ({
    info: () => ({ path: videoPath.replace(/\.mp4$/, '.log'), bytes: 20 }),
    stop: async () => { stopped += 1; return { path: videoPath.replace(/\.mp4$/, '.log'), bytes: 100, truncated: true }; }
  }) } });
  const started = await service.start({ deviceId: 'usb-device', withLogs: true });
  assert.equal(started.session.withLogs, true);
  assert.match(started.session.logPath, /\.log$/);
  const result = await service.stop({ deviceId: 'usb-device' });
  assert.equal(result.success, true);
  assert.equal(stopped, 1);
  assert.equal(result.session.logTruncated, true);
  assert.equal(media[0].logPath, result.session.logPath);
});

test('log capture failure is visible but does not discard a valid recording', async t => {
  const { service } = fixture(t, { service: { logCaptureFactory: async () => { throw new Error('log denied'); } } });
  const started = await service.start({ deviceId: 'usb-device', withLogs: true });
  assert.equal(started.success, true);
  assert.match(started.session.logError, /log denied/);
  assert.equal((await service.stop({ deviceId: 'usb-device' })).success, true);
});

test('live log failure and truncation update recording state before video stops', async t => {
  let change;
  let logPath;
  const { service, events } = fixture(t, { service: { logCaptureFactory: async args => {
    change = args.onState;
    logPath = args.videoPath.replace(/\.mp4$/, '.log');
    return { info: () => ({ path: logPath }), stop: async () => ({ path: logPath, truncated: true, error: 'log offline' }) };
  } } });
  await service.start({ deviceId: 'usb-device', withLogs: true });
  change({ path: logPath, truncated: true, error: 'log offline' });
  assert.equal(service.list()[0].status, 'recording');
  assert.equal(service.list()[0].logTruncated, true);
  assert.equal(events.at(-1).sessions[0].logError, 'log offline');
  assert.equal((await service.stop({ deviceId: 'usb-device' })).success, true);
});

test('stopping during launch waits for owned PID without spawning a second process', async t => {
  const { service, processes, calls } = fixture(t);
  const starting = service.start({ deviceId: 'usb-device' });
  const stopped = service.stop({ deviceId: 'usb-device' });
  await starting;
  assert.equal((await stopped).success, true);
  assert.equal(processes.length, 1);
  assert.equal(calls.filter(args => args.join(' ').includes('kill -2')).length, 1);
  assert.equal(service.list()[0].status, 'saved');
});

test('media index failure keeps remote recording and retry reuses validated local file', async t => {
  let rejectMedia = true;
  const { service, calls } = fixture(t, { service: { onSaved: async () => {
    if (rejectMedia) throw new Error('media index disk error');
    return { id: 'saved-media' };
  } } });
  await service.start({ deviceId: 'usb-device' });
  const failed = await service.stop({ deviceId: 'usb-device' });
  assert.equal(failed.success, false);
  assert.equal(calls.some(args => args[3]?.startsWith('rm -f')), false);
  rejectMedia = false;
  const retry = await service.retry({ id: failed.session.id });
  assert.equal(retry.success, true);
  assert.equal(retry.session.mediaId, 'saved-media');
  assert.equal(calls.filter(args => args[2] === 'pull').length, 1);
});

test('malformed recovery file is retained and new recordings are safely blocked', async t => {
  const { directory, config, calls } = fixture(t);
  const file = path.join(directory, 'screen-recording-sessions.json');
  fs.writeFileSync(file, 'broken-json');
  const restored = createScreenRecordingService(config);
  assert.match((await restored.start({ deviceId: 'usb-device' })).error, /已保留原文件/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'broken-json');
  assert.equal(calls.length, 0);
});

test('recording request cannot supply arbitrary output or remote paths', async t => {
  const { service, directory } = fixture(t);
  const started = await service.start({ deviceId: 'usb-device', remotePath: '/sdcard/important.mp4', localPath: 'C:/important.mp4' });
  assert.notEqual(started.session.remotePath, '/sdcard/important.mp4');
  const stopped = await service.stop({ deviceId: 'usb-device', localPath: 'C:/important.mp4' });
  assert.ok(stopped.path.startsWith(directory + path.sep));
});

test('automatic end waits for concurrently starting log writer and closes it once', async t => {
  let completeFactory;
  let stopped = 0;
  const { service, processes } = fixture(t, { service: { logCaptureFactory: ({ videoPath }) => new Promise(resolve => {
    completeFactory = () => resolve({ info: () => ({ path: videoPath.replace(/\.mp4$/, '.log') }), stop: async () => { stopped += 1; return { path: videoPath.replace(/\.mp4$/, '.log') }; } });
  }) } });
  const starting = service.start({ deviceId: 'usb-device', withLogs: true });
  for (let attempt = 0; attempt < 100 && !completeFactory; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(completeFactory);
  processes[0].owned = false;
  processes[0].emit('close', 0);
  await tick();
  completeFactory();
  await starting;
  assert.equal(service.list()[0].status, 'saved');
  assert.equal(stopped, 1);
});

test('PID stdout marker is parsed only after its complete line has arrived', async t => {
  const { service, calls } = fixture(t, { splitPid: true });
  assert.equal((await service.start({ deviceId: 'usb-device' })).success, true);
  assert.equal((await service.stop({ deviceId: 'usb-device' })).success, true);
  assert.equal(calls.some(args => args.join(' ').includes('/proc/8/')), false);
  assert.equal(calls.some(args => args.join(' ').includes('/proc/800/')), true);
});

test('save-before-quit retries recordings already stopped but not yet copied locally', async t => {
  const { service, controls } = fixture(t, { pullFailure: true });
  await service.start({ deviceId: 'usb-device' });
  await service.stop({ deviceId: 'usb-device' });
  assert.equal(service.hasActiveRecordings(), false);
  assert.equal(service.listUnresolved().length, 1);
  controls.pullFailure = false;
  assert.equal((await service.stopAllRecordings()).success, true);
  assert.equal(service.listUnresolved().length, 0);
});

test('failed stop closes associated log writer even while device is offline', async t => {
  let stops = 0;
  const { service, controls } = fixture(t, { service: { logCaptureFactory: async ({ videoPath }) => ({
    info: () => ({ path: videoPath.replace(/\.mp4$/, '.log') }),
    stop: async () => { stops += 1; return { path: videoPath.replace(/\.mp4$/, '.log'), error: 'device disconnected' }; }
  }) } });
  await service.start({ deviceId: 'usb-device', withLogs: true });
  controls.offline = true;
  const failed = await service.stop({ deviceId: 'usb-device' });
  assert.equal(failed.success, false);
  assert.equal(stops, 1);
  assert.match(failed.session.logError, /disconnected/);
});

test('recovery rejects modified paths without modifying stored recovery data', async t => {
  const { service, directory, config, calls } = fixture(t);
  await service.start({ deviceId: 'usb-device' });
  const file = path.join(directory, 'screen-recording-sessions.json');
  const stored = JSON.parse(fs.readFileSync(file));
  stored.sessions[0].localPath = path.join(directory, 'unrelated-important.mp4');
  const damaged = JSON.stringify(stored);
  fs.writeFileSync(file, damaged);
  const callCount = calls.length;
  const recovered = createScreenRecordingService(config);
  assert.equal((await recovered.start({ deviceId: 'usb-device' })).success, false);
  assert.equal(calls.length, callCount);
  assert.equal(fs.readFileSync(file, 'utf8'), damaged);
});

test('recovered unsaved session rechecks remote process instead of trusting stopped flag', async t => {
  const { service, directory, config, processes, calls } = fixture(t);
  const started = await service.start({ deviceId: 'usb-device' });
  processes[0].removeAllListeners('close');
  const file = path.join(directory, 'screen-recording-sessions.json');
  const stored = JSON.parse(fs.readFileSync(file));
  stored.sessions[0].status = 'needs-save';
  stored.sessions[0].remoteStopped = true;
  fs.writeFileSync(file, JSON.stringify(stored));
  const recovered = createScreenRecordingService(config);
  assert.equal((await recovered.retry({ id: started.session.id })).success, true);
  assert.equal(calls.some(args => args.join(' ').includes('kill -2')), true);
});
