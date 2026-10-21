const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { artifactDetails, previewArtifact, TEXT_LIMIT, IMAGE_LIMIT } = require('../electron/lib/artifact-preview.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adb-preview-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('adb-preview-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test('preview and capacity stay inside the selected file artifact', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'chosen.json'), '{"safe":true}');
  await fs.writeFile(path.join(root, 'other.txt'), 'private');
  const item = { deletePath: path.join(root, 'chosen.json') };
  const details = await artifactDetails(item);
  assert.equal(details.sizeBytes, 13);
  assert.deepEqual(details.files.map(file => file.name), ['chosen.json']);
  assert.equal((await previewArtifact(item, 'chosen.json')).content, '{\n  "safe": true\n}');
  await assert.rejects(previewArtifact(item, 'other.txt'), /不在当前产物/);
  await assert.rejects(previewArtifact(item, '../other.txt'), /不在当前产物/);
});

test('bounded text preview preserves original file and does not render HTML', async t => {
  const root = await fixture(t);
  const filename = path.join(root, 'large.log');
  await fs.writeFile(filename, '<script>alert(1)</script>' + 'x'.repeat(TEXT_LIMIT));
  const item = { deletePath: root };
  const preview = await previewArtifact(item, 'large.log');
  assert.equal(preview.kind, 'text');
  assert.equal(preview.truncated, true);
  assert.equal(Buffer.byteLength(preview.content), TEXT_LIMIT);
  assert.ok((await fs.stat(filename)).size > TEXT_LIMIT);
  await fs.writeFile(path.join(root, 'executable.html'), '<script>alert(1)</script>');
  await assert.rejects(previewArtifact(item, 'executable.html'), /不支持预览/);
});

test('image preview returns data URL and rejects oversized images and junctions', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'image.png'), Buffer.from([137, 80, 78, 71]));
  assert.equal((await previewArtifact({ deletePath: root }, 'image.png')).content, 'data:image/png;base64,iVBORw==');
  await fs.writeFile(path.join(root, 'large.png'), Buffer.alloc(IMAGE_LIMIT + 1));
  await assert.rejects(previewArtifact({ deletePath: root }, 'large.png'), /超过 12 MB/);
  const source = path.join(root, 'source');
  const outside = path.join(root, 'outside');
  await fs.mkdir(source); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'private');
  await fs.symlink(outside, path.join(source, 'linked'), 'junction');
  await assert.rejects(artifactDetails({ deletePath: source }), /链接/);
});
