const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

test('replay results are indexed and export accepts only a current artifact ID', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-artifact-index-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('adb-artifact-index-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const evidence = path.join(root, 'task-center-artifacts', 'replay-test');
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, 'run-result.json'), JSON.stringify({
    scriptName: 'Replay failure', mode: 'replay', status: 'failed',
    devices: [{ deviceId: 'device-A', status: 'failed' }], endedAt: '2026-10-20T00:00:00Z'
  }));
  let dialogCalls = 0;
  const electron = {
    app: { getPath: () => root }, shell: {},
    BrowserWindow: { fromWebContents: () => null },
    dialog: { showSaveDialog: async () => { dialogCalls++; return { canceled: true }; } }
  };
  const filename = path.resolve(__dirname, '../electron/lib/artifact-center.cjs');
  const local = new Module(filename, module);
  local.filename = filename;
  local.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = local.require.bind(local);
  local.require = name => name === 'electron' ? electron : originalRequire(name);
  local._compile(fs.readFileSync(filename, 'utf8'), filename);
  const handlers = new Map();
  local.exports.register({ handle: (channel, callback) => handlers.set(channel, callback) });
  const result = await handlers.get('artifacts:list')();
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].status, 'failed');
  assert.equal(result.items[0].deviceId, 'device-A');
  assert.equal(result.items[0].summaryPath, path.join(evidence, 'run-result.json'));
  const invalid = await handlers.get('artifacts:export')({ sender: {} }, { id: 'task:outside-index' });
  assert.equal(invalid.ok, false);
  assert.equal(dialogCalls, 0);
  const cancelled = await handlers.get('artifacts:export')({ sender: {} }, { id: result.items[0].id });
  assert.deepEqual(cancelled, { ok: true, cancelled: true });
  assert.equal(dialogCalls, 1);
  // Every historical record must remain searchable, previewable and exportable.
  for (let index = 0; index < 165; index++) {
    const directory = path.join(root, 'task-center-artifacts', `older-${index}`);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'run-result.json'), JSON.stringify({ scriptName: `Older ${index}`, endedAt: '2020-01-01T00:00:00Z' }));
  }
  const historical = await handlers.get('artifacts:list')();
  assert.equal(historical.items.length, 166);
  assert.ok(historical.items.every(item => item.sizeBytes > 0));
  const oldest = historical.items.at(-1);
  const preview = await handlers.get('artifacts:preview')({}, { id: oldest.id, name: 'run-result.json' });
  assert.equal(preview.ok, true);
  assert.ok(preview.content.includes('Older'));
  assert.equal((await handlers.get('artifacts:preview')({}, { id: 'unknown', name: 'run-result.json' })).ok, false);
  assert.equal((await handlers.get('artifacts:export')({ sender: {} }, { id: oldest.id })).cancelled, true);
});
