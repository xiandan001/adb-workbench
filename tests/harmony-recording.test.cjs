const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createHarmonyRecordingService, localName } = require('../electron/lib/harmony-recording.cjs');
const webm = () => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('webm'), Buffer.from([0x18, 0x53, 0x80, 0x67]),
  Buffer.alloc(32), Buffer.from([0x1f, 0x43, 0xb6, 0x75]), Buffer.alloc(100, 1)]);
function fixture(t, controls = {}, directory) {
  if (!directory) {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-harmony-record-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  }
  const indexed = [], calls = [];
  let service;
  service = createHarmonyRecordingService({
    directory,
    ensureStream: async deviceId => { calls.push(['ensure', deviceId]); return { success: true, session: { id: 'stream-' + deviceId, deviceId } }; },
    beginRendererRecording: async request => { calls.push(['begin', request]); return { success: !controls.startFailure }; },
    endRendererRecording: async request => {
      calls.push(['stop', request]);
      if (controls.stopFailure) return { success: false };
      await service.append({ id: request.id, sequence: 0, bytes: webm() });
      await service.end({ id: request.id, mimeType: 'video/webm;codecs=vp8' });
      return { success: true };
    },
    onSaved: async value => { if (controls.indexFailure) throw new Error('index unavailable'); indexed.push(value); return { id: 'media-id' }; },
    logCaptureFactory: async args => {
      calls.push(['log', args]); const file = args.videoPath.replace(/\.webm$/, '.log'); fs.writeFileSync(file, 'fixture log');
      return { info: () => ({ path: file, truncated: false }), stop: async () => ({ path: file, truncated: false }) };
    }
  });
  return { service, indexed, calls, directory, controls };
}
test('real-format WebM lifecycle indexes only after final chunks/end ACK and retains log association', async t => {
  const h = fixture(t);
  const start = await h.service.start({ deviceId: 'hdc:A', withLogs: true });
  assert.equal(start.success, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.service.list()[0].logPath, /\.log$/, 'real logger info() is exposed before recording stops');
  assert.equal(h.indexed.length, 0);
  const stop = await h.service.stop({ deviceId: 'hdc:A' });
  assert.equal(stop.success, true); assert.match(stop.path, /\.webm$/);
  assert.equal(stop.session.format, 'webm');
  assert.equal(h.indexed[0].format, 'webm');
  assert.match(h.indexed[0].logPath, /\.log$/);
  assert.deepEqual(fs.readFileSync(stop.path), webm());
  assert.equal(fs.existsSync(stop.path + '.part'), false);
  await h.service.retry({ id: start.session.id });
  assert.equal(h.indexed.length, 1, 'retrying saved data cannot index duplicates');
});
test('save/index failure remains needs-save and retry does not ask the renderer to record again', async t => {
  const h = fixture(t, { indexFailure: true });
  const start = await h.service.start({ deviceId: 'hdc:A' });
  assert.equal((await h.service.stop({ deviceId: 'hdc:A' })).success, false);
  assert.equal(h.service.list()[0].status, 'needs-save');
  h.controls.indexFailure = false;
  const result = await h.service.retry({ id: start.session.id });
  assert.equal(result.success, true);
  assert.equal(h.calls.filter(call => call[0] === 'begin').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'stop').length, 1);
});
test('crash after final copy but before metadata commit adopts only byte-identical owned final', async t => {
  const h = fixture(t);
  const start = await h.service.start({ deviceId: 'hdc:A' });
  await h.service.append({ id: start.session.id, sequence: 0, bytes: webm() });
  await h.service.end({ id: start.session.id, mimeType: 'video/webm' });
  const state = JSON.parse(fs.readFileSync(path.join(h.directory, 'harmony-recording-sessions.json'), 'utf8'));
  const stored = state.sessions[0];
  fs.copyFileSync(stored.partPath, stored.localPath);
  const restored = fixture(t, {}, h.directory);
  const [retry, concurrent] = await Promise.all([restored.service.retry({ id: stored.id }), restored.service.retry({ id: stored.id })]);
  assert.equal(retry.success, true);
  assert.equal(concurrent.success, true);
  assert.equal(restored.indexed.length, 1);
  assert.deepEqual(fs.readFileSync(stored.localPath), webm());
  assert.equal(restored.calls.length, 0, 'recovery is local and never connects a device');
});
test('unrelated existing final is preserved and incomplete recording is never marked saved', async t => {
  const h = fixture(t);
  const start = await h.service.start({ deviceId: 'hdc:A' });
  await h.service.append({ id: start.session.id, sequence: 0, bytes: webm() });
  await h.service.end({ id: start.session.id, mimeType: 'video/webm' });
  const stored = JSON.parse(fs.readFileSync(path.join(h.directory, 'harmony-recording-sessions.json'), 'utf8')).sessions[0];
  const different = webm(); different[different.length - 1] = 2;
  fs.writeFileSync(stored.localPath, different);
  const restored = fixture(t, {}, h.directory);
  const result = await restored.service.retry({ id: stored.id });
  assert.equal(result.success, false); assert.deepEqual(fs.readFileSync(stored.localPath), different); assert.equal(restored.indexed.length, 0);
  const unfinished = fixture(t, { stopFailure: true });
  const active = await unfinished.service.start({ deviceId: 'hdc:B' });
  await unfinished.service.append({ id: active.session.id, sequence: 0, bytes: webm() });
  assert.equal((await unfinished.service.stop({ deviceId: 'hdc:B' })).success, false);
  assert.equal((await unfinished.service.retry({ id: active.session.id })).success, false);
  assert.equal(unfinished.indexed.length, 0);
});
test('chunk sequence and unsupported MIME cannot bypass the completion gate; empty startup failure leaves no fake recovery', async t => {
  const h = fixture(t, { startFailure: true });
  assert.equal((await h.service.start({ deviceId: 'hdc:A' })).success, false);
  assert.equal(h.service.list().length, 0);
  const active = fixture(t);
  const result = await active.service.start({ deviceId: 'hdc:A' });
  await assert.rejects(active.service.append({ id: result.session.id, sequence: 2, bytes: webm() }), /顺序/);
  await assert.rejects(active.service.end({ id: result.session.id, mimeType: 'video/mp4' }), /结束信息/);
  await active.service.stop({ deviceId: 'hdc:A' });
});

