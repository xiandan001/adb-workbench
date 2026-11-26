const assert = require('node:assert/strict');
const nodeTest = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { openMtkFileLease } = require('../electron/lib/firmware-mtk-file-lease.cjs');

const windows = { skip: process.platform === 'win32' ? false : 'Windows share semantics' };
const fixtureError = { code: 'firmware-staging-unavailable' };
const denied = error => ['EPERM', 'EBUSY', 'EACCES'].includes(error.code);

async function scratch(t) {
  const base = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(base, 'veylo-mtk-lease-test-'));
  let lease;
  t.after(async () => {
    await lease?.release();
    assert.equal(path.dirname(dir), base);
    assert.match(path.basename(dir), /^veylo-mtk-lease-test-[\w-]+$/);
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    async open(files, options) { return (lease = await openMtkFileLease(files, options)); },
  };
}

nodeTest('firmware file lease rejects nonlocal, special and control paths', async () => {
  for (const files of [
    [], ['relative/path.xml'], ['\\\\server\\share\\flash.xml'], ['C:\\x\\..\\flash.xml'],
    ['C:\\x\\flash.xml:other'], ['C:\\x\\NUL.xml'], ['C:\\x\\flash.xml\n'],
    ['C:\\x\\flash.xml', 'c:/x/FLASH.xml'], new Array(521).fill('C:\\flash.xml'),
  ]) await assert.rejects(openMtkFileLease(files), fixtureError);
});

nodeTest('original and staged aliases stay readable but both names are protected until release', windows, async t => {
  const fixture = await scratch(t);
  const file = path.join(fixture.dir, "固件 & 确认 'test'.bin");
  const alias = path.join(fixture.dir, 'staged.bin');
  await fs.writeFile(file, 'protected');
  const lease = await fixture.open([file]);
  assert.equal(lease.isActive(), true);
  await fs.link(file, alias);
  await lease.add([alias]);
  assert.deepEqual(await Promise.all([fs.readFile(file, 'utf8'), fs.readFile(alias, 'utf8')]), ['protected', 'protected']);
  for (const name of [file, alias]) {
    await assert.rejects(fs.writeFile(name, 'modified'), denied);
    await assert.rejects(fs.rename(name, name + '.moved'), denied);
    await assert.rejects(fs.unlink(name), denied);
  }
  await lease.release();
  assert.equal(lease.isActive(), false);
  await fs.writeFile(file, 'after release');
  assert.equal(await fs.readFile(alias, 'utf8'), 'after release');
});

nodeTest('failed additions discard every held handle rather than leaving a partial active lease', windows, async t => {
  const fixture = await scratch(t);
  const first = path.join(fixture.dir, 'first.bin');
  const second = path.join(fixture.dir, 'second.bin');
  const missing = path.join(fixture.dir, 'missing.bin');
  await Promise.all([fs.writeFile(first, 'first'), fs.writeFile(second, 'second')]);
  const lease = await fixture.open([first]);
  await assert.rejects(lease.add([second, missing]), fixtureError);
  assert.equal(lease.isActive(), false);
  await Promise.all([fs.writeFile(first, 'released'), fs.writeFile(second, 'released')]);
});

nodeTest('an owner abort ends the source lock and an already aborted call acquires nothing', windows, async t => {
  const fixture = await scratch(t);
  const file = path.join(fixture.dir, 'abort.bin');
  await fs.writeFile(file, 'start');
  const controller = new AbortController();
  const lease = await fixture.open([file], { signal: controller.signal });
  controller.abort();
  await assert.rejects(lease.add([file]), { code: 'cancelled' });
  await lease.release();
  assert.equal(lease.isActive(), false);
  await fs.writeFile(file, 'released');
  await assert.rejects(openMtkFileLease([file], { signal: controller.signal }), { code: 'cancelled' });
});

nodeTest('an already writable member prevents a lease without keeping earlier members frozen', windows, async t => {
  const fixture = await scratch(t);
  const first = path.join(fixture.dir, 'first.bin');
  const editor = path.join(fixture.dir, 'editor.bin');
  await Promise.all([fs.writeFile(first, 'first'), fs.writeFile(editor, 'second')]);
  const handle = await fs.open(editor, 'r+');
  try {
    await assert.rejects(fixture.open([first, editor]), fixtureError);
    await fs.writeFile(first, 'released after initial failure');
  } finally {
    await handle.close();
  }
});
