const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { preflightFirmware } = require('../electron/lib/firmware-preflight.cjs');

async function tempDir(t) {
  const main = await fs.mkdtemp(path.join(os.tmpdir(), 'veylo-firmware-test-'));
  t.after(() => fs.rm(main, { recursive: true, force: true }));
  return main;
}

function rkImage() {
  const bytes = Buffer.alloc(102 + 24 + 64 + 32);
  bytes.write('RKFW', 0);
  bytes.writeUInt16LE(102, 4);
  bytes.writeUInt32LE(0x80, 21);
  bytes.writeUInt32LE(102, 25);
  bytes.writeUInt32LE(24, 29);
  bytes.writeUInt32LE(126, 33);
  bytes.writeUInt32LE(64, 37);
  bytes.write('BOOT', 102);
  bytes.write('RKAF', 126);
  bytes.fill('a', 190);
  return bytes;
}

const flashXml = (scatter = '../MT1234_Android_scatter.xml', agent = 'DA fixture.bin', optional = '') =>
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<flash-mode><project>test_board</project>' +
  '<dagent>' + agent + '</dagent><scatter>' + scatter + '</scatter>' +
  optional + '</flash-mode>';

const scatterXml = (file = 'images/boot &amp; dt.img') => '<root>' +
  '<general name="MTK_PLATFORM_CFG"><platform>MT1234</platform></general><storage_type name="EMMC">' +
  '<partition_index name="SYS0"><is_download>true</is_download><file_name>' + file + '</file_name></partition_index>' +
  '<partition_index name="SYS1"><is_download>false</is_download><file_name>disabled.img</file_name></partition_index>' +
  '</storage_type></root>';

async function createMtk(t) {
  const folder = await tempDir(t);
  const dir = path.join(folder, '固件 包');
  const agentDir = path.join(dir, 'download_agent');
  const manifest = path.join(agentDir, 'flash.xml');
  const scatter = path.join(dir, 'MT1234_Android_scatter.xml');
  const imageDir = path.join(dir, 'images');
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(imageDir);
  await fs.writeFile(manifest, flashXml(undefined, undefined, '<auth-file>vendor.auth</auth-file>'));
  await fs.writeFile(scatter, scatterXml());
  await fs.writeFile(path.join(agentDir, 'DA fixture.bin'), 'DA test bytes');
  await fs.writeFile(path.join(agentDir, 'vendor.auth'), 'authorization fixture');
  await fs.writeFile(path.join(imageDir, 'boot & dt.img'), 'image fixture');
  return { dir, folder, agentDir, manifest, scatter, imageDir };
}

test('RK checks the real RKFW header ranges and distinguishes unsupported and invalid images', async t => {
  const dir = await tempDir(t);
  const name = path.join(dir, '设备 固件.img');
  const bytes = rkImage();
  await fs.writeFile(name, bytes);
  const valid = await preflightFirmware('rk', name);
  assert.equal(valid.ok, true);
  assert.equal(valid.format, 'rk-update-img');
  assert.equal(valid.fileName, '设备 固件.img');
  assert.equal(valid.sizeBytes, bytes.length);
  assert.equal(valid.chip, '0x00000080');

  await fs.writeFile(name, bytes.subarray(0, 140));
  assert.equal((await preflightFirmware('rk', name)).code, 'invalid-firmware');
  bytes.write('HI', 55);
  bytes.writeUInt32LE(1, 57);
  await fs.writeFile(name, bytes);
  assert.equal((await preflightFirmware('rk', name)).code, 'invalid-firmware');
  bytes.fill(0, 55, 61);
  bytes.writeUInt32LE(105, 33);
  await fs.writeFile(name, bytes);
  assert.equal((await preflightFirmware('rk', name)).code, 'invalid-firmware');
  await fs.writeFile(name, Buffer.alloc(bytes.length));
  assert.equal((await preflightFirmware('rk', name)).code, 'unsupported-format');
  await fs.writeFile(name, '');
  assert.equal((await preflightFirmware('rk', name)).code, 'invalid-firmware');
  assert.equal((await preflightFirmware('mtk', name)).code, 'unsupported-format');
  assert.equal((await preflightFirmware('rk', path.join(dir, 'not-there.img'))).code, 'file-unavailable');
});

