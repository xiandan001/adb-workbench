const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createMirrorWorkflow } = require('../electron/lib/mirror-workflow.cjs');
const { createMirrorProfileStore } = require('../electron/lib/mirror-profile-store.cjs');
const { createMirrorSessionState } = require('../electron/lib/mirror-session-state.cjs');
const { deviceComparisonIdentity } = require('../electron/lib/task-run-manifest.cjs');

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veylo-mirror480-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false });
  const owner = { webContents: contents, isDestroyed: () => false }, event = { sender: contents, senderFrame: contents.mainFrame };
  const filename = path.join(directory, 'profiles.json'), profiles = createMirrorProfileStore({ filename });
  const state = createMirrorSessionState(); let generation = 1, reads = 0;
  const transport = options.transport || 'adb';
  const identity = deviceComparisonIdentity(transport === 'hdc' ? { transport: 'hdc', harmonyUdid: 'aabbccdd11223344' } : { androidId: 'aabbccdd11223344' });
  const ref = deviceId => ({ id: deviceId, transport, targetKey: deviceId, status: 'device', generation });
  const workflow = createMirrorWorkflow({ profiles, state, getOwner: () => owner, resolveRef: ref,
    identityTimeoutMs: options.identityTimeoutMs || 1500, readIdentity: async () => { reads++; return options.readIdentity ? options.readIdentity(identity) : identity; } });
  return { workflow, state, profiles, event, filename, contents, ref, reads: () => reads, replace() { generation++; } };
}

test('first start performs no identity probe; explicit picture confirmation stores safe configuration and reuses it across a verified connection alias', async t => {
  const h = await fixture(t), settings = { bitrate: '8 Mbps', maxSize: '1280', screenOff: true, stayAwake: true };
  const start = await h.workflow.prepare(h.event, 'USB-A', settings);
  assert.equal(h.reads(), 0);
  h.workflow.observe(start.ticket, { source: 'mirror', transport: 'adb', event: 'ready', attemptNumber: 1, readiness: 'texture', audioMode: 'disabled', toolVersion: '5.0.1' });
  assert.equal(h.state.get('USB-A').pictureConfirmed, false);
  assert.equal((await h.workflow.confirm(h.event, { deviceId: 'USB-A', sessionId: start.ticket.id })).ok, true);
  const saved = JSON.parse(await fs.readFile(h.filename, 'utf8'));
  assert.deepEqual(saved.profiles[0].settings, { bitrate: '8 Mbps', maxSize: '1280', audioMode: 'disabled' });
  assert.doesNotMatch(JSON.stringify(saved), /USB-A|screenOff|stayAwake|aabbccdd11223344/);
  const next = await h.workflow.prepare(h.event, '192.0.2.4:5555', settings);
  assert.equal(next.audioMode, 'disabled'); assert.equal(next.profileMode, 'remembered'); assert.equal(h.reads(), 2);
  assert.equal(next.settings.screenOff, true, 'Only current explicit global power settings remain; saved profiles never add them');
});

test('current owner/frame and device generation are checked again after asynchronous identity reads', async t => {
  const h = await fixture(t), start = await h.workflow.prepare(h.event, 'A', { bitrate: '8 Mbps', maxSize: '0' });
  h.workflow.observe(start.ticket, { source: 'mirror', transport: 'adb', event: 'ready', attemptNumber: 1, readiness: 'texture' });
  await assert.rejects(h.workflow.confirm({ ...h.event, senderFrame: {} }, { deviceId: 'A', sessionId: start.ticket.id }), { code: 'MIRROR_OWNER' });
  h.replace();
  await assert.rejects(h.workflow.confirm(h.event, { deviceId: 'A', sessionId: start.ticket.id }), { code: 'MIRROR_DEVICE_CHANGED' });
  await assert.rejects(fs.stat(h.filename), { code: 'ENOENT' });
});

