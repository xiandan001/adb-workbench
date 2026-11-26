const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { tmpdir } = require('node:os');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
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

async function fileSnapshot(file) {
  const [resolved, stat] = await Promise.all([fs.realpath(file), fs.lstat(file, { bigint: true })]);
  if (comparable(resolved) !== comparable(file) || !stat.isFile() || stat.size <= 0n) throw error('firmware-changed');
  return { identity: stamp(stat), size: stat.size };
}

const identity = async file => (await fileSnapshot(file)).identity;

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

async function snapshotFirmware(platform, filePath, signal) {
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
    try { return { path: member, ...await fileSnapshot(member) }; }
    catch (cause) {
      if (schema && comparable(member) === comparable(schema) && cause.code === 'ENOENT') throw error('missing-files');
      throw cause;
    }
  }));
  // A changed manifest must not invalidate the dependency snapshot.
  const checkedAgain = await preflightFirmware(platform, file);
  if (JSON.stringify(checkedAgain) !== JSON.stringify(preflight)) throw error('firmware-changed');
  abort(signal);
  return { preflight, file, root, before };
}

function receiptFor(platform, file, preflight, parts, files) {
  return {
    path: file, chip: preflight.chip, project: preflight.project,
    sha256: createHash('sha256').update(JSON.stringify(parts)).digest('hex'),
    ...(platform === 'rk' ? { contentSha256: parts[0][1] } : {}),
    files,
  };
}

/**
 * Build an internal evidence receipt from the main-window file picker.
 * It proves identity of the selected files, not compatibility with a device.
 */
async function prepareDirectFirmware(platform, filePath, { signal, onProgress = () => {} } = {}) {
  const { preflight, file, root, before } = await snapshotFirmware(platform, filePath, signal);
  const parts = [];
  for (const member of before) {
    abort(signal);
    const digest = await hashFile(member.path, member.identity, signal);
    parts.push([path.relative(root, member.path), digest]);
    onProgress({ checked: parts.length, total: before.length });
  }
  const receipt = receiptFor(platform, file, preflight, parts, before.map(({ path, identity }) => ({ path, identity })));
  if (!await revalidateDirectFirmware(receipt)) throw error('firmware-changed');
  return receipt;
}

async function prepareMtkQuickReview(filePath, { signal } = {}) {
  const { preflight, file, before } = await snapshotFirmware('mtk', filePath, signal);
  return { path: file, chip: preflight.chip, project: preflight.project, files: before };
}

async function revalidateDirectFirmware(receipt) {
  if (!Array.isArray(receipt?.files) || !receipt.files.length) return false;
  try {
    const current = await Promise.all(receipt.files.map(async file => (await identity(file.path)) === file.identity));
    return current.every(Boolean);
  } catch { return false; }
}

async function createStaging(stagingBase) {
  const base = await fs.realpath(stagingBase);
  const stage = await fs.mkdtemp(path.join(base, 'veylo-flash-'));
  const release = async () => {
    if (comparable(path.dirname(stage)) !== comparable(base) || !/^veylo-flash-[\w-]+$/.test(path.basename(stage))) return;
    await fs.rm(stage, { recursive: true, force: true });
  };
  return { stage, release };
}

