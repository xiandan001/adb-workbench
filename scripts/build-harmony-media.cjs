const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const sdk = process.argv.includes('--sdk') ? path.resolve(arg('--sdk')) : '';
if (!sdk || !fs.existsSync(path.join(sdk, 'build/cmake/ohos.toolchain.cmake'))) throw new Error('Supply --sdk with an extracted OpenHarmony Native SDK directory.');
const suffix = process.platform === 'win32' ? '.exe' : '';
const cmake = path.join(sdk, 'build-tools/cmake/bin/cmake' + suffix);
const ninja = path.join(sdk, 'build-tools/cmake/bin/ninja' + suffix);
const sourceDir = path.join(root, 'native/harmony-media');
const outputDir = path.join(root, 'hdc/agent');
const abis = process.argv.includes('--abis') ? arg('--abis').split(',') : ['arm64-v8a'];
if (!abis.length || abis.some(abi => !['arm64-v8a', 'x86_64', 'armeabi-v7a'].includes(abi))) throw new Error('Unsupported native agent ABI.');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sources = fs.readdirSync(sourceDir).filter(file => /\.(cpp|h|txt|map)$/.test(file)).sort();
const sourceSha256 = hash(Buffer.concat(sources.flatMap(file => [Buffer.from(file + '\n'), fs.readFileSync(path.join(sourceDir, file)), Buffer.from('\n')])));
const sdkInfo = JSON.parse(fs.readFileSync(path.join(sdk, 'oh-uni-package.json'), 'utf8'));
const manifest = { version: 1, protocol: 1, minimumApi: 12, sdkVersion: sdkInfo.version,
  sourceSha256, sources, privacy: 'platform-consent-required', abis: {} };

for (const abi of abis) {
  const build = path.join(root, '.superpowers/harmony-media-build', abi);
  const args = ['-S', sourceDir, '-B', build, '-G', 'Ninja', '-DCMAKE_MAKE_PROGRAM=' + ninja,
    '-DCMAKE_TOOLCHAIN_FILE=' + path.join(sdk, 'build/cmake/ohos.toolchain.cmake'),
    '-DOHOS_ARCH=' + abi, '-DOHOS_STL=c++_static', '-DCMAKE_BUILD_TYPE=Release'];
  execFileSync(cmake, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  execFileSync(cmake, ['--build', build, '--parallel', '2'], { cwd: root, stdio: 'inherit', windowsHide: true });
  const file = path.join(build, 'awb-media-agent.so');
  execFileSync(path.join(sdk, 'llvm/bin/llvm-strip' + suffix), ['--strip-unneeded', file], { cwd: root, windowsHide: true });
  const symbols = execFileSync(path.join(sdk, 'llvm/bin/llvm-nm' + suffix), ['--dynamic', '--defined-only', file], { encoding: 'utf8', windowsHide: true });
  if (!symbols.includes('UiTestExtension_OnInit') || !symbols.includes('UiTestExtension_OnRun')) throw new Error('Native agent entrypoints are missing.');
  const bytes = fs.readFileSync(file);
  const machine = { 'arm64-v8a': 183, x86_64: 62, 'armeabi-v7a': 40 }[abi];
  const elfClass = abi === 'armeabi-v7a' ? 1 : 2;
  if (!bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || bytes[4] !== elfClass || bytes[5] !== 1
    || bytes.readUInt16LE(16) !== 3 || bytes.readUInt16LE(18) !== machine) throw new Error('Built artifact is not the expected ELF shared library.');
  const destination = path.join(outputDir, abi, 'awb-media-agent.so');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(file, destination);
  manifest.abis[abi] = { file: abi + '/awb-media-agent.so', machine, elfClass, bytes: bytes.length, sha256: hash(bytes) };
}
fs.mkdirSync(outputDir, { recursive: true });
const notices = [
  ['NOTICE-LLVM.txt', path.join(sdk, 'llvm/NOTICE')],
  ['NOTICE-OpenHarmony-Runtime.txt', path.join(sdk, 'NOTICE.txt')]
];
manifest.notices = {};
for (const [name, source] of notices) {
  const text = fs.readFileSync(source, 'utf8').replace(/\r\n/g, '\n');
  fs.writeFileSync(path.join(outputDir, name), text, 'utf8');
  manifest.notices[name] = hash(Buffer.from(text));
}
fs.writeFileSync(path.join(outputDir, 'NOTICE.txt'), [
  'AWB Harmony Media Agent',
  'Application-owned source: native/harmony-media.',
  'Built using OpenHarmony Native SDK ' + manifest.sdkVersion + '.',
  'The shared libraries statically link the SDK libc++, libc++abi, unwind and compiler runtime components.',
  'Their upstream LLVM/Apache license terms and LLVM exceptions are preserved in NOTICE-LLVM.txt.',
  'Additional SDK runtime notices (including musl) are retained in NOTICE-OpenHarmony-Runtime.txt.',
  'SDK notices are retained for completeness; not all listed SDK components are distributed here.',
  'The device provides its native libc and AVScreenCapture/AVCodec/window libraries; they are not bundled.',
  'The OpenHarmony SDK and toolchain are build dependencies only and are not included in the installer.',
  ''
].join('\n'), 'utf8');
fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ sourceSha256, sdkVersion: manifest.sdkVersion, abis: manifest.abis }, null, 2));
