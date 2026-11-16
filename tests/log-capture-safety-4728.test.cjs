const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const harness = require('./helpers/log-capture-harness.cjs');
function temporary(t) {
  const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'veylo-capture-safe-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), base); assert.ok(path.basename(root).startsWith('veylo-capture-safe-')); fs.rmSync(root, { recursive: true, force: false }); });
  return root;
}
async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw Error('fixture deadline'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test('normal capture and local clear never clear any device log buffer', async () => {
  const h = harness(); await h.api.startLogCapture({ deviceId: 'A' });
  h.children[0].stdout.write('11-16 12:00:00.000 1 2 I Tag: original\n');
  assert.equal((await h.api.clearLogs({ source: 'realtime', deviceId: 'A' })).ok, true);
  assert.equal(h.calls.some(call => call.includes('logcat') && call.includes('-c')), false);
  assert.equal(h.api.getLogStore().realtime.length, 0);
});
test('explicit device clear requires confirmed exact retained target and never clears local evidence', async () => {
  const h = harness(); await h.api.startLogCapture({ deviceId: 'A' });
  h.children[0].stdout.write('11-16 12:00:00.000 1 2 I Tag: retained\n');
  const clear = h.handlers.get('log:clearDevice'); assert.equal(typeof clear, 'function');
  assert.equal((await clear({ ...h.event, senderFrame: {} }, { deviceId: 'A', confirmed: true })).ok, false);
  assert.equal((await clear(h.event, { deviceId: 'A', confirmed: false })).ok, false);
  assert.equal((await clear(h.event, { deviceId: 'B', confirmed: true })).ok, false);
  assert.equal((await clear(h.event, { deviceId: 'A', confirmed: true })).ok, true);
  assert.equal(h.api.getLogStore().realtime.length, 1);
  assert.deepEqual(h.calls.filter(call => call.includes('-c')).map(call => Array.from(call)), [['-s', 'A', 'logcat', '-c']]);
});
test('capture omits oversized display lines with explicit state while later records still arrive', async () => {
  const h = harness(); await h.api.startLogCapture({ deviceId: 'A' });
  h.children[0].stdout.write(Buffer.from('x'.repeat(1024 * 1024 + 1) + '\nlast\n'));
  const state = await h.handlers.get('log:getState')();
  assert.equal(state.capture.omittedLines, 1); assert.equal(state.capture.omittedBytes, 1024 * 1024 + 1);
  assert.equal(state.entries.length, 1); assert.equal(state.entries[0].raw, 'last'); assert.equal(state.truncated, true); assert.ok(state.entries[0].receivedAt > 0);
  await h.api.stopLogCapture();
});
test('main file IPC commits only completed imports and cancel/failure preserve the exact previous view', async t => {
  const root = temporary(t), file = path.join(root, 'input.log'); fs.writeFileSync(file, 'first\nsecond\n');
  let selected = file;
  const h = harness({ dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }) } });
  h.api.setLogStoreFileEntries([{ id: 'old', raw: 'keep old' }]); h.api.setCurrentLogSource('file');
  const open = h.handlers.get('log:openFile'), cancel = h.handlers.get('log:cancelImport');
  const initial = await open(h.event); assert.equal(initial.ok, true); assert.equal(h.api.getLogStore().file[0].raw, 'keep old');
  assert.equal((await cancel(h.event, { requestId: initial.requestId })).cancelled, true);
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(h.api.getLogStore().file[0].raw, 'keep old');
  selected = path.join(root, 'absent.log'); await open(h.event);
  await waitFor(() => h.events.some(event => event.channel === 'log:import-state' && event.payload.status === 'failed'));
  assert.equal(h.api.getLogStore().file[0].raw, 'keep old');
  selected = file; const next = await open(h.event);
  await waitFor(() => h.events.some(event => event.channel === 'log:import-state' && event.payload.requestId === next.requestId && event.payload.status === 'completed'));
  assert.deepEqual(h.api.getLogStore().file.map(entry => entry.raw), ['first', 'second']);
  await h.api.startLogCapture({ deviceId: 'A' }); assert.equal((await open(h.event)).ok, false); await h.api.stopLogCapture();
});
test('opted-in capture writes original stdout bytes and quota failure does not stop capture', async t => {
  const root = temporary(t), h = harness({ userData: root });
  const options = { enabled: true, maxBytes: 128 * 1024 * 1024 };
  const start = await h.api.startLogCapture({ deviceId: 'A', archive: options }); assert.equal(start.archive.enabled, true);
  const raw = Buffer.from('11-16 12:00:00.000 1 2 I Tag: 中文\r\n'); h.children[0].stdout.write(raw);
  await h.api.stopLogCapture(); const state = h.api.getArchiveState();
  const file = path.join(root, 'log-archives', state.archiveId, 'part-00001.log'); assert.ok(fs.readFileSync(file).equals(raw)); assert.equal(state.status, 'stopped');
  const old = path.join(root, 'log-archives', 'old.log'); fs.writeFileSync(old, 'old'); fs.truncateSync(old, options.maxBytes);
  await h.api.startLogCapture({ deviceId: 'A', archive: options }); h.children[1].stdout.write('still captured\n');
  const current = await h.handlers.get('log:getState')(); assert.equal(current.running, true); assert.equal(current.archive.partial, true); assert.equal(current.entries[0].raw, 'still captured');
  await h.api.stopLogCapture();
});
test('stop during asynchronous archive preparation prevents any late capture spawn', async t => {
  let release, closed = 0; const archive = require('../electron/lib/log-archive.cjs');
  const h = harness({ userData: temporary(t), './log-archive.cjs': { ...archive,
    createLogArchive: () => new Promise(resolve => { release = () => resolve({ stop: async () => { closed++; }, info: () => archive.emptyArchiveState('pending') }); }) } });
  const starting = h.api.startLogCapture({ deviceId: 'A', archive: { enabled: true, maxBytes: 128 * 1024 * 1024 } });
  await waitFor(() => release); assert.equal(h.api.hasCaptureActivity(), true);
  let done = false; const stopping = h.api.stopLogCapture().then(() => { done = true; });
  await Promise.resolve(); assert.equal(done, false); release();
  assert.equal((await starting).cancelled, true); await stopping;
  assert.equal(h.children.length, 0); assert.equal(closed, 1); assert.equal(h.api.hasCaptureActivity(), false);
});
test('navigation while a file picker is pending cannot start an import into a newer document', async () => {
  let choose;
  const h = harness({ dialog: { showOpenDialog: () => new Promise(resolve => { choose = resolve; }) } });
  h.api.setLogStoreFileEntries([{ id: 'old', raw: 'keep old' }]);
  const opening = h.handlers.get('log:openFile')(h.event);
  h.owner.emit('did-start-navigation', {}, 'about:blank', false, true);
  choose({ canceled: false, filePaths: ['/not-opened.log'] });
  assert.equal((await opening).cancelled, true); assert.equal(h.api.getLogStore().file[0].raw, 'keep old');
});
test('source identity is stable on append, changes on clear, and stale targeted stop cannot stop a new capture', async () => {
  const h = harness(); const started = await h.api.startLogCapture({ deviceId: 'A' });
  const identity = h.api.getSourceIdentity();
  h.children[0].stdout.write('normal append\n'); assert.equal(h.api.getSourceIdentity(), identity);
  await h.api.clearLogs({ source: 'realtime', deviceId: 'A' }); assert.notEqual(h.api.getSourceIdentity(), identity);
  const beforeB = await h.handlers.get('log:getState')(); await h.api.startLogCapture({ deviceId: 'B' });
  const current = h.api.getLogcatProc();
  assert.equal((await h.api.stopLogCapture({ captureId: started.captureId, deviceId: 'A', sourceIdentity: beforeB.sourceIdentity })).ok, false);
  assert.equal(h.api.getLogcatProc(), current);
  const state = await h.handlers.get('log:getState')();
  assert.equal((await h.api.stopLogCapture({ captureId: state.captureId, deviceId: state.deviceId, sourceIdentity: state.sourceIdentity })).ok, true);
  assert.equal(h.api.getLogcatProc(), null);
});
test('session restoration preserves its clipping disclosure while clearing previous capture omission counters', async () => {
  let restore;
  const h = harness({ './log-sessions.cjs': { register: (_ipc, options) => { restore = options.restore; } },
    './ai-analyze.cjs': { hasActiveAiRequest: () => false, clearAiConversation() {} } });
  await h.api.startLogCapture({ deviceId: 'A' }); h.children[0].stdout.write('x'.repeat(1024 * 1024 + 1) + '\n'); await h.api.stopLogCapture();
  const session = { source: 'realtime', deviceId: 'B', entries: [{ id: 'saved', raw: 'saved' }], truncated: true };
  const restored = await restore(session), state = await h.handlers.get('log:getState')();
  assert.equal(state.truncated, true); assert.equal(state.capture.omittedLines, 0); assert.equal(restored.sourceIdentity, state.sourceIdentity);
  await restore({ ...session, truncated: false }); assert.equal((await h.handlers.get('log:getState')()).truncated, false);
});
test('capture state reports the actual requested buffers separately from later caller choices and device defaults', async () => {
  const h = harness(), buffers = ['main', 'crash'];
  const first = await h.api.startLogCapture({ deviceId: 'A', buffers }); buffers.push('radio');
  assert.deepEqual(Array.from(first.buffers), ['main', 'crash']); assert.equal(first.bufferMode, 'explicit');
  const actual = await h.handlers.get('log:getState')(); assert.deepEqual(Array.from(actual.buffers), ['main', 'crash']);
  actual.buffers.push('system'); assert.deepEqual(Array.from((await h.handlers.get('log:getState')()).buffers), ['main', 'crash']);
  const defaulted = await h.api.startLogCapture({ deviceId: 'A' }); assert.equal(defaulted.buffers.length, 0); assert.equal(defaulted.bufferMode, 'device-default');
  const reset = h.events.filter(event => event.channel === 'log:reset').at(-1).payload;
  assert.equal(reset.buffers.length, 0); assert.equal(reset.bufferMode, 'device-default'); await h.api.stopLogCapture();
});
test('raw log delivery targets only the log window and missing renderers never discard the backend cache', async () => {
  const h = harness(); await h.api.startLogCapture({ deviceId: 'A' }); h.children[0].stdout.write('owned raw\n'); h.api.getFlushLogBatch()();
  assert.ok(h.events.some(event => event.channel === 'log:reset')); assert.ok(h.events.some(event => event.channel === 'log:appendBatch'));
  assert.equal(h.mainEvents.some(event => ['log:reset', 'log:appendBatch'].includes(event.channel)), false);
  h.context.getLogAnalyzerWindow = () => null;
  h.children[0].stdout.write('cache without renderer\n'); h.api.getFlushLogBatch()();
  assert.equal(h.api.getLogStore().realtime.at(-1).raw, 'cache without renderer');
  assert.equal(h.mainEvents.some(event => ['log:reset', 'log:appendBatch'].includes(event.channel)), false);
  await h.api.stopLogCapture();
});
