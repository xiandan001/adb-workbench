const fs = require('node:fs/promises');
const path = require('node:path');
const sax = require('sax');

const MAX_XML_BYTES = 2 * 1024 * 1024;
const MAX_NODES = 16000;
const MAX_DEPTH = 48;
const MAX_FILES = 256;
const RK_HEADER_BYTES = 102;

function failure(code) {
  return Object.assign(new Error(code), { preflightCode: code });
}

async function readAt(handle, length, position = 0) {
  const buffer = Buffer.alloc(length);
  for (let offset = 0; offset < length;) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (!bytesRead) throw failure('file-unavailable');
    offset += bytesRead;
  }
  return buffer;
}

async function withStableFile(file, action) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()
    || normalizedPath(await fs.realpath(file)) !== normalizedPath(file)) throw failure('file-unavailable');
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw failure('file-unavailable');
    const result = await action(handle, opened.size);
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw failure('file-unavailable');
    return result;
  } finally {
    await handle.close();
  }
}

async function inspectRockchip(handle, size) {
  if (size < 4) throw failure('invalid-firmware');
  // Rockchip rkdeveloptool's packed STRUCT_RKIMAGE_HEAD (RKImage.h and RKImage.cpp).
  if (!(await readAt(handle, 4)).equals(Buffer.from('RKFW'))) throw failure('unsupported-format');
  if (size < RK_HEADER_BYTES) throw failure('invalid-firmware');
  const header = await readAt(handle, RK_HEADER_BYTES);
  const headerSize = header.readUInt16LE(4);
  const bootOffset = header.readUInt32LE(25);
  const bootLength = header.readUInt32LE(29);
  const imageOffset = header.readUInt32LE(33);
  const imageLength = BigInt(header.readUInt32LE(37));
  const extendedLength = header.toString('ascii', 55, 57) === 'HI' ? BigInt(header.readUInt32LE(57)) << 32n : 0n;
  const imageEnd = BigInt(imageOffset) + imageLength + extendedLength;
  if (headerSize < RK_HEADER_BYTES || bootOffset < headerSize || bootLength < 4
    || imageOffset < bootOffset + bootLength || imageLength + extendedLength < 4n
    || BigInt(size) - imageEnd < 32n) throw failure('invalid-firmware');
  const chip = '0x' + header.readUInt32LE(21).toString(16).padStart(8, '0');
  return { ok: true, chip };
}

function parseXml(bytes) {
  try {
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw failure('invalid-manifest');
    const parser = sax.parser(true, { strictEntities: true, position: false });
    const frames = [];
    let root;
    let count = 0;
    let declaration = false;
    const invalid = () => { throw failure('invalid-manifest'); };
    parser.onerror = parser.ondoctype = parser.onsgmldeclaration = invalid;
    parser.onprocessinginstruction = instruction => {
      if (instruction.name !== 'xml' || declaration || root) invalid();
      declaration = true;
    };
    parser.onopentag = node => {
      if (++count > MAX_NODES || frames.length >= MAX_DEPTH || (!frames.length && root)) invalid();
      if (node.name.toLowerCase() === 'xi:include' || Object.hasOwn(node.attributes, 'xml:base')) invalid();
      const value = { name: node.name.toLowerCase(), attributes: node.attributes, children: [], text: '' };
      if (frames.length) frames.at(-1).children.push(value);
      else root = value;
      frames.push(value);
    };
    parser.ontext = parser.oncdata = text => {
      if (frames.length) frames.at(-1).text += text;
      else if (text.trim()) invalid();
    };
    parser.onclosetag = () => { frames.pop(); };
    parser.write(text).close();
    if (!root || frames.length) invalid();
    return root;
  } catch {
    throw failure('invalid-manifest');
  }
}

async function readXml(handle, size) {
  if (size > MAX_XML_BYTES) throw failure('manifest-too-large');
  return parseXml(await readAt(handle, size));
}

const nodeText = node => node && !node.children.length ? node.text.trim() : '';
const normalizedName = field => field.replaceAll('_', '-');

function childValue(node, names) {
  const matches = node.children.filter(child => names.includes(normalizedName(child.name)));
  if (matches.length > 1) throw failure('invalid-manifest');
  return nodeText(matches[0]);
}

function relativeCandidate(root, base, value) {
  if (!value || value.length > 512 || /^[\\/]/.test(value) || /[:*?"<>|]/.test(value)
    || Array.from(value).some(char => char.charCodeAt(0) < 32)) return null;
  const segments = value.split(/[\\/]/);
  if (segments.some(segment => segment !== '..' && segment !== '.' && (!segment || /[. ]$/.test(segment)
    || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment)))) return null;
  const file = path.resolve(base, ...segments);
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
  return { file, name: relative.split(path.sep).join('/') };
}

