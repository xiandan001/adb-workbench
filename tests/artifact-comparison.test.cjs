const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { prepareTaskComparison, exportTaskComparison } = require('../electron/lib/artifact-comparison.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-comparison-test-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('awb-comparison-test-')); await fs.rm(root, { recursive: true, force: true }); });
  const step = { id: 'check', type: 'assertText', label: 'Check' };
  const items = [];
  for (const [name, status] of [['before', 'failed'], ['after', 'success']]) {
    const directory = path.join(root, name); await fs.mkdir(directory);
    const run = { id: `task-${name}`, scriptName: 'Comparison fixture', mode: 'replay', status, comparisonVersion: 1, scriptId: 'script', scriptHash: 'same', scriptSteps: [step], inputHash: 'same',
      rerunSnapshot: { script: { command: 'private-comparison-fixture' } }, deviceRuns: [{ deviceId: 'device', comparisonIdentity: { androidId: 'same-digest' }, steps: [{ ...step, index: 0, status }] }] };
    await fs.writeFile(path.join(directory, 'run-result.json'), JSON.stringify(run));
    await fs.writeFile(path.join(directory, 'evidence.txt'), `${name}-evidence`);
    items.push({ id: `task:${directory}`, taskId: run.id, type: 'task', deletePath: directory });
  }
  return { root, items };
}

test('trusted manifests are compared in main and invalid identities/links fail before exporting', async t => {
  const { root, items } = await fixture(t);
  const prepared = await prepareTaskComparison(...items); assert.match(prepared.summary, /恢复 1/);
  await assert.rejects(prepareTaskComparison(items[0], items[0]), /不同/);
  await assert.rejects(prepareTaskComparison(items[0], { ...items[1], taskId: 'task-forged' }), /已变化/);
  const file = path.join(items[1].deletePath, 'run-result.json'); const run = JSON.parse(await fs.readFile(file));
  run.scriptHash = 'changed'; await fs.writeFile(file, JSON.stringify(run));
  await assert.rejects(prepareTaskComparison(...items), /脚本或运行参数不同/);
  const outside = path.join(root, 'outside.txt'); await fs.writeFile(outside, 'not selected');
  await fs.symlink(root, path.join(items[0].deletePath, 'linked'), 'junction');
  await assert.rejects(prepareTaskComparison(...items), /链接/);
});

test('combined export protects both original sources including junction aliases', async t => {
  const { root, items } = await fixture(t); const prepared = await prepareTaskComparison(...items);
  await assert.rejects(exportTaskComparison(prepared, path.join(items[0].deletePath, 'evidence.zip')), /原产物目录之外/);
  await assert.rejects(exportTaskComparison(prepared, path.join(items[1].deletePath, 'evidence.zip')), /原产物目录之外/);
  if (process.platform === 'win32') {
    const alias = path.join(root, 'alias'); await fs.symlink(items[1].deletePath, alias, 'junction');
    await assert.rejects(exportTaskComparison(prepared, path.join(alias, 'evidence.zip')), /原产物目录之外/);
    const original = path.join(items[1].deletePath, 'run-result.json'); const hardLink = path.join(root, 'linked.zip'); await fs.link(original, hardLink);
    await assert.rejects(exportTaskComparison(prepared, hardLink), /普通文件/);
  }
});

test('real combined ZIP includes summary and both safe manifest snapshots without modifying originals', { skip: process.platform !== 'win32' }, async t => {
  const { root, items } = await fixture(t); const beforeRaw = await fs.readFile(path.join(items[0].deletePath, 'run-result.json'), 'utf8');
  const prepared = await prepareTaskComparison(...items); const destination = path.join(root, 'comparison.zip');
  const result = await exportTaskComparison(prepared, destination); assert.equal(result.fileCount, 5);
  const quoted = destination.replaceAll("'", "''");
  const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead('${quoted}'); try { $data=@{}; foreach($entry in $zip.Entries) { $r=[IO.StreamReader]::new($entry.Open()); try { $data[$entry.FullName.Replace([char]92,[char]47)]=$r.ReadToEnd() } finally { $r.Dispose() } }; $data | ConvertTo-Json -Compress } finally { $zip.Dispose() }`;
  const entries = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8' }));
  assert.match(entries['evidence/comparison-summary.txt'], /恢复 1/);
  for (const name of ['before', 'after']) {
    assert.doesNotMatch(entries[`evidence/${name}/run-result.json`], /rerunSnapshot|private-comparison-fixture/);
    assert.equal(entries[`evidence/${name}/evidence.txt`], `${name}-evidence`);
  }
  const inventory = JSON.parse(entries['manifest.json']);
  assert.equal(inventory.files.filter(file => file.excludedFields?.includes('rerunSnapshot')).length, 2);
  assert.equal(await fs.readFile(path.join(items[0].deletePath, 'run-result.json'), 'utf8'), beforeRaw);
});
