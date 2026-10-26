const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const draft = { name: 'AI fixture', description: 'Review before running.', steps: [{ type: 'screenshot', label: 'Capture fixture' }] };
const existing = { id: 'existing-user-script', name: 'User fixture', description: 'Preserve unchanged.', steps: [{ id: 'user-step', type: 'delay', label: 'Wait', durationMs: 200 }] };
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ai-save-test-'));
  const scriptFile = path.join(directory, 'task-center-scripts.json');
  fs.writeFileSync(scriptFile, JSON.stringify({ version: 1, scripts: [existing] }), 'utf8');
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('awb-ai-save-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const filename = path.join(__dirname, '../electron/lib/task-center.cjs');
  const actualRequire = createRequire(filename);
  const control = { fail: '', executed: 0, calls: [], descriptors: new Set() };
  const fsProxy = {
    ...fs,
    openSync(target, ...args) {
      assert.equal(path.dirname(target), directory);
      const descriptor = fs.openSync(target, ...args);
      control.calls.push('open'); control.descriptors.add(descriptor);
      return descriptor;
    },
    writeFileSync(target, ...args) {
      control.calls.push('write');
      assert.equal(typeof target, 'number');
      if (control.fail === 'write') throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
      return fs.writeFileSync(target, ...args);
    },
    fsyncSync(descriptor) {
      control.calls.push('fsync');
      if (control.fail === 'fsync') throw Object.assign(new Error('fixture sync failure'), { code: 'EIO' });
      return fs.fsyncSync(descriptor);
    },
    closeSync(descriptor) {
      control.calls.push('close'); control.descriptors.delete(descriptor);
      return fs.closeSync(descriptor);
    },
    renameSync(source, target) {
      control.calls.push('rename');
      assert.equal(path.dirname(source), directory); assert.equal(target, scriptFile);
      if (control.fail === 'rename') throw Object.assign(new Error('fixture rename denial'), { code: 'EACCES' });
      return fs.renameSync(source, target);
    },
    unlinkSync(target) { assert.equal(path.dirname(target), directory); return fs.unlinkSync(target); }
  };
  function load() {
    const module = { exports: {} };
    const forbidden = () => { control.executed++; throw new Error('This test must never execute a task or device command'); };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.readScriptsForTest = readScripts;', {
      module, console, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
      require(name) {
        if (name === 'fs') return fsProxy;
        if (name === 'electron') return { app: { getPath: () => directory } };
        if (name === 'child_process') return { execFile: forbidden };
        if (name === 'worker_threads') return { Worker: forbidden };
        if (name === './adb-runtime.cjs') return { runAdb: forbidden, getAdbCommand: forbidden };
        if (['./task-run-manifest.cjs', './app-context.cjs', './vip.cjs', './inspection.cjs', './performance-monitor.cjs', './ai-analyze.cjs'].includes(name)) return {};
        return actualRequire(name);
      }
    }, { filename });
    return module.exports;
  }
  return { control, directory, scriptFile, load, api: load(), read: () => JSON.parse(fs.readFileSync(scriptFile, 'utf8')).scripts };
}

test('saving an AI draft creates a new task, preserves existing scripts, and never executes anything', t => {
  const h = fixture(t);
  const saved = h.api.saveAiDraft(draft);
  assert.match(saved.id, /^ai-[a-f\d-]{36}$/);
  assert.notEqual(saved.id, existing.id);
  assert.equal(saved.mode, 'replay');
  assert.equal(saved.continueOnError, false);
  assert.equal(saved.report.includeAiSummary, false);
  assert.equal(saved.steps[0].type, 'screenshot');
  assert.deepEqual(h.read()[1], existing);
  assert.equal(h.read().length, 2);
  assert.deepEqual(plain(h.api.readScriptsForTest()), h.read());
  assert.deepEqual(plain(h.load().readScriptsForTest()), h.read());
  assert.deepEqual(h.control.calls, ['open', 'write', 'fsync', 'close', 'rename']);
  assert.equal(h.control.descriptors.size, 0);
  assert.deepEqual(fs.readdirSync(h.directory), ['task-center-scripts.json']);
  assert.equal(h.control.executed, 0);
});