function seedRecovery(directory, count, saved = 0) {
  const sessions = Array.from({ length: count }, (_, index) => {
    const session = { id: randomUUID(), deviceId: 'hdc:old-' + index, startedAt: 1700000000000 + index,
      status: index < saved ? 'saved' : 'needs-save', complete: false };
    session.localPath = path.join(directory, localName(session)); session.partPath = session.localPath + '.part';
    return session;
  });
  fs.writeFileSync(path.join(directory, 'harmony-recording-sessions.json'), JSON.stringify({ version: 1, sessions }));
  return sessions;
}
test('100 valid unresolved recoveries remain usable and block new recording before connecting or writing', async t => {
  const base = fixture(t);
  const old = seedRecovery(base.directory, 100);
  const filename = path.join(base.directory, 'harmony-recording-sessions.json');
  const before = fs.readFileSync(filename);
  const restored = fixture(t, {}, base.directory);
  assert.equal(restored.service.list().length, 100);
  const result = await restored.service.start({ deviceId: 'hdc:new' });
  assert.equal(result.success, false); assert.match(result.error, /上限/);
  assert.equal(restored.calls.length, 0); assert.deepEqual(fs.readFileSync(filename), before);
  assert.equal(restored.service.listUnresolved().length, old.length);
});
test('new output trims only saved history and concurrent starts cannot exceed the restorable 100-session limit', async t => {
  const base = fixture(t);
  const old = seedRecovery(base.directory, 100, 1);
  const restored = fixture(t, {}, base.directory);
  const [first, second] = await Promise.all([
    restored.service.start({ deviceId: 'hdc:new-A' }), restored.service.start({ deviceId: 'hdc:new-B' })
  ]);
  assert.equal(first.success, true); assert.equal(second.success, false); assert.match(second.error, /上限/);
  assert.equal(restored.calls.filter(call => call[0] === 'ensure').length, 1);
  const state = JSON.parse(fs.readFileSync(path.join(base.directory, 'harmony-recording-sessions.json'), 'utf8'));
  assert.equal(state.sessions.length, 100);
  for (const item of old.slice(1)) assert.ok(state.sessions.some(session => session.id === item.id));
  assert.ok(!state.sessions.some(session => session.id === old[0].id), 'only saved history may be trimmed');
  const reloaded = fixture(t, {}, base.directory);
  assert.equal(reloaded.service.listUnresolved().length, 100, 'the service can restore its own bounded output');
  await restored.service.stop({ deviceId: 'hdc:new-A' });
});