test('MTK validates real download_agent parent scatter and enabled image, DA, and auth files', async t => {
  const fixture = await createMtk(t);
  const result = await preflightFirmware('mtk', fixture.manifest);
  assert.equal(result.ok, true);
  assert.equal(result.format, 'mtk-flash-xml');
  assert.equal(result.chip, 'MT1234');
  assert.deepEqual(result.files.map(file => file.name).sort(), [
    'MT1234_Android_scatter.xml', 'download_agent/DA fixture.bin',
    'download_agent/vendor.auth', 'images/boot & dt.img'
  ]);
  assert.ok(result.files.every(file => file.status === 'present' && file.sizeBytes > 0));

  await fs.unlink(path.join(fixture.agentDir, 'vendor.auth'));
  await fs.writeFile(path.join(fixture.imageDir, 'boot & dt.img'), '');
  const incomplete = await preflightFirmware('mtk', fixture.manifest);
  assert.equal(incomplete.code, 'missing-files');
  assert.equal(incomplete.files.find(file => file.name.endsWith('vendor.auth')).status, 'missing');
  assert.equal(incomplete.files.find(file => file.name.endsWith('boot & dt.img')).status, 'invalid');
});

test('MTK refuses escapes, network or DOS device paths, target links and DTDs', async t => {
  const fixture = await createMtk(t);
  await fs.writeFile(path.join(fixture.folder, 'private.img'), 'not part of the package');
  for (const reference of ['../private.img', 'C:/private.img', '//example.invalid/c/share.img', 'NUL.img', 'images/boot.img:secret']) {
    await fs.writeFile(fixture.scatter, scatterXml(reference));
    const rejected = await preflightFirmware('mtk', fixture.manifest);
    assert.equal(rejected.code, 'unsafe-reference');
    assert.equal(JSON.stringify(rejected).includes(fixture.folder), false);
  }
  const link = path.join(fixture.dir, 'redirected');
  await fs.symlink(fixture.folder, link, process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(fixture.scatter, scatterXml('redirected/private.img'));
  assert.equal((await preflightFirmware('mtk', fixture.manifest)).code, 'unsafe-reference');

  await fs.writeFile(fixture.manifest, '<!DOCTYPE flash-mode SYSTEM "https://example.invalid/test.dtd"><flash-mode/>');
  assert.equal((await preflightFirmware('mtk', fixture.manifest)).code, 'invalid-manifest');
  await fs.writeFile(fixture.manifest, flashXml().replace('<flash-mode>', '<flash-mode xml:base="//example.invalid/share/">'));
  assert.equal((await preflightFirmware('mtk', fixture.manifest)).code, 'invalid-manifest');
  await fs.writeFile(fixture.manifest, flashXml().replace('<flash-mode>', '<flash-mode xsi:noNamespaceSchemaLocation="https://example.invalid/schema.xsd">'));
  assert.equal((await preflightFirmware('mtk', fixture.manifest)).code, 'unsafe-reference');
  await fs.writeFile(fixture.manifest, flashXml('deep.xml').repeat(20000));
  assert.equal((await preflightFirmware('mtk', fixture.manifest)).code, 'manifest-too-large');
});

test('MTK does not accept unrelated XML, unknown scatter formats, or no enabled image', async t => {
  const fixture = await createMtk(t);
  for (const manifest of ['<not-a-flash-mode/>', '<flash-mode><project>one</project></flash-mode>',
    flashXml().replace('</flash-mode>', '</flash-modd>'), flashXml('scatter.txt')]) {
    await fs.writeFile(fixture.manifest, manifest);
    assert.equal((await preflightFirmware('mtk', fixture.manifest)).code, 'invalid-manifest');
  }
  await fs.writeFile(fixture.manifest, flashXml());
  await fs.writeFile(fixture.scatter, '<root><general name="MTK_PLATFORM_CFG"/></root>');
  assert.equal((await preflightFirmware('mtk', fixture.manifest)).code, 'invalid-manifest');
  await fs.writeFile(fixture.scatter, scatterXml('NONE'));
  assert.equal((await preflightFirmware('mtk', fixture.manifest)).code, 'invalid-manifest');
});

test('MTK supports a UTF-16 manifest and checks local schema dependencies', async t => {
  const fixture = await createMtk(t);
  const manifest = flashXml()
    .replace('UTF-8', 'UTF-16')
    .replace('<flash-mode>', '<flash-mode xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="flash.xsd">');
  await fs.writeFile(fixture.manifest, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(manifest, 'utf16le')]));
  const missing = await preflightFirmware('mtk', fixture.manifest);
  assert.equal(missing.code, 'missing-files');
  assert.equal(missing.files.find(file => file.name === 'download_agent/flash.xsd').status, 'missing');

  await fs.writeFile(path.join(fixture.agentDir, 'flash.xsd'), 'schema fixture');
  const complete = await preflightFirmware('mtk', fixture.manifest);
  assert.equal(complete.ok, true);
  assert.equal(complete.project, 'test_board');
});
