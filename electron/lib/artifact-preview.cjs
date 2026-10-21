const fs = require('fs');
const path = require('path');
const { collectArtifactFiles } = require('./artifact-export.cjs');

const TEXT_LIMIT = 512 * 1024;
const IMAGE_LIMIT = 12 * 1024 * 1024;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const TEXT_TYPES = new Set(['.md', '.json', '.txt', '.log', '.csv']);
const previewable = name => Boolean(IMAGE_TYPES[path.extname(name).toLowerCase()]) || TEXT_TYPES.has(path.extname(name).toLowerCase());

async function artifactDetails(item) {
  const selected = await collectArtifactFiles(item);
  return {
    sizeBytes: selected.files.reduce((sum, file) => sum + file.bytes, 0),
    files: selected.files.filter(file => previewable(file.name)).map(file => ({ name: file.name, bytes: file.bytes }))
  };
}

async function previewArtifact(item, name) {
  const selected = await collectArtifactFiles(item);
  const file = selected.files.find(entry => entry.name === name);
  if (!file || !previewable(file.name)) throw new Error('该文件不在当前产物中，或不支持预览');
  const extension = path.extname(file.name).toLowerCase();
  const mime = IMAGE_TYPES[extension];
  const handle = await fs.promises.open(file.source, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('预览目标不是普通文件');
    if (mime && stat.size > IMAGE_LIMIT) throw new Error('图片超过 12 MB，请使用打开目录查看');
    // Read bounded bytes even if a capture is still appending to this file.
    const buffer = Buffer.alloc(Math.min(stat.size, mime ? IMAGE_LIMIT : TEXT_LIMIT));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (mime) return { name, kind: 'image', content: `data:${mime};base64,${bytes.toString('base64')}`, truncated: false };
    let content = bytes.toString('utf8');
    const truncated = stat.size > TEXT_LIMIT;
    if (extension === '.json' && !truncated) {
      try { content = JSON.stringify(JSON.parse(content), null, 2); } catch { /* Show invalid JSON as plain text. */ }
    }
    return { name, kind: 'text', content, truncated };
  } finally {
    await handle.close();
  }
}

module.exports = { artifactDetails, previewArtifact, TEXT_LIMIT, IMAGE_LIMIT };
