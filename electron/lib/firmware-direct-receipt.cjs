const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { tmpdir } = require('node:os');
const { pipeline } = require('node:stream/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const { preflightFirmware } = require('./firmware-preflight.cjs');

function error(code) {
  return Object.assign(new Error(code), { code });
}

const comparable = file => process.platform === 'win32' ? file.toLowerCase() : file;
const abort = signal => { if (signal?.aborted) throw error('cancelled'); };
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');

function packageRoot(platform, file) {
  const directory = path.dirname(file);
  const parent = path.dirname(directory);
  if (platform === 'mtk' && /^download[_-]agent$/i.test(path.basename(directory)) && parent !== path.dirname(parent)) return parent;
  return directory;
}

async function identity(file) {
  const [resolved, stat] = await Promise.all([fs.realpath(file), fs.lstat(file, { bigint: true })]);
  if (comparable(resolved) !== comparable(file) || !stat.isFile() || stat.size <= 0n) throw error('firmware-changed');
  return stamp(stat);
}

async function hashFile(file, expected, signal) {
  const opened = await fs.open(file, 'r');
  try {
    if (stamp(await opened.stat({ bigint: true })) !== expected || await identity(file) !== expected) throw error('firmware-changed');
    const hash = createHash('sha256');
    for await (const bytes of opened.createReadStream({ autoClose: false })) {
      abort(signal);
      hash.update(bytes);
    }
    if (stamp(await opened.stat({ bigint: true })) !== expected || await identity(file) !== expected) throw error('firmware-changed');
    return hash.digest('hex');
  } finally { await opened.close(); }
}

function safeMember(root, name) {
  const file = path.resolve(root, name);
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw error('firmware-changed');
  return file;
}

/**
 * Build an internal evidence receipt from the main-window file picker.
 * It proves identity of the selected files, not compatibility with a device.
 */
async function prepareDirectFirmware(platform, filePath, { signal, onProgress = () => {} } = {}) {
  abort(signal);
  const preflight = await preflightFirmware(platform, filePath);
  if (!preflight.ok) throw error(preflight.code || 'firmware-unavailable');
  const file = await fs.realpath(filePath);
  const root = packageRoot(platform, file);
  const dependencies = [file, ...preflight.files.map(item => safeMember(root, item.name))];
  // V6 resolves this sibling even if the manifest does not declare a schemaLocation.
  const schema = platform === 'mtk' ? path.join(path.dirname(file), 'flash.xsd') : null;
  if (schema && !dependencies.some(member => comparable(member) === comparable(schema))) dependencies.push(schema);
  const members = [...new Map(dependencies.map(member => [comparable(member), member])).values()];
  const before = await Promise.all(members.map(async member => {
    try { return await identity(member); }
    catch (cause) {
      if (schema && comparable(member) === comparable(schema) && cause.code === 'ENOENT') throw error('missing-files');
      throw cause;
    }
  }));
  // A changed manifest must not invalidate the dependency snapshot.
  const checkedAgain = await preflightFirmware(platform, file);
  if (JSON.stringify(checkedAgain) !== JSON.stringify(preflight)) throw error('firmware-changed');
  const parts = [];
  for (let index = 0; index < members.length; index++) {
    abort(signal);
    const digest = await hashFile(members[index], before[index], signal);
    parts.push([path.relative(root, members[index]), digest]);
    onProgress({ checked: index + 1, total: members.length });
  }
  const files = members.map((member, index) => ({ path: member, identity: before[index] }));
  const receipt = {
    path: file, chip: preflight.chip, project: preflight.project,
    sha256: createHash('sha256').update(JSON.stringify(parts)).digest('hex'),
    ...(platform === 'rk' ? { contentSha256: parts[0][1] } : {}),
    files
  };
  if (!await revalidateDirectFirmware(receipt)) throw error('firmware-changed');
  return receipt;
}

async function revalidateDirectFirmware(receipt) {
  if (!Array.isArray(receipt?.files) || !receipt.files.length) return false;
  try {
    const current = await Promise.all(receipt.files.map(async file => (await identity(file.path)) === file.identity));
    return current.every(Boolean);
  } catch { return false; }
}

async function stageDirectFirmware(platform, receipt, { signal, stagingBase = tmpdir() } = {}) {
  abort(signal);
  if (!await revalidateDirectFirmware(receipt)) throw error('firmware-changed');
  const base = await fs.realpath(stagingBase);
  const stage = await fs.mkdtemp(path.join(base, 'veylo-flash-'));
  const release = async () => {
    if (comparable(path.dirname(stage)) !== comparable(base) || !/^veylo-flash-[\w-]+$/.test(path.basename(stage))) return;
    await fs.rm(stage, { recursive: true, force: true });
  };
  try {
    const root = packageRoot(platform, receipt.path);
    for (const original of receipt.files) {
      abort(signal);
      const destination = safeMember(stage, path.relative(root, original.path));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await pipeline(createReadStream(original.path), createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal });
    }
    const file = safeMember(stage, path.relative(root, receipt.path));
    const staged = await prepareDirectFirmware(platform, file, { signal });
    if (staged.sha256 !== receipt.sha256 || !await revalidateDirectFirmware(receipt)) throw error('firmware-changed');
    return { firmware: staged, release };
  } catch (cause) {
    await release().catch(() => {});
    throw cause;
  }
}

module.exports = { prepareDirectFirmware, revalidateDirectFirmware, stageDirectFirmware };
