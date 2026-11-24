const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { prepareDirectFirmware, revalidateDirectFirmware, stageDirectFirmware } = require('../electron/lib/firmware-direct-receipt.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'direct-firmware-receipt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agent = path.join(root, 'download_agent');
  await fs.mkdir(agent);
  const manifest = path.join(agent, 'flash.xml');
  const schema = path.join(agent, 'flash.xsd');
  const image = path.join(root, 'boot.img');
  await Promise.all([
    fs.writeFile(manifest, '<flash-mode><project>Fixture</project><dagent>DA.bin</dagent><scatter>../scatter.xml</scatter></flash-mode>'),
    fs.writeFile(schema, '<schema version="fixture"/>'),
    fs.writeFile(path.join(agent, 'DA.bin'), 'sample DA'),
    fs.writeFile(path.join(root, 'scatter.xml'), '<root><platform>MT8189</platform><partition><file_name>boot.img</file_name><is_download>true</is_download></partition></root>'),
    fs.writeFile(image, 'original')
  ]);
  return { manifest, image, schema };
}

test('whole MTK package carries stable digest and detects changed dependency without touching the device', async t => {
  const f = await fixture(t);
  const progress = [];
  const receipt = await prepareDirectFirmware('mtk', f.manifest, { onProgress: event => progress.push(event) });
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.chip, 'MT8189');
  assert.equal(receipt.files.length, 5);
  assert.deepEqual(progress.at(-1), { checked: 5, total: 5 });
  assert.equal(await revalidateDirectFirmware(receipt), true);
  await fs.writeFile(f.image, 'replaced');
  assert.equal(await revalidateDirectFirmware(receipt), false);
  assert.notEqual((await prepareDirectFirmware('mtk', f.manifest)).sha256, receipt.sha256);
});

test('MTK receipt binds the implicit sibling XSD and never lists it twice when declared', async t => {
  const f = await fixture(t);
  const receipt = await prepareDirectFirmware('mtk', f.manifest);
  assert.ok(receipt.files.some(member => member.path === f.schema));
  await fs.writeFile(f.schema, '<schema version="modified"/>');
  assert.equal(await revalidateDirectFirmware(receipt), false);
  assert.notEqual((await prepareDirectFirmware('mtk', f.manifest)).sha256, receipt.sha256);
  await fs.unlink(f.schema);
  await assert.rejects(prepareDirectFirmware('mtk', f.manifest), { code: 'missing-files' });
  await fs.writeFile(f.schema, '<schema version="restored"/>');
  const original = await fs.readFile(f.manifest, 'utf8');
  await fs.writeFile(f.manifest, original.replace('<flash-mode>', '<flash-mode xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="flash.xsd">'));
  const explicit = await prepareDirectFirmware('mtk', f.manifest);
  assert.equal(explicit.files.filter(member => member.path === f.schema).length, 1);
});

test('missing files and user cancellation cannot produce a direct-write receipt', async t => {
  const f = await fixture(t);
  const stop = new AbortController();
  await assert.rejects(prepareDirectFirmware('mtk', f.manifest, {
    signal: stop.signal,
    onProgress: () => stop.abort()
  }), { code: 'cancelled' });
  await fs.unlink(f.image);
  await assert.rejects(prepareDirectFirmware('mtk', f.manifest), { code: 'missing-files' });
});

test('a staged firmware retains the approved bytes even when the original is changed', async t => {
  const f = await fixture(t);
  const receipt = await prepareDirectFirmware('mtk', f.manifest);
  const staged = await stageDirectFirmware('mtk', receipt, { stagingBase: path.dirname(f.image) });
  t.after(staged.release);
  const copy = staged.firmware.files.find(file => path.basename(file.path) === 'boot.img');
  assert.equal(await fs.readFile(path.join(path.dirname(staged.firmware.path), 'flash.xsd'), 'utf8'), '<schema version="fixture"/>');
  await fs.writeFile(f.image, 'changed');
  assert.equal(staged.firmware.sha256, receipt.sha256);
  assert.notEqual(staged.firmware.path, f.manifest);
  assert.equal(await fs.readFile(copy.path, 'utf8'), 'original');
  assert.equal(await revalidateDirectFirmware(staged.firmware), true);
  assert.equal(await revalidateDirectFirmware(receipt), false);
  await staged.release();
  await assert.rejects(fs.stat(copy.path), { code: 'ENOENT' });
  assert.equal(await fs.readFile(f.image, 'utf8'), 'changed');
});

test('an identical renamed full RK image retains the admitted content digest', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'direct-rk-receipt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const image = Buffer.alloc(160);
  image.write('RKFW');
  image.writeUInt16LE(102, 4);
  image.writeUInt32LE(102, 25);
  image.writeUInt32LE(8, 29);
  image.writeUInt32LE(110, 33);
  image.writeUInt32LE(8, 37);
  const first = path.join(root, 'original.img');
  const second = path.join(root, 'renamed.img');
  await Promise.all([fs.writeFile(first, image), fs.writeFile(second, image)]);
  const [one, two] = await Promise.all([prepareDirectFirmware('rk', first), prepareDirectFirmware('rk', second)]);
  assert.equal(one.contentSha256, two.contentSha256);
  assert.notEqual(one.sha256, two.sha256);
});
