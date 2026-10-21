const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createScreenshotActions } = require('../electron/lib/screenshot-actions.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'screenshot-actions-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'shot.png');
  fs.writeFileSync(file, 'fixture');
  const calls = [];
  const originalImage = { isEmpty: () => false, getSize: () => ({ width: 3840, height: 2160 }), resize: (size) => { calls.push(size); return { toDataURL: () => 'data:image/png;base64,preview' }; } };
  const actions = createScreenshotActions({
    nativeImage: { createFromPath: () => originalImage },
    clipboard: { writeImage: image => calls.push(image) },
    shell: { openPath: async filePath => { calls.push(filePath); return ''; }, showItemInFolder: filePath => calls.push(filePath) }
  });
  return { file, directory, calls, originalImage, actions };
}

test('screenshot preview is bounded while clipboard receives original resolution image', async t => {
  const { file, actions, calls, originalImage } = fixture(t);
  assert.match(actions.remember(file).preview, /^data:image/);
  assert.deepEqual(calls[0], { width: 480, height: 270 });
  assert.deepEqual(await actions.perform({ path: file, action: 'copy' }), { success: true });
  assert.equal(calls[1], originalImage);
  assert.equal((await actions.perform({ path: file, action: 'open' })).success, true);
  assert.equal((await actions.perform({ path: file, action: 'folder' })).success, true);
  assert.deepEqual(calls.slice(2), [file, file]);
});

test('screenshot actions reject unregistered files, removed screenshots and invalid actions', async t => {
  const { file, actions, calls } = fixture(t);
  assert.equal((await actions.perform({ path: file, action: 'copy' })).success, false);
  actions.remember(file);
  assert.equal((await actions.perform({ path: file, action: 'delete' })).success, false);
  fs.unlinkSync(file);
  assert.equal((await actions.perform({ path: file, action: 'open' })).success, false);
  assert.equal(calls.length, 1);
});