function normalizedPath(file) {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function checkDependency(root, base, reference) {
  const candidate = relativeCandidate(root, base, reference);
  if (!candidate) throw failure('unsafe-reference');
  try {
    const link = await fs.realpath(candidate.file);
    if (normalizedPath(link) !== normalizedPath(candidate.file)) throw failure('unsafe-reference');
    const info = await fs.lstat(link);
    if (info.isSymbolicLink()) throw failure('unsafe-reference');
    if (!info.isFile() || info.size <= 0) return { ...candidate, status: 'invalid' };
    return { ...candidate, status: 'present', sizeBytes: info.size };
  } catch (error) {
    if (error.preflightCode) throw error;
    return { ...candidate, status: error.code === 'ENOENT' ? 'missing' : 'invalid' };
  }
}

function scatterContents(root) {
  if (!['root', 'scatter', 'scatter-xml'].includes(root.name)) throw failure('invalid-manifest');
  let chip;
  const references = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (node.name === 'platform' && /^MT[a-z\d_-]{2,22}$/i.test(nodeText(node))) chip ??= nodeText(node);
    if (node.name === 'partition_index' || node.name === 'partition') {
      const download = String(childValue(node, ['is-download']) || node.attributes.is_download || '').trim();
      const fileName = String(childValue(node, ['file-name']) || node.attributes.file_name || '').trim();
      if (/^(?:true|yes|1)$/i.test(download)) {
        if (!fileName || /^(?:none|__nodl_)$/i.test(fileName)) throw failure('invalid-manifest');
        references.push(fileName);
        if (references.length > MAX_FILES) throw failure('invalid-manifest');
      } else if (fileName && !/^(?:false|no|0)$/i.test(download)) {
        throw failure('invalid-manifest');
      }
    }
    stack.push(...node.children);
  }
  if (!references.length) throw failure('invalid-manifest');
  return { chip, references };
}

function toDisplayFile({ name, status, sizeBytes }) {
  return sizeBytes === undefined ? { name, status } : { name, status, sizeBytes };
}

function schemaReferences(node) {
  const noNamespace = node.attributes['xsi:noNamespaceSchemaLocation']?.trim();
  const pairs = node.attributes['xsi:schemaLocation']?.trim().split(/\s+/) || [];
  if (pairs.length % 2) throw failure('invalid-manifest');
  return [...(noNamespace ? [noNamespace] : []), ...pairs.filter((_, index) => index % 2)];
}

async function inspectMediatek(handle, size, file, files) {
  const manifest = await readXml(handle, size);
  if (manifest.name !== 'flash-mode') throw failure('invalid-manifest');
  const agentRef = childValue(manifest, ['dagent', 'da-file']);
  const scatterRef = childValue(manifest, ['scatter', 'scatter-file']);
  if (!agentRef || !/\.xml$/i.test(scatterRef)) throw failure('invalid-manifest');
  const manifestDir = path.dirname(file);
  // The manufacturer layout keeps flash.xml in download_agent beside a one-level-up scatter.
  const parent = path.dirname(manifestDir);
  const nestedAgent = /^download[_-]agent$/i.test(path.basename(manifestDir)) && parent !== path.dirname(parent);
  const root = nestedAgent ? parent : manifestDir;
  const seen = new Set();
  const examine = async (base, reference) => {
    const dependency = await checkDependency(root, base, reference);
    const key = normalizedPath(dependency.file);
    if (!seen.has(key)) {
      if (seen.size >= MAX_FILES) throw failure('invalid-manifest');
      seen.add(key);
      files.push(toDisplayFile(dependency));
    }
    return dependency;
  };
  await examine(manifestDir, agentRef);
  const scatter = await examine(manifestDir, scatterRef);
  for (const reference of schemaReferences(manifest)) await examine(manifestDir, reference);
  for (const names of [['auth-file', 'authentication-file'], ['cert-file', 'certificate-file'], ['per-device-cert-file']]) {
    const reference = childValue(manifest, names);
    if (reference) await examine(manifestDir, reference);
  }
  let chip;
  if (scatter.status === 'present') {
    if (normalizedPath(scatter.file) === normalizedPath(file)) throw failure('invalid-manifest');
    const scatterRoot = await withStableFile(scatter.file, readXml);
    const parsed = scatterContents(scatterRoot);
    chip = parsed.chip;
    const scatterDir = path.dirname(scatter.file);
    for (const reference of [...schemaReferences(scatterRoot), ...parsed.references]) await examine(scatterDir, reference);
  }
  const project = childValue(manifest, ['project']);
  const metadata = { ...(chip ? { chip } : {}), ...(/^[\p{L}\p{N}_. -]{1,80}$/u.test(project) ? { project } : {}) };
  return files.some(item => item.status !== 'present') ? { ...metadata, code: 'missing-files' } : { ...metadata, ok: true };
}

async function preflightFirmware(platform, filePath) {
  const formats = { rk: { extension: '.img', name: 'rk-update-img' }, mtk: { extension: '.xml', name: 'mtk-flash-xml' } };
  const expected = typeof platform === 'string' && Object.hasOwn(formats, platform) ? formats[platform] : null;
  const fileName = typeof filePath === 'string' ? path.basename(filePath) : '';
  const result = { ok: false, platform, fileName, format: null, sizeBytes: 0, files: [] };
  if (!expected || path.extname(fileName).toLowerCase() !== expected.extension) return { ...result, code: 'unsupported-format' };
  result.format = expected.name;
  try {
    if (!path.isAbsolute(filePath) || /^[\\/]{2}/.test(filePath)) throw failure('file-unavailable');
    const directory = await fs.realpath(path.dirname(filePath));
    if (/^[\\/]{2}/.test(directory)) throw failure('file-unavailable');
    const resolved = path.join(directory, fileName);
    const details = await withStableFile(resolved, (handle, size) => {
      result.sizeBytes = size;
      return platform === 'rk' ? inspectRockchip(handle, size) : inspectMediatek(handle, size, resolved, result.files);
    });
    return { ...result, ...details };
  } catch (error) {
    return { ...result, code: error.preflightCode || 'file-unavailable' };
  }
}

module.exports = { preflightFirmware };
