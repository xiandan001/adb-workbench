const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { inspectSignedDriver, signedDriverInfName } = require('../electron/lib/firmware-driver-package.cjs');
const { installWindowsDriver } = require('../electron/lib/firmware-tools-windows.cjs');

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veylo-driver-package-'));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  return directory;
}

test('signed driver profiles accept only known platform names and local absolute directories', async () => {
  assert.equal(signedDriverInfName('rk'), 'rockusb.inf');
  assert.equal(signedDriverInfName('mtk'), 'cdc-acm.inf');
  const io = { realpath: () => assert.fail('invalid input must not reach the filesystem') };
  assert.equal(signedDriverInfName('constructor'), null);
  assert.deepEqual(await inspectSignedDriver('rk', 'relative', io), []);
  assert.deepEqual(await inspectSignedDriver('mtk', '//server/shared', io), []);
  assert.deepEqual(await inspectSignedDriver('constructor', path.resolve('.'), io), []);
});

test('installer names without the expected hash and driver package layout are not trusted', async t => {
  const directory = await temporaryDirectory(t);
  await fs.mkdir(path.join(directory, 'x64'));
  for (const relative of ['rockusb.inf', 'rockusb.cat', 'rockusb.sys', 'cdc-acm.inf', 'cdc-acm.cat', 'x64/usb2ser.sys']) {
    await fs.writeFile(path.join(directory, relative), 'not an approved driver payload');
  }
  assert.deepEqual(await inspectSignedDriver('rk', directory), []);
  assert.deepEqual(await inspectSignedDriver('mtk', directory), []);
});

test('neither firmware profile starts Windows elevation for an INF lacking the locked catalog', { skip: process.platform !== 'win32' }, async t => {
  const directory = await temporaryDirectory(t);
  const marker = 'benign non-installable fixture';
  const sha256 = createHash('sha256').update(marker).digest('hex');
  for (const platform of ['rk', 'mtk']) {
    const filename = path.join(directory, signedDriverInfName(platform));
    await fs.writeFile(filename, marker);
    assert.deepEqual(await installWindowsDriver(platform, [{ path: filename, sha256 }]), { ok: false, code: 'untrusted-package' });
  }
});
