const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { writeFileSync, readdirSync } = require('node:fs');
const { createHash } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { prepareDirectFirmware, revalidateDirectFirmware, stageDirectFirmware, prepareStagedDirectFirmware,
  prepareMtkQuickReview, stageMtkQuickReview } = require('../electron/lib/firmware-direct-receipt.cjs');

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

test('MTK quick review and same-volume staging never stream a partition and keep both aliases read-only', {
  skip: process.platform !== 'win32',
}, async t => {
  const f = await fixture(t);
  const base = path.dirname(f.image);
  const opened = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await opened(...args);
    handle.createReadStream = () => assert.fail('No bulk payload stream in the quick path');
    return handle;
  });
  const receipt = await prepareMtkQuickReview(f.manifest);
  assert.equal(receipt.sha256, undefined);
  assert.equal(receipt.chip, 'MT8189');
  assert.equal(receipt.files.length, 5);
  const staged = await stageMtkQuickReview(receipt, { stagingBase: base });
  t.after(staged.release);
  assert.equal(staged.isActive(), true);
  assert.equal(staged.firmware.path.endsWith(path.join('download_agent', 'flash.xml')), true);
  assert.equal(staged.protectedFiles.length, 5);
  const alias = staged.protectedFiles.find(file => path.basename(file) === 'boot.img');
  assert.ok(alias && path.dirname(alias) !== base);
  assert.equal((await fs.stat(f.image, { bigint: true })).ino, (await fs.stat(alias, { bigint: true })).ino);
  assert.equal(await fs.readFile(alias, 'utf8'), 'original');
  await assert.rejects(fs.open(f.image, 'r+'));
  await assert.rejects(fs.open(alias, 'r+'));
  await assert.rejects(fs.rename(alias, alias + '.renamed'));
  assert.equal(await revalidateDirectFirmware(staged.firmware), true);
  await staged.release();
  await assert.rejects(fs.stat(alias), { code: 'ENOENT' });
  await fs.writeFile(f.image, 'now writable');
});

test('MTK quick preparation rejects a same-sized changed dependency before staging', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const base = path.dirname(f.image);
  const receipt = await prepareMtkQuickReview(f.manifest);
  await fs.writeFile(f.image, 'modified');
  await assert.rejects(stageMtkQuickReview(receipt, { stagingBase: base }), { code: 'firmware-changed' });
  assert.equal((await fs.readdir(base)).some(name => name.startsWith('veylo-flash-')), false);
  await fs.writeFile(f.image, 'now unlocked');
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

test('one-pass MTK staging reads each full source once and preserves the digest and implicit XSD', async t => {
  const f = await fixture(t);
  const root = path.dirname(f.image);
  const expected = await prepareDirectFirmware('mtk', f.manifest);
  const opened = fs.open;
  const streamReads = [];
  t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await opened(file, ...args);
    const create = handle.createReadStream.bind(handle);
    handle.createReadStream = (...options) => { streamReads.push(file); return create(...options); };
    return handle;
  });
  const progress = [];
  const staged = await prepareStagedDirectFirmware('mtk', f.manifest, {
    stagingBase: root, onProgress: step => progress.push(step),
  });
  t.after(staged.release);
  assert.deepEqual(streamReads, expected.files.map(entry => entry.path));
  assert.equal(staged.firmware.sha256, expected.sha256);
  assert.equal(staged.firmware.files.length, expected.files.length);
  assert.equal(await fs.readFile(path.join(path.dirname(staged.firmware.path), 'flash.xsd'), 'utf8'), '<schema version="fixture"/>');
  assert.equal(await revalidateDirectFirmware(staged.firmware), true);
  assert.equal(await revalidateDirectFirmware(expected), true);
  const totalBytes = (await Promise.all(expected.files.map(entry => fs.stat(entry.path)))).reduce((sum, stat) => sum + stat.size, 0);
  assert.deepEqual(progress[0], { copiedBytes: 0, totalBytes });
  assert.deepEqual(progress.at(-1), { copiedBytes: totalBytes, totalBytes });
  assert.ok(progress.every((event, index) => event.totalBytes === totalBytes &&
    Number.isSafeInteger(event.copiedBytes) && (!index || event.copiedBytes > progress[index - 1].copiedBytes)));
  await staged.release();
  assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith('veylo-flash-')), []);
});

test('one-pass staging cleans temporary bytes after cancellation and after changes to source or mirror', async t => {
  const f = await fixture(t);
  const root = path.dirname(f.image);
  const image = Buffer.alloc(3 * 1024 * 1024, 5);
  const stop = new AbortController();
  for (const action of ['cancel', 'source', 'staged']) {
    await fs.writeFile(f.image, image);
    const options = { stagingBase: root };
    let triggered = false;
    if (action === 'cancel') options.signal = stop.signal;
    options.onProgress = ({ copiedBytes, totalBytes }) => {
      const afterRead = action === 'staged' ? copiedBytes === totalBytes : copiedBytes > 1024 * 1024;
      if (!afterRead || triggered) return;
      triggered = true;
      if (action === 'cancel') stop.abort();
      else if (action === 'source') writeFileSync(f.image, Buffer.alloc(image.length, 6));
      else {
        const stage = readdirSync(root).find(name => name.startsWith('veylo-flash-'));
        writeFileSync(path.join(root, stage, 'boot.img'), Buffer.alloc(image.length, 7));
      }
    };
    await assert.rejects(prepareStagedDirectFirmware('mtk', f.manifest, options), {
      code: action === 'cancel' ? 'cancelled' : 'firmware-changed',
    });
    assert.equal(triggered, true);
    assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith('veylo-flash-')), []);
    assert.equal((await fs.readFile(f.image))[0], action === 'source' ? 6 : 5);
  }
});

test('one-pass staging gives typed disk and unavailable stage errors and leaves the selected files intact', async t => {
  const f = await fixture(t);
  const root = path.dirname(f.image);
  await assert.rejects(prepareStagedDirectFirmware('mtk', f.manifest, { stagingBase: path.join(root, 'non-existent') }),
    { code: 'firmware-staging-unavailable' });
  const mkdir = fs.mkdir;
  t.mock.method(fs, 'mkdir', async (folder, ...args) => {
    if (path.resolve(folder).split(path.sep).some(name => name.startsWith('veylo-flash-'))) {
      throw Object.assign(new Error('disk full fixture'), { code: 'ENOSPC' });
    }
    return mkdir(folder, ...args);
  });
  await assert.rejects(prepareStagedDirectFirmware('mtk', f.manifest, { stagingBase: root }),
    { code: 'firmware-disk-full' });
  assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith('veylo-flash-')), []);
  assert.equal(await fs.readFile(f.image, 'utf8'), 'original');
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
  const staged = await prepareStagedDirectFirmware('rk', second, { stagingBase: root });
  t.after(staged.release);
  assert.equal(one.contentSha256, two.contentSha256);
  assert.notEqual(one.sha256, two.sha256);
  assert.equal(staged.firmware.sha256, two.sha256);
  assert.equal(staged.firmware.contentSha256, createHash('sha256').update(image).digest('hex'));
});