async function stageDirectFirmware(platform, receipt, { signal, stagingBase = tmpdir() } = {}) {
  abort(signal);
  if (!await revalidateDirectFirmware(receipt)) throw error('firmware-changed');
  const { stage, release } = await createStaging(stagingBase);
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

async function requireStableSource(member, handle) {
  try {
    if (stamp(await handle.stat({ bigint: true })) === member.identity && await identity(member.path) === member.identity) return;
  } catch { /* A disappeared or replaced source cannot be used in this job. */ }
  throw error('firmware-changed');
}

async function copyHashedMember(member, destination, { signal, report }) {
  const chunkSize = 1024 * 1024;
  let source;
  try { source = await fs.open(member.path, 'r'); }
  catch { throw error('firmware-changed'); }
  try {
    await requireStableSource(member, source);
    abort(signal);
    const size = Number(member.size);
    const hash = createHash('sha256');
    const writer = createWriteStream(destination, { flags: 'wx', mode: 0o600, highWaterMark: chunkSize });
    let received = 0;
    const meter = new Transform({
      transform(bytes, _encoding, done) {
        received += bytes.length;
        if (received > size) { done(error('firmware-changed')); return; }
        try {
          abort(signal);
          hash.update(bytes);
          report(writer.bytesWritten);
          done(null, bytes);
        } catch (cause) { done(cause); }
      }
    });
    await pipeline(source.createReadStream({ autoClose: false, highWaterMark: chunkSize }), meter, writer, { signal });
    await requireStableSource(member, source);
    if (received !== size) throw error('firmware-changed');
    const staged = await fileSnapshot(destination);
    if (staged.size !== member.size || writer.bytesWritten !== size) throw error('firmware-staging-unavailable');
    report(writer.bytesWritten);
    return { path: destination, identity: staged.identity, digest: hash.digest('hex') };
  } finally { await source.close(); }
}

function stagingError(cause, signal) {
  if (signal?.aborted || cause.name === 'AbortError') return error('cancelled');
  if (cause.code === 'ENOSPC' || cause.code === 'EDQUOT') return error('firmware-disk-full');
  if (cause.code === 'firmware-changed' || cause.code === 'firmware-staging-unavailable') return cause;
  return error('firmware-staging-unavailable');
}

async function prepareStagedDirectFirmware(platform, filename, { signal, onProgress = () => {}, stagingBase = tmpdir() } = {}) {
  const { file, root, before, preflight } = await snapshotFirmware(platform, filename, signal);
  const total = before.reduce((sum, member) => sum + member.size, 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw error('firmware-size-unsupported');
  const totalBytes = Number(total);
  let staging;
  try {
    staging = await createStaging(stagingBase);
    let copiedBytes = 0, last = -1;
    const report = extra => {
      const current = copiedBytes + extra;
      if (current > last && current <= totalBytes) {
        last = current;
        onProgress({ copiedBytes: current, totalBytes });
      }
    };
    report(0);
    const files = [], parts = [];
    for (const member of before) {
      abort(signal);
      const relative = path.relative(root, member.path);
      const destination = safeMember(staging.stage, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      const { digest, ...staged } = await copyHashedMember(member, destination, { signal, report });
      copiedBytes += Number(member.size);
      files.push(staged);
      parts.push([relative, digest]);
    }
    abort(signal);
    const stagedPath = safeMember(staging.stage, path.relative(root, file));
    const checked = await preflightFirmware(platform, stagedPath);
    const firmware = receiptFor(platform, stagedPath, preflight, parts, files);
    if (JSON.stringify(checked) !== JSON.stringify(preflight) ||
        !await revalidateDirectFirmware({ files: before }) || !await revalidateDirectFirmware(firmware)) throw error('firmware-changed');
    abort(signal);
    return { firmware, release: staging.release };
  } catch (cause) {
    if (staging) await staging.release().catch(() => {});
    throw stagingError(cause, signal);
  }
}

async function stageMtkQuickReview(receipt, {
  signal, stagingBase = tmpdir(), openLease = require('./firmware-mtk-file-lease.cjs').openMtkFileLease,
} = {}) {
  abort(signal);
  const root = packageRoot('mtk', receipt.path);
  const lease = await openLease(receipt.files.map(member => member.path), { signal });
  let staging;
  try {
    const ready = () => {
      abort(signal);
      if (!lease.isActive()) throw error('firmware-staging-unavailable');
    };
    ready();
    if (!await revalidateDirectFirmware(receipt)) throw error('firmware-changed');
    staging = await createStaging(stagingBase);
    const device = String((await fs.stat(staging.stage, { bigint: true })).dev);
    if (receipt.files.some(member => !member.identity.startsWith(device + ':'))) {
      await staging.release();
      staging = null;
      // Different volumes cannot share a hard link. Keep the source read-only for the verified copy.
      const copy = await prepareStagedDirectFirmware('mtk', receipt.path, { signal, stagingBase });
      try { ready(); }
      catch (cause) { await copy.release().catch(() => {}); throw cause; }
      await lease.release();
      return copy;
    }
    const files = [];
    for (const original of receipt.files) {
      ready();
      const destination = safeMember(staging.stage, path.relative(root, original.path));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.link(original.path, destination);
      const linked = await fileSnapshot(destination);
      // Link creation updates ctime on NTFS. Data was locked before this operation.
      const created = linked.identity.slice(0, linked.identity.lastIndexOf(':'));
      const expected = original.identity.slice(0, original.identity.lastIndexOf(':'));
      if (created !== expected) throw error('firmware-changed');
      files.push({ path: destination, identity: linked.identity });
    }
    await lease.add(files.map(member => member.path));
    const filename = safeMember(staging.stage, path.relative(root, receipt.path));
    const firmware = { path: filename, chip: receipt.chip, project: receipt.project, files };
    if (!await revalidateDirectFirmware(firmware)) throw error('firmware-changed');
    ready();
    return {
      firmware, protectedFiles: files.map(member => member.path), isActive: lease.isActive,
      async release() {
        try { await lease.release(); }
        finally { await staging.release(); }
      },
    };
  } catch (cause) {
    await lease.release().catch(() => {});
    await staging?.release().catch(() => {});
    throw stagingError(cause, signal);
  }
}

module.exports = { prepareDirectFirmware, revalidateDirectFirmware, stageDirectFirmware, prepareStagedDirectFirmware,
  prepareMtkQuickReview, stageMtkQuickReview };
