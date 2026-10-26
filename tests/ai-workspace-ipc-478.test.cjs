const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { registerHandlers, cleanup } = require('../electron/lib/ai-workspace.cjs');

test('all new history/export/comparison handlers require the exact owned main frame and expose matching typed preload APIs', async t => {
  t.after(cleanup);
  const handlers = new Map(), sender = new EventEmitter(); sender.mainFrame = {};
  let invoked = 0;
  registerHandlers({ handle: (name, handler) => handlers.set(name, handler) }, { getOwner: () => ({ isDestroyed: () => false, webContents: sender }),
    factory: () => ({ call: async () => { invoked++; return { ok: true }; }, dispose() {} }) });
  const preload = fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8');
  for (const method of ['historyList', 'historyLoad', 'historySave', 'historyDelete', 'reportText', 'historyExport', 'comparisonPreview']) {
    const handle = handlers.get(`ai-workspace:${method}`); assert.equal(typeof handle, 'function');
    assert.equal((await handle({ sender, senderFrame: {} }, {})).code, 'AI_OWNER');
    assert.equal((await handle({ sender: new EventEmitter(), senderFrame: sender.mainFrame }, {})).code, 'AI_OWNER');
    assert.equal(invoked, 0);
    assert.match(preload, new RegExp(`aiWorkspace${method[0].toUpperCase() + method.slice(1)}:.*'ai-workspace:${method}'`));
  }
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ai-export-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('awb-ai-export-')); fs.rmSync(directory, { recursive: true, force: true }); });
  const filename = path.join(__dirname, '../electron/lib/ai-workspace.cjs'), originalRequire = createRequire(filename);
  const handlers = new Map(), sender = new EventEmitter(); sender.mainFrame = {};
  let captured;
  const state = { answer: { canceled: true }, asks: [] }, owner = { isDestroyed: () => false, webContents: sender };
  // Creating the client must be a pure factory; replace its transport with a
  // throwing function, rather than permitting configuration or network access.
  const source = fs.readFileSync(filename, 'utf8');
  const guardedModule = { exports: {} };
  vm.runInNewContext(source, { module: guardedModule, require(name) {
    if (name === 'electron') return { app: { getPath: () => directory }, dialog: { showSaveDialog: async (window, options) => { assert.equal(window, owner); state.asks.push(options); return state.answer; } } };
    if (name === './app-context.cjs') return { getMainWindow: () => owner };
    if (name === './ai-workspace-service.cjs') return { createAiWorkspaceService: deps => { captured = deps; return { call: async () => ({}), dispose() {} }; } };
    if (name === './ai-workspace-client.cjs') return { createBuiltinClient: () => async () => { throw new Error('forbidden real AI'); } };
    if (name === './ssh.cjs') return { getAnalysisSources: () => [], readAnalysisTerminal: () => ({}) };
    if (name === './log-analyzer.cjs') return { getAnalysisSnapshots: () => [] };
    if (name === './serial.cjs') return { snapshots: () => ({}) };
    if (name === './adb-runtime.cjs') return { runAdb: () => { throw new Error('forbidden real ADB'); } };
    return originalRequire(name);
  } }, { filename });
  guardedModule.exports.register({ handle: (name, handler) => handlers.set(name, handler) });
  t.after(() => guardedModule.exports.cleanup());
  return { directory, state, async deps() { await handlers.get('ai-workspace:sources')({ sender, senderFrame: sender.mainFrame }); return captured; } };
}

test('production export uses a native chosen destination, cancellation leaves old files alone, and owner loss prevents late writes', async t => {
  const h = fixture(t), deps = await h.deps(), destination = path.join(h.directory, 'native-selected.md');
  fs.writeFileSync(destination, 'existing data');
  let checks = 0;
  assert.equal((await deps.exportReport('synthetic report', () => { checks++; })).cancelled, true);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'existing data');
  h.state.answer = { canceled: false, filePath: destination };
  await assert.rejects(deps.exportReport('must not write', () => { throw Object.assign(new Error('owner closed'), { code: 'CANCELLED' }); }), { code: 'CANCELLED' });
  assert.equal(fs.readFileSync(destination, 'utf8'), 'existing data');
  assert.equal((await deps.exportReport('synthetic report', () => { checks++; })).path, destination);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'synthetic report'); assert.equal(checks, 2);
  assert.deepEqual(fs.readdirSync(h.directory), ['native-selected.md']); assert.equal(h.state.asks.length, 3);
});
