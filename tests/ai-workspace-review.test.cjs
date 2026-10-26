const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createRequire } = require('node:module');
const { createLogCaptureBuffer } = require('../electron/lib/log-capture-buffer.cjs');

function logHarness() {
  const filename = path.join(__dirname, '../electron/lib/log-analyzer.cjs');
  const actualRequire = createRequire(filename);
  const handlers = new Map();
  const module = { exports: {} };
  const processes = [];
  const adb = {
    runAdb: async () => ({ ok: true, stdout: '' }),
    spawnAdb: () => {
      const proc = new EventEmitter();
      proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.kill = () => {};
      processes.push(proc);
      return proc;
    }
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, Buffer, console, __dirname: path.dirname(filename),
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    require(name) {
      if (name === 'electron') return {};
      if (name === './app-context.cjs') return { isDev: false, broadcastToAllWindows() {} };
      if (name === './adb-runtime.cjs') return adb;
      if (name === './log-capture-buffer.cjs') return { createLogCaptureBuffer: options => createLogCaptureBuffer({ ...options, maxEntries: 3 }) };
      if (name === './log-sessions.cjs') return { register() {} };
      if (name === './auto-diagnose.cjs') return { autoDiagnoseOnLine() {} };
      return actualRequire(name);
    }
  }, { filename });
  module.exports.register({ handle: (name, handler) => handlers.set(name, handler) });
  return { api: module.exports, handlers, processes };
}

test('retained realtime evidence stays bound to its capture device when active log source changes', () => {
  const h = logHarness();
  h.api.appendRealtimeEntry({ id: 1, raw: 'fixture from device A', deviceId: 'device-A' });
  h.api.setCurrentLogSource('file', 'device-B');
  const realtime = h.api.getAnalysisSnapshots().find(source => source.source === 'realtime');
  assert.equal(realtime.deviceId, 'device-A');
  h.api.appendRealtimeEntry({ id: 2, raw: 'mixed fixture', deviceId: 'device-B' });
  assert.equal(h.api.getAnalysisSnapshots().find(source => source.source === 'realtime').deviceId, '');
});

test('evidence source identity survives ring eviction but changes on clear, restore or file replacement', () => {
  const h = logHarness();
  const rows = [{ id: 1, raw: 'same fixture', deviceId: 'device-A' }];
  h.api.appendRealtimeEntry(rows[0]);
  const first = h.api.getAnalysisSnapshots()[0].identity;
  for (let id = 2; id <= 5; id++) h.api.appendRealtimeEntry({ id, raw: `fixture ${id}`, deviceId: 'device-A' });
  assert.equal(h.api.getAnalysisSnapshots()[0].identity, first);
  assert.equal(h.api.getAnalysisSnapshots()[0].truncated, true);
  h.api.resetLogStoreRealtime(); h.api.appendRealtimeEntry(rows[0]);
  const reset = h.api.getAnalysisSnapshots()[0].identity;
  assert.notEqual(reset, first);
  h.api.getLogStore().realtime = rows;
  assert.notEqual(h.api.getAnalysisSnapshots()[0].identity, reset);
  h.api.setLogStoreFileEntries(rows);
  const fileFirst = h.api.getAnalysisSnapshots()[1].identity;
  h.api.setLogStoreFileEntries(rows);
  assert.notEqual(h.api.getAnalysisSnapshots()[1].identity, fileFirst);
});

test('live capture callback uses its original device even after a file becomes the active source', async () => {
  const h = logHarness();
  assert.equal((await h.handlers.get('adb:startLog')({}, { deviceId: 'device-A' })).ok, true);
  h.api.setCurrentLogSource('file', 'device-B');
  h.processes[0].stdout.write('10-26 10:00:00.000 123 456 I Fixture: synthetic line\n');
  assert.equal(h.api.getLogStore().realtime[0].deviceId, 'device-A');
  assert.equal(h.api.getAnalysisSnapshots()[0].deviceId, 'device-A');
  h.processes[0].stdout.end(); h.processes[0].stderr.end();
});

function sshHarness(bytes) {
  const filename = path.join(__dirname, '../electron/lib/ssh.cjs');
  const module = { exports: {} };
  const actualRequire = createRequire(filename);
  const reads = [];
  const fixture = {
    snapshot: () => ({ sessions: [{ id: 'session', name: 'fixture', host: 'fixture.invalid', username: 'must-not-expose',
      terminals: [{ id: 'terminal', title: 'fixture terminal', startOffset: 0, endOffset: bytes.length }] }] }),
    terminalRead: args => { reads.push(args); return { hex: bytes.subarray(args.offset).toString('hex'), truncated: false }; }
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nanalysisSessions = fixture;', {
    module, Buffer, fixture,
    require(name) {
      if (['./ssh-profiles.cjs', './ssh-controller.cjs', './ssh-command-history.cjs', './app-message-dialog.cjs'].includes(name)) return {};
      return actualRequire(name);
    }
  }, { filename });
  return { api: module.exports, reads };
}

test('SSH evidence snapshots omit incomplete UTF-8 boundaries without replacement characters or private session fields', () => {
  const bytes = Buffer.concat([Buffer.from('中文🙂'.repeat(1000)), Buffer.from([0xe4, 0xb8])]);
  const h = sshHarness(bytes);
  const source = h.api.getAnalysisSources()[0];
  assert.equal(Object.hasOwn(source, 'username'), false);
  const result = h.api.readAnalysisTerminal(source);
  assert.ok(result.text.length > 0);
  assert.equal(result.text.includes('\ufffd'), false);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text) <= 8192);
  assert.equal(h.reads.length, 1);
  assert.equal(h.reads[0].sessionId, 'session');
  assert.equal(h.reads[0].terminalId, 'terminal');
});