test('corrupt profiles or a failed atomic rename never replace their bytes and do not prevent ordinary mirroring', async t => {
  const h = await fixture(t); await fs.writeFile(h.filename, '{corrupt');
  const start = await h.workflow.prepare(h.event, 'A', { bitrate: '4 Mbps', maxSize: '720' });
  assert.equal(start.profileMode, 'global'); assert.equal(h.state.get('A').profileStatus, 'error');
  assert.equal(await fs.readFile(h.filename, 'utf8'), '{corrupt');
});

test('navigation during identity read cannot save and repeated confirmations share one read', async t => {
  let resolve; const waiting = new Promise(done => { resolve = done; });
  const h = await fixture(t, { readIdentity: async identity => { await waiting; return identity; } });
  const start = await h.workflow.prepare(h.event, 'A', { bitrate: '8 Mbps', maxSize: '0' });
  h.workflow.observe(start.ticket, { source: 'mirror', transport: 'adb', event: 'ready', attemptNumber: 1, readiness: 'texture' });
  const request = { deviceId: 'A', sessionId: start.ticket.id };
  const first = h.workflow.confirm(h.event, request), second = h.workflow.confirm(h.event, request);
  h.contents.emit('did-start-navigation', {}, 'file:///reload', false, true); resolve();
  await assert.rejects(first, { code: 'MIRROR_OWNER' }); await assert.rejects(second, { code: 'MIRROR_OWNER' });
  assert.equal(h.state.get('A').profileStatus, 'error');
  assert.equal(h.reads(), 1); await assert.rejects(fs.stat(h.filename), { code: 'ENOENT' });
});

test('identity timeout preserves previous profiles and falls back to current global settings without a new mirror retry', async t => {
  let hang = false; const h = await fixture(t, { identityTimeoutMs: 5, readIdentity: identity => hang ? new Promise(() => {}) : identity });
  const start = await h.workflow.prepare(h.event, 'A', { bitrate: '8 Mbps', maxSize: '0' });
  h.workflow.observe(start.ticket, { source: 'mirror', transport: 'adb', event: 'ready', attemptNumber: 1, readiness: 'texture' });
  await h.workflow.confirm(h.event, { deviceId: 'A', sessionId: start.ticket.id }); const before = await fs.readFile(h.filename);
  hang = true; const next = await h.workflow.prepare(h.event, 'B', { bitrate: '4 Mbps', maxSize: '720' });
  assert.equal(next.profileMode, 'global'); assert.equal(next.settings.bitrate, '4 Mbps'); assert.deepEqual(await fs.readFile(h.filename), before);
});

test('native HDC readiness saves only after the verified decoded result and fences an older window ordinal', async t => {
  const h = await fixture(t, { transport: 'hdc' }), start = await h.workflow.prepare(h.event, 'hdc:A', { bitrate: '8 Mbps', maxSize: '0' });
  h.workflow.observeHdc('hdc:A', 3, h.ref('hdc:A'), { source: 'mirror', transport: 'hdc', event: 'opening', attemptNumber: 1 });
  assert.equal(h.state.get('hdc:A').pictureConfirmed, false); assert.equal(h.reads(), 0);
  h.workflow.completeHdc(start.ticket, 3);
  const deadline = Date.now() + 2000;
  while (!(await h.profiles.list()).profiles.length) { assert.ok(Date.now() < deadline); await new Promise(resolve => setImmediate(resolve)); }
  const saved = (await h.profiles.list()).profiles[0]; assert.equal(saved.verification, 'decoded-frame'); assert.deepEqual(saved.settings, { audioMode: 'disabled' });
  assert.equal(h.state.get('hdc:A').pictureConfirmed, true); assert.equal(h.state.get('hdc:A').readiness, 'decoded-frame');
  h.workflow.observeHdc('hdc:A', 2, h.ref('hdc:A'), { source: 'mirror', transport: 'hdc', event: 'exit', attemptNumber: 1, exitCode: 1 });
  assert.equal(h.state.get('hdc:A').phase, 'running');
});
