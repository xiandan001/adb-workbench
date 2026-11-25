const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { installRkDirectTool } = require('../electron/lib/firmware-rk-tool-download.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'veylo-rk-tool-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, destination: path.join(root, 'installed') };
}

test('preparing RK tools rejects modified, oversized and aborted downloads before extraction', { skip: process.platform !== 'win32' }, async t => {
  const { root, destination } = await fixture(t);
  let calls = 0;
  const run = (body, signal) => installRkDirectTool(destination, {
    signal,
    async fetchArchive(url, options) {
      calls++;
      assert.match(url, /^https:\/\/raw\.githubusercontent\.com\/ArmSoM\/rockchip-tools\/[a-f0-9]{40}\//);
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      return { ok: true, body };
    },
    extract() { calls += 100; },
  });
  assert.equal(await run([Buffer.alloc(727727)]), false);
  assert.equal(await run([Buffer.alloc(727728)]), false);
  assert.equal(await run([Buffer.alloc(5)], AbortSignal.abort()), false);
  assert.equal(calls, 2);
  assert.deepEqual(await fs.readdir(root), []);
});

test('verified archive is extracted on Windows and the cached tool skips subsequent downloads', {
  skip: process.platform !== 'win32' || !process.env.VEYLO_RK_246_ARCHIVE,
}, async t => {
  const { root, destination } = await fixture(t);
  const archive = await fs.readFile(process.env.VEYLO_RK_246_ARCHIVE);
  let downloads = 0;
  const options = { async fetchArchive() { downloads++; return { ok: true, body: [archive] }; } };
  assert.equal(await installRkDirectTool(destination, options), true);
  assert.equal(await installRkDirectTool(destination, options), true);
  assert.equal(downloads, 1);
  assert.deepEqual((await fs.readdir(destination)).sort(), ['config.ini', 'upgrade_tool.exe']);
  assert.deepEqual(await fs.readdir(root), ['installed']);
});
