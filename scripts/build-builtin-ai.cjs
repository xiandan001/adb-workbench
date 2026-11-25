const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { parse } = require('@babel/parser');

const root = path.resolve(__dirname, '..');
const sourceDirectory = path.join(root, 'native', 'builtin-ai');
const outputDirectory = path.join(root, 'build', 'generated', 'builtin-ai');
const fixtureDirectory = path.join(root, '.superpowers', 'builtin-ai-fixture');
const artifact = 'veylo-builtin-ai.node';
const runtimeVersion = require('electron/package.json').version;
const maxSourceBytes = 64 * 1024;
const buildFailure = code => Object.assign(new Error(code), { code });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function validateKeys(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 32 ||
      values.some(value => typeof value !== 'string' || !/^[\x21-\x7e]{12,2048}$/.test(value))) {
    throw buildFailure('Invalid or missing builtin AI build credentials.');
  }
  return values.slice();
}

function staticKeys(text) {
  let ast;
  try { ast = parse(text, { sourceType: 'script' }); }
  catch { throw buildFailure('Invalid builtin AI credential file format.'); }
  const body = ast.program.body;
  const statement = body.length === 1 && body[0].type === 'ExpressionStatement' && body[0].expression;
  const left = statement?.left, right = statement?.right;
  const field = right?.type === 'ObjectExpression' && right.properties.length === 1 && right.properties[0];
  if (statement?.type !== 'AssignmentExpression' || statement.operator !== '=' ||
      left?.type !== 'MemberExpression' || left.computed || left.object.name !== 'module' || left.property.name !== 'exports' ||
      field?.type !== 'ObjectProperty' || field.computed ||
      (field.key.name || field.key.value) !== 'AGNES_API_KEYS' || field.value.type !== 'ArrayExpression' ||
      field.value.elements.some(element => element?.type !== 'StringLiteral')) {
    throw buildFailure('Builtin AI credential input must contain only a static AGNES_API_KEYS string array.');
  }
  return field.value.elements.map(element => element.value);
}

function readSmallFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > maxSourceBytes) throw new Error();
    return fs.readFileSync(file, 'utf8');
  } catch { throw buildFailure('Unable to read the builtin AI credential input.'); }
}

function loadKeys(fixture = false, keyFile) {
  if (fixture) return validateKeys([keyFile ? readSmallFile(keyFile).trim() : 'veylo-native-test-only-credential-41']);
  const local = path.join(root, 'electron', 'api-keys.cjs');
  const values = fs.existsSync(local) ? staticKeys(readSmallFile(local)) : [];
  return validateKeys(values.length ? values : (process.env.AGNES_API_KEYS || '').split(',').map(value => value.trim()).filter(Boolean));
}

function maskedHeader(keys) {
  const lines = ['#pragma once', '#include <cstddef>', 'namespace veylo_builtin_ai {',
    'struct EncodedCredential { const unsigned char* encrypted; const unsigned char* mask; std::size_t length; };'];
  const rows = [];
  keys.forEach((key, index) => {
    const bytes = Buffer.from(key, 'ascii'), mask = randomBytes(bytes.length);
    const encrypted = Buffer.from(bytes.map((value, i) => value ^ mask[i]));
    lines.push('static const unsigned char encrypted' + index + '[] = {' + encrypted.join(',') + '};');
    lines.push('static const unsigned char mask' + index + '[] = {' + mask.join(',') + '};');
    rows.push('{encrypted' + index + ',mask' + index + ',' + bytes.length + '}');
    bytes.fill(0);
    encrypted.fill(0);
    mask.fill(0);
  });
  lines.push('static const EncodedCredential kCredentials[] = {' + rows.join(',') + '};',
    'static constexpr std::size_t kCredentialCount = sizeof(kCredentials) / sizeof(kCredentials[0]);', '}', '');
  return lines.join('\n');
}

function credentialFingerprint(keys) {
  return digest(Buffer.from(keys.join('\0'), 'utf8'));
}

function keyPatterns(keys) {
  return [...new Set(keys)].flatMap(key => [Buffer.from(key, 'utf8'), Buffer.from(key, 'utf16le')]);
}

async function assertNoPlaintext(file, patterns, chunkSize = 1024 * 1024) {
  const overlap = Math.max(...patterns.map(pattern => pattern.length)) - 1;
  let tail = Buffer.alloc(0);
  for await (const block of fs.createReadStream(file, { highWaterMark: chunkSize })) {
    const span = tail.length ? Buffer.concat([tail, block]) : block;
    if (patterns.some(pattern => span.includes(pattern))) throw buildFailure('Plaintext builtin AI credentials detected in build output.');
    tail = span.subarray(Math.max(0, span.length - overlap));
  }
}

function sourceFiles() {
  return ['builtin-ai.cpp', 'binding.gyp'].map(name => ({
    name, data: fs.readFileSync(path.join(sourceDirectory, name)),
  }));
}

const sourceFingerprint = files => digest(Buffer.from(JSON.stringify(files.map(file => [file.name, digest(file.data)]))));

function copyElectronHeaders(scratch) {
  const original = process.env.VEYLO_ELECTRON_HEADERS || path.join(os.homedir(), '.electron-gyp', runtimeVersion);
  const required = ['include/node/node_api.h', 'include/node/config.gypi', 'x64/node.lib'];
  if (required.some(file => !fs.existsSync(path.join(original, file)))) {
    throw buildFailure('Matching Electron x64 headers and node.lib are required in the local Electron header cache.');
  }
  const headers = path.join(scratch, 'headers');
  fs.mkdirSync(path.join(headers, 'Release'), { recursive: true });
  fs.cpSync(path.join(original, 'include'), path.join(headers, 'include'), { recursive: true });
  // node-gyp resolves Release/node.lib when passed an offline --nodedir.
  fs.copyFileSync(path.join(original, 'x64', 'node.lib'), path.join(headers, 'Release', 'node.lib'));
  return headers;
}

