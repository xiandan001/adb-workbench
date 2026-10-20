const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { collectArtifactFiles, exportArtifact, isWithin } = require('../electron/lib/artifact-export.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adb-export-test-'));
  t.after(async () => {
    assert.ok(isWithin(os.tmpdir(), root) && path.basename(root).startsWith('adb-export-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test('single-file artifacts exclude unrelated files in the same output folder', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'report.md'), 'selected');
  await fs.writeFile(path.join(root, 'other-report.md'), 'unrelated');
  const selected = await collectArtifactFiles({ deletePath: path.join(root, 'report.md'), rootPath: root });
  assert.equal(selected.directory, false);
  assert.deepEqual(selected.files.map(file => file.name), ['report.md']);
});

test('directory artifacts include nested evidence and reject archives inside the source', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'screens'));
  await fs.writeFile(path.join(root, 'report.md'), 'report');
  await fs.writeFile(path.join(root, 'screens', 'screen.png'), 'image');
  const item = { rootPath: root, deletePath: root, type: 'task' };
  const selected = await collectArtifactFiles(item);
  assert.deepEqual(selected.files.map(file => file.name), ['report.md', path.join('screens', 'screen.png')]);
  await assert.rejects(exportArtifact(item, path.join(root, 'nested.zip')), /原产物目录之外/);
});

test('path containment does not treat sibling-prefix folders as children', () => {
  const root = path.resolve('evidence');
  assert.equal(isWithin(root, path.join(root, 'nested', 'a.txt')), true);
  assert.equal(isWithin(root, root + '-other'), false);
  assert.equal(isWithin(root, path.resolve(root, '..')), false);
});

test('directory junctions cannot include outside files', async t => {
  const root = await fixture(t);
  const source = path.join(root, 'source');
  const outside = path.join(root, 'outside');
  await fs.mkdir(source); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'private.txt'), 'outside');
  await fs.symlink(outside, path.join(source, 'linked'), 'junction');
  await assert.rejects(collectArtifactFiles({ deletePath: source }), /链接/);
});

test('invalid leftover inspection ZIP is not exported as successful evidence', async t => {
  const root = await fixture(t);
  const source = path.join(root, 'inspection');
  await fs.mkdir(source);
  const bytes = Buffer.from('existing archive');
  await fs.writeFile(path.join(source, 'evidence-package.zip'), bytes);
  const output = path.join(root, 'export.zip');
  await assert.rejects(exportArtifact({ type: 'inspection', deletePath: source }, output), /没有可导出的原始证据/);
  assert.deepEqual(await fs.readFile(path.join(source, 'evidence-package.zip')), bytes);
});

test('destination junctions and case aliases cannot overwrite source evidence', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t);
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  const report = path.join(source, 'report.md');
  await fs.writeFile(report, 'original report');
  const alias = path.join(root, 'alias');
  await fs.symlink(source, alias, 'junction');
  await assert.rejects(exportArtifact({ type: 'task', deletePath: source }, path.join(alias, 'nested.zip')), /原产物目录之外/);
  await assert.rejects(exportArtifact({ type: 'performance', deletePath: report }, report.toUpperCase()), /原产物目录之外/);
  await assert.rejects(exportArtifact({ type: 'performance', deletePath: report }, path.join(alias, 'report.md')), /原产物目录之外/);
  const hardLink = path.join(root, 'linked.zip');
  await fs.link(report, hardLink);
  await assert.rejects(exportArtifact({ type: 'performance', deletePath: report }, hardLink), /普通文件/);
  assert.equal(await fs.readFile(report, 'utf8'), 'original report');
});

test('ZIP contains evidence and a matching inventory, including Unicode filenames', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t);
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, '日志.txt'), 'device log\n');
  const output = path.join(root, 'result.zip');
  const result = await exportArtifact({ type: 'task', title: 'test', deletePath: source, deviceId: 'test-device' }, output);
  assert.equal(result.fileCount, 1);
  const quoted = output.replace(/'/g, "''");
  const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead('${quoted}'); try { $entry=$zip.GetEntry('manifest.json'); $reader=[IO.StreamReader]::new($entry.Open()); try { $reader.ReadToEnd() } finally { $reader.Dispose() } } finally { $zip.Dispose() }`;
  const manifest = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8' }));
  assert.equal(manifest.deviceId, 'test-device');
  assert.deepEqual(manifest.files, [{ path: 'evidence/日志.txt', bytes: 11 }]);
});
