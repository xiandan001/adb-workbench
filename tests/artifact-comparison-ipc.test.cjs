const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

test('comparison IPC accepts only two current opaque IDs and recomputes trusted manifests before any save dialog', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-comparison-ipc-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('awb-comparison-ipc-')); fs.rmSync(root, { recursive: true, force: true }); });
  const step = { id: 'one', type: 'assertText', label: 'Check' };
  for (const [name, status] of [['before', 'failed'], ['after', 'success']]) {
    const directory = path.join(root, 'task-center-artifacts', name); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'run-result.json'), JSON.stringify({ id: `task-${name}`, mode: 'replay', status, comparisonVersion: 1, scriptId: 'script', scriptHash: 'hash', scriptSteps: [step],
      deviceRuns: [{ deviceId: 'device', comparisonIdentity: { androidId: 'digest' }, steps: [{ ...step, index: 0, status }] }] }));
  }
  let dialogs = 0;
  let destroyed = false;
  const mainContents = { mainFrame: {} }, logContents = { mainFrame: {} }, main = { isDestroyed: () => destroyed, webContents: mainContents };
  let currentMain = main, dialogResult = () => ({ canceled: true });
  const electron = { app: { getPath: () => root }, shell: {}, BrowserWindow: { fromWebContents: () => main }, dialog: { showSaveDialog: async owner => { assert.equal(owner, main); dialogs++; return dialogResult(); } } };
  const filename = path.resolve(__dirname, '../electron/lib/artifact-center.cjs'), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = loaded.require.bind(loaded); loaded.require = name => name === 'electron' ? electron : name === './app-context.cjs' ? { getMainWindow: () => currentMain } : original(name);
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  const handlers = new Map(); loaded.exports.register({ handle: (name, action) => handlers.set(name, action) });
  const items = (await handlers.get('artifacts:list')()).items;
  const before = items.find(item => item.taskId === 'task-before'), after = items.find(item => item.taskId === 'task-after');
  const args = { beforeId: before.id, afterId: after.id }, exportComparison = (value, event = { sender: mainContents, senderFrame: mainContents.mainFrame }) => handlers.get('artifacts:exportComparison')(event, value);
  for (const event of [{ sender: mainContents, senderFrame: {} }, { sender: logContents, senderFrame: logContents.mainFrame }, { sender: {}, senderFrame: mainContents.mainFrame }, {}]) {
    assert.equal((await exportComparison(args, event)).code, 'ARTIFACT_EXPORT_OWNER');
  }
  currentMain = null; assert.equal((await exportComparison(args)).code, 'ARTIFACT_EXPORT_OWNER'); currentMain = main;
  destroyed = true; assert.equal((await exportComparison(args)).code, 'ARTIFACT_EXPORT_OWNER'); destroyed = false;
  const mainFrame = mainContents.mainFrame; mainContents.mainFrame = null;
  assert.equal((await exportComparison(args, { sender: mainContents, senderFrame: null })).code, 'ARTIFACT_EXPORT_OWNER'); mainContents.mainFrame = mainFrame;
  assert.equal(dialogs, 0);
  for (const invalid of [{ ...args, path: root }, { beforeId: before.rootPath, afterId: after.rootPath }, { beforeId: before.id, afterId: before.id }, { ...args, comparison: { recovered: 999 } }]) assert.equal((await exportComparison(invalid)).ok, false);
  assert.equal(dialogs, 0);
  assert.deepEqual(await exportComparison(args), { ok: true, cancelled: true }); assert.equal(dialogs, 1);
  dialogResult = () => { currentMain = { ...main }; return { canceled: false, filePath: path.join(root, 'must-not-write.zip') }; };
  assert.equal((await exportComparison(args)).code, 'ARTIFACT_EXPORT_OWNER'); assert.equal(fs.existsSync(path.join(root, 'must-not-write.zip')), false); currentMain = main;
  const file = path.join(after.deletePath, 'run-result.json'), run = JSON.parse(fs.readFileSync(file, 'utf8')); run.scriptHash = 'changed'; fs.writeFileSync(file, JSON.stringify(run));
  assert.equal((await exportComparison(args)).ok, false); assert.equal(dialogs, 2);
});
