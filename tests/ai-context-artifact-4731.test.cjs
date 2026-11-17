const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readAiArtifactFile } = require('../electron/lib/ai-outbound-processor.cjs');
const { TEXT_LIMIT } = require('../electron/lib/artifact-preview.cjs');
const { contentBytes } = require('../electron/lib/ai-context-limits.json');

test('trusted AI artifact worker reads full content beyond ordinary preview without changing the 512KiB display bound', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veylo-ai-artifact-fixture-'));
  try {
    const filename = path.join(directory, 'sample.log'), content = '中😀'.repeat(200000);
    await fs.writeFile(filename, content);
    const result = await readAiArtifactFile({ filename });
    assert.equal(result.content, content);
    assert.equal(result.truncated, false);
    assert.equal(TEXT_LIMIT, 512 * 1024);
    const original = JSON.stringify({ result: 'x'.repeat(700000), rerunSnapshot: { command: 'PRIVATE-RERUN-NEVER-SEND' } });
    await fs.writeFile(filename, original);
    const task = await readAiArtifactFile({ filename, privateTaskResult: true });
    assert.doesNotMatch(task.content, /PRIVATE-RERUN|rerunSnapshot/);
    assert.equal(JSON.parse(task.content).result.length, 700000);
    assert.equal(await fs.readFile(filename, 'utf8'), original);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('AI-specific artifact limits reject oversize and incomplete private JSON instead of sending a partial original', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veylo-ai-artifact-boundary-'));
  try {
    const filename = path.join(directory, 'sample.log');
    await fs.writeFile(filename, 'x'.repeat(contentBytes + 1));
    await assert.rejects(readAiArtifactFile({ filename }), error => error.code === 'AI_HANDOFF_ARTIFACT');
    await fs.writeFile(filename, '{"rerunSnapshot":');
    await assert.rejects(readAiArtifactFile({ filename, privateTaskResult: true }), error => error.code === 'AI_HANDOFF_PRIVATE_REPORT');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(readAiArtifactFile({ filename }, { signal: controller.signal }), error => error.code === 'AI_SEND_CANCELLED');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('AI artifact worker rejects malformed and truncated UTF8 without substituting bytes or changing the source', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veylo-ai-artifact-utf8-invalid-'));
  try {
    const filename = path.join(directory, 'sample.log');
    for (const original of [Buffer.from([0xff]), Buffer.from([0xe4, 0xb8]), Buffer.from([0xf0, 0x9f, 0x98]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80])]) {
      await fs.writeFile(filename, original);
      await assert.rejects(readAiArtifactFile({ filename }), error => error.code === 'AI_HANDOFF_ARTIFACT');
      assert.deepEqual(await fs.readFile(filename), original);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('AI artifact strict UTF8 keeps valid Unicode, literal replacement characters and BOM unchanged', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veylo-ai-artifact-utf8-valid-'));
  try {
    const filename = path.join(directory, 'sample.log');
    for (const text of ['中文 😀 valid', 'literal \uFFFD is valid text', '\uFEFF中文 😀 literal \uFFFD']) {
      const original = Buffer.from(text, 'utf8'); await fs.writeFile(filename, original);
      const result = await readAiArtifactFile({ filename });
      assert.equal(result.content, text); assert.equal(result.truncated, false); assert.deepEqual(await fs.readFile(filename), original);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