for (const failure of ['write', 'fsync', 'rename']) {
  test(`a ${failure} failure preserves file and cache; retry saves exactly one new draft`, t => {
    const h = fixture(t);
    const before = fs.readFileSync(h.scriptFile);
    assert.deepEqual(plain(h.api.readScriptsForTest()), [existing]);
    h.control.fail = failure;
    assert.throws(() => h.api.saveAiDraft(draft), error => ['ENOSPC', 'EIO', 'EACCES'].includes(error.code));
    assert.deepEqual(fs.readFileSync(h.scriptFile), before);
    assert.deepEqual(plain(h.api.readScriptsForTest()), [existing]);
    assert.deepEqual(plain(h.load().readScriptsForTest()), [existing]);
    assert.equal(h.control.descriptors.size, 0);
    assert.deepEqual(fs.readdirSync(h.directory), ['task-center-scripts.json']);
    h.control.fail = '';
    const saved = h.api.saveAiDraft(draft);
    assert.equal(h.read().length, 2);
    assert.equal(h.read().filter(item => item.id.startsWith('ai-')).length, 1);
    assert.equal(h.read()[0].id, saved.id);
    assert.deepEqual(h.read()[1], existing);
    assert.equal(h.control.executed, 0);
  });
}

test('saving revalidates the draft and cannot overwrite an existing ID or introduce unsafe steps', t => {
  const h = fixture(t);
  for (const value of [{ ...draft, id: existing.id }, { ...draft, steps: [{ type: 'shell', label: 'unsafe', command: 'never-execute' }] }, { ...draft, steps: [{ type: 'screenshot', label: 'capture', localPath: h.scriptFile }] }]) {
    assert.throws(() => h.api.saveAiDraft(value), { code: 'invalid_output' });
  }
  assert.deepEqual(h.read(), [existing]);
  assert.equal(h.control.calls.length, 0);
  assert.equal(h.control.executed, 0);
});

test('opening a generated task defers replacing an unsaved Task Center draft to the existing confirmation', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/components/TaskCenter.jsx'), 'utf8');
  const ast = parser.parse(source, { sourceType: 'module', plugins: ['jsx'] });
  let block;
  traverse(ast, { IfStatement(p) { if (p.node.test.type === 'Identifier' && p.node.test.name === 'incoming') block = source.slice(p.node.start, p.node.end); } });
  assert.ok(block);
  const unsaved = { ...existing, name: 'Unsaved user edits' };
  const incoming = { ...draft, id: 'ai-fixture' };
  const changes = [];
  let pending;
  const context = {
    incoming, restored: { workspace: { savedFingerprint: JSON.stringify(existing) } }, first: unsaved,
    draftFingerprint: JSON.stringify, cloneScript: value => plain(value),
    setPendingDraftAction: factory => { pending = factory(); },
    setSelectedScriptId: value => changes.push(['selected', value]), setDraft: value => changes.push(['draft', value]),
    setSavedFingerprint: value => changes.push(['fingerprint', value]), setEditorMode: value => changes.push(['editor', value]),
    setWorkspaceView: value => changes.push(['view', value])
  };
  vm.runInNewContext(block, context);
  assert.equal(typeof pending, 'function');
  assert.deepEqual(changes, []);
  assert.equal(unsaved.name, 'Unsaved user edits');
  pending();
  assert.deepEqual(changes[0], ['selected', 'ai-fixture']);
  assert.deepEqual(changes[1], ['draft', incoming]);
  assert.match(source, /pendingDraftAction\s*&&\s*\(\s*<TaskCenterDraftDialog/);
});
