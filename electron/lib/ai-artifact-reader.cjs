const fs = require('node:fs/promises');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { contentBytes } = require('./ai-context-limits.json');
const { stripPrivateTaskSnapshot } = require('./ai-outbound-policy.cjs');
const { tr } = require('./localization.cjs');

async function readAiArtifactFile({ filename, privateTaskResult = false }) {
  const invalid = () => Object.assign(new Error(tr('AI 产物来源已变化或完整内容超过 20 MiB；未读取其他文件或截断。')), { code: 'AI_HANDOFF_ARTIFACT' });
  const expected = path.resolve(filename);
  const before = await fs.lstat(expected);
  if (!before.isFile() || before.isSymbolicLink() || before.size > contentBytes || await fs.realpath(expected) !== expected) throw invalid();
  const handle = await fs.open(expected, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > contentBytes) throw invalid();
    const buffer = Buffer.alloc(Math.min(opened.size + 1, contentBytes + 1));
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    const after = await handle.stat();
    if (size > contentBytes || size !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || await fs.realpath(expected) !== expected) throw invalid();
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size)); }
    catch { throw invalid(); }
    return { kind: 'text', content: privateTaskResult ? stripPrivateTaskSnapshot({ text, truncated: false }) : text, truncated: false };
  } finally { await handle.close(); }
}

module.exports = { readAiArtifactFile };
