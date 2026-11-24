const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Identity of known Windows x64 driver packages. The driver files are selected locally.
const packages = Object.freeze({
  rk: {
    'rockusb.inf': '4fc1ea1a32e235f03805b0955dc06203be15738d0672d9679a9539ccc23e8887',
    'rockusb.cat': 'f9098e5a0067b5d01cb6f5be87f42a196503aee7e2d1fc41d573c80fd5c9f10f',
    'rockusb.sys': 'dbe50ec840008e3db5f4acd6063f622438f3bbb049e4db84e1721ea0425fcac1',
  },
  mtk: {
    'cdc-acm.inf': '35ae68b6b6327d1624bbef947c778de2a9206fbeab6157dd2d71eea987b3d62a',
    'cdc-acm.cat': '4d864f4bfff089888e076920ae5f72e7e704d03c86c3a9c26eab7996140f8431',
    'x64/usb2ser.sys': 'd9c6659d5f417ce6f82093de9e6e73e8390b6da8777591c445bfc5364325c9ef',
  },
});

const packageFor = platform => typeof platform === 'string' && Object.hasOwn(packages, platform) ? packages[platform] : null;
const samePath = (first, second) => process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
const maxDriverFileSize = 2 * 1024 * 1024;

function signedDriverInfName(platform) {
  const profile = packageFor(platform);
  return profile ? Object.keys(profile)[0] : null;
}

async function readKnownFile(io, directory, relative, sha256) {
  const filename = path.join(directory, relative);
  const original = await io.lstat(filename);
  if (!original.isFile() || original.size < 1 || original.size > maxDriverFileSize ||
    !samePath(await io.realpath(filename), filename)) return null;
  const file = await io.open(filename, 'r');
  try {
    const current = await file.stat();
    if (!current.isFile() || current.size !== original.size || current.mtimeMs !== original.mtimeMs ||
      current.ino !== original.ino || current.dev !== original.dev) return null;
    const bytes = Buffer.alloc(current.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) return null;
      offset += bytesRead;
    }
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) return null;
    return { path: filename, sha256, relative };
  } finally { await file.close(); }
}

async function inspectSignedDriver(platform, directory, io = fs) {
  const profile = packageFor(platform);
  if (!profile || typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0') ||
    /^[\\/]{2}/.test(directory)) return [];
  try {
    const canonical = await io.realpath(directory);
    if (!samePath(canonical, path.resolve(directory)) || !(await io.stat(canonical)).isDirectory()) return [];
    const entries = await Promise.all(Object.entries(profile).map(([relative, hash]) => readKnownFile(io, canonical, relative, hash)));
    return entries.every(Boolean) ? entries : [];
  } catch { return []; }
}

module.exports = { inspectSignedDriver, signedDriverInfName };
