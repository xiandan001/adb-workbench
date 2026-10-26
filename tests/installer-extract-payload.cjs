const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { archive } = require('app-builder-lib/out/targets/archive');
const { configureDifferentialAwareArchiveOptions } = require('app-builder-lib/out/targets/differentialUpdateInfoBuilder');

const scratch = path.resolve(__dirname, '../.superpowers');
const largeBytes = 96 * 1024 * 1024;
const smallCount = 4096;
const smallBytes = 8 * 1024;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function createExtractionPayload() {
  fs.mkdirSync(scratch, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(scratch, 'installer-extract-payload-'));
  const source = path.join(workspace, 'synthetic-app');
  fs.mkdirSync(path.join(source, 'small'), { recursive: true });
  const files = [];
  const block = crypto.randomBytes(1024 * 1024);
  const largeFile = path.join(source, 'large-data.bin');
  const largeHash = crypto.createHash('sha256');
  const descriptor = fs.openSync(largeFile, 'wx');
  try {
    for (let written = 0; written < largeBytes; written += block.length) {
      fs.writeSync(descriptor, block); largeHash.update(block);
    }
  } finally { fs.closeSync(descriptor); }
  files.push({ name: 'large-data.bin', bytes: largeBytes, sha256: largeHash.digest('hex') });
  for (let index = 0; index < smallCount; index++) {
    const name = `small/fixture-${String(index).padStart(5, '0')}.bin`;
    const bytes = Buffer.from(block.subarray(0, smallBytes));
    bytes.writeUInt32LE(index);
    fs.writeFileSync(path.join(source, name), bytes, { flag: 'wx' });
    files.push({ name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const unpackedBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  assert.ok(unpackedBytes <= 128 * 1024 * 1024, 'Synthetic payload must remain bounded');
  const options = configureDifferentialAwareArchiveOptions({ withoutDir: true, compression: 'maximum' });
  const archiveFile = path.join(workspace, 'synthetic-app.7z');
  const started = Date.now();
  await archive('7z', archiveFile, source, options);
  const manifestFile = path.join(workspace, 'payload-manifest.json');
  const manifest = { archiveFile, archiveSha256: sha256(fs.readFileSync(archiveFile)), archiveBytes: fs.statSync(archiveFile).size,
    unpackedBytes, fileCount: files.length, compressionOptions: options, packagingMs: Date.now() - started,
    electronBuilderVersion: require('app-builder-lib/package.json').version, files };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { manifestFile, ...manifest };
}

module.exports = { createExtractionPayload };