function compile(scratch) {
  const headers = copyElectronHeaders(scratch);
  const nodeGyp = path.join(path.dirname(require.resolve('node-gyp/package.json')), 'bin', 'node-gyp.js');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'AGNES_API_KEYS') delete env[key];
  const result = spawnSync(process.execPath, [nodeGyp, 'rebuild', '--arch=x64', '--target=' + runtimeVersion,
    '--nodedir=' + headers, '--msvs_version=2022'], {
    cwd: scratch, shell: false, windowsHide: true, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  const compiled = path.join(scratch, 'build', 'Release', artifact);
  if (result.error || result.status !== 0 || !fs.existsSync(compiled)) {
    throw buildFailure('Builtin AI native compilation failed. Check local Electron headers, Python and MSVC Build Tools.');
  }
  return compiled;
}

function atomicWrite(target, bytes) {
  const pending = target + '.' + randomUUID();
  try {
    fs.writeFileSync(pending, bytes, { flag: 'wx', mode: 0o600 });
    fs.renameSync(pending, target);
  } finally {
    if (fs.existsSync(pending)) fs.unlinkSync(pending);
  }
}

async function build({ fixture = false, keyFile } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw buildFailure('Builtin AI native compilation supports Windows x64.');
  }
  const keys = loadKeys(fixture, keyFile), patterns = keyPatterns(keys), files = sourceFiles();
  const temporary = fs.realpathSync(os.tmpdir());
  const scratch = fs.mkdtempSync(path.join(temporary, 'veylo-builtin-ai-'));
  try {
    for (const file of files) fs.writeFileSync(path.join(scratch, file.name), file.data, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(scratch, 'credentials.generated.h'), maskedHeader(keys), { flag: 'wx', mode: 0o600 });
    const compiled = compile(scratch);
    await assertNoPlaintext(compiled, patterns);
    const final = fixture ? fixtureDirectory : outputDirectory;
    const bytes = fs.readFileSync(compiled);
    fs.mkdirSync(final, { recursive: true });
    atomicWrite(path.join(final, artifact), bytes);
    if (!fixture) atomicWrite(path.join(final, 'receipt.json'), JSON.stringify({
      runtimeVersion, arch: 'x64', source: sourceFingerprint(files),
      credentialSet: credentialFingerprint(keys), addon: digest(bytes),
    }) + '\n');
  } finally {
    patterns.forEach(pattern => pattern.fill(0));
    if (path.dirname(scratch) === temporary && /^veylo-builtin-ai-[a-z0-9]+$/i.test(path.basename(scratch))) {
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

function forbiddenPath(file) {
  const name = path.win32.basename(file);
  return /(?:^|[\\/])native[\\/]builtin-ai(?:[\\/]|$)/i.test(file) ||
    /^(?:api-keys(?:\.template)?\.cjs|builtin-ai\.cpp|credentials\.generated\.h|\.env(?:\..*)?)$/i.test(name) ||
    /\.(?:obj|pdb|rsp)$/i.test(name);
}

async function auditTree(directory, patterns, prefix = '') {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const relative = path.join(prefix, entry.name);
    if (entry.isSymbolicLink() || forbiddenPath(relative)) throw buildFailure('Private or intermediate files found in packaged output.');
    if (entry.isDirectory()) await auditTree(file, patterns, relative);
    else if (entry.isFile()) await assertNoPlaintext(file, patterns);
  }
}

async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const keys = loadKeys(), patterns = keyPatterns(keys);
  try {
    const resources = path.join(context.appOutDir, 'resources');
    const archive = path.join(resources, 'app.asar');
    const receipt = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'receipt.json'), 'utf8'));
    if (receipt.runtimeVersion !== runtimeVersion || receipt.arch !== 'x64' || receipt.source !== sourceFingerprint(sourceFiles()) ||
        receipt.credentialSet !== credentialFingerprint(keys) || receipt.addon !== digest(fs.readFileSync(path.join(resources, artifact)))) {
      throw buildFailure('Packaged builtin AI native module does not match the current build inputs.');
    }
    if (require('@electron/asar').listPackage(archive).some(forbiddenPath)) {
      throw buildFailure('Private or intermediate files found in the application archive.');
    }
    await auditTree(context.appOutDir, patterns);
  } catch (cause) {
    if (cause?.code === cause?.message) throw cause;
    throw buildFailure('Builtin AI package verification failed.');
  } finally { patterns.forEach(pattern => pattern.fill(0)); }
}

if (require.main === module) {
  const [option, keyOption, keyFile, ...extra] = process.argv.slice(2);
  const fixture = option === '--fixture';
  if (extra.length || option && !fixture || keyOption && (keyOption !== '--key-file' || !keyFile)) {
    console.error('Usage: node scripts/build-builtin-ai.cjs [--fixture [--key-file path]]');
    process.exitCode = 1;
  } else {
    build({ fixture, keyFile }).then(() => {
      console.log(fixture ? 'Builtin AI native fixture built.' : 'Builtin AI native module built.');
    }).catch(error => {
      console.error(error?.code === error?.message ? error.message : 'Builtin AI native build failed.');
      process.exitCode = 1;
    });
  }
}

module.exports = { afterPack, staticKeys, validateKeys, maskedHeader, keyPatterns, assertNoPlaintext, auditTree };
