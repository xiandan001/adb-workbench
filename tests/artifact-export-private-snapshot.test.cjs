const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { transformRunManifest } = require('../electron/lib/artifact-export-transform.cjs');
const { exportArtifact, isWithin } = require('../electron/lib/artifact-export.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-export-private-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('awb-export-private-')); await fs.rm(directory, { recursive: true, force: true }); });
  return directory;
}

test('isolated export worker removes only private snapshot from a staging copy and reports its actual bytes', async t => {
  const root = await fixture(t), source = path.join(root, 'original.json'), copy = path.join(root, 'run-result.json');
  const original = JSON.stringify({ id: 'fixture', inputHash: 'recorded-hash', rerunSnapshot: { script: { steps: [{ text: 'private-test-input' }] } }, deviceRuns: [{ status: 'failed' }] });
  await fs.writeFile(source, original); await fs.copyFile(source, copy);
  let ticks = 0; const timer = setInterval(() => { ticks++; }, 1);
  const result = await transformRunManifest(copy); clearInterval(timer);
  const safe = await fs.readFile(copy, 'utf8');
  assert.equal(await fs.readFile(source, 'utf8'), original); assert.doesNotMatch(safe, /rerunSnapshot|private-test-input/);
  assert.equal(JSON.parse(safe).inputHash, 'recorded-hash'); assert.equal(result.bytes, Buffer.byteLength(safe)); assert.deepEqual(result.excludedFields, ['rerunSnapshot']); assert.ok(ticks > 0);
});

test('malformed and oversized manifests fail closed and worker timeout or crash cannot leave a pending export', async t => {
  const root = await fixture(t), file = path.join(root, 'run-result.json');
  for (const text of ['{broken', 'x'.repeat(8 * 1024 * 1024 + 1)]) {
    await fs.writeFile(file, text); await assert.rejects(transformRunManifest(file), /私有任务快照/); assert.equal(await fs.readFile(file, 'utf8'), text);
  }
  let terminated = 0;
  class SilentWorker extends EventEmitter { async terminate() { terminated++; } }
  await assert.rejects(transformRunManifest(file, { WorkerClass: SilentWorker, timeoutMs: 10 }), /私有任务快照/); assert.equal(terminated, 1);
  class CrashedWorker extends SilentWorker { constructor() { super(); queueMicrotask(() => this.emit('error', new Error('fixture crash'))); } }
  await assert.rejects(transformRunManifest(file, { WorkerClass: CrashedWorker }), /私有任务快照/); assert.equal(terminated, 2);
});

test('real ZIP inventory describes excluded private fields and byte counts of the exported copy without altering original evidence', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t), source = path.join(root, 'source'); await fs.mkdir(source);
  const original = JSON.stringify({ id: 'fixture', inputHash: 'kept', rerunSnapshot: { script: { command: 'private-secret-fixture' } } });
  await fs.writeFile(path.join(source, 'run-result.json'), original);
  const destination = path.join(root, 'export.zip'); await exportArtifact({ type: 'task', title: 'fixture', deletePath: source }, destination);
  const quoted = destination.replaceAll("'", "''");
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead('${quoted}'); try { $data=@{}; foreach($name in @('manifest.json','evidence/run-result.json')) { $entry=$zip.Entries | Where-Object { $_.FullName.Replace([char]92,[char]47) -eq $name } | Select-Object -First 1; $r=[IO.StreamReader]::new($entry.Open()); try { $data[$name]=$r.ReadToEnd() } finally { $r.Dispose() } }; $data | ConvertTo-Json -Compress } finally { $zip.Dispose() }`;
  const entries = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8' }));
  const inventory = JSON.parse(entries['manifest.json']);
  assert.deepEqual(inventory.files[0].excludedFields, ['rerunSnapshot']);
  assert.equal(inventory.files[0].bytes, Buffer.byteLength(entries['evidence/run-result.json']));
  assert.doesNotMatch(entries['evidence/run-result.json'], /private-secret-fixture|rerunSnapshot/);
  assert.equal(await fs.readFile(path.join(source, 'run-result.json'), 'utf8'), original);
  assert.equal(isWithin(source, destination), false);
});
