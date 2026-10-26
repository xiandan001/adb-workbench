const test = require('node:test');
const assert = require('node:assert/strict');
const { readInstallerLanguage, parseInstallerReceipt } = require('../electron/lib/installer-language.cjs');

const KEY = 'HKEY_LOCAL_MACHINE\\Software\\Veylo\\adb-workbench Installer';
const LOCATION = 'C:\\Program Files\\Veylo';
const executablePath = `${LOCATION}\\app.exe`;
function receipt(locale = 'en-US', location = LOCATION) {
  return `\r\n${KEY}\r\n    Language    REG_SZ    ${locale}\r\n    InstallLocation    REG_SZ    ${location}\r\n`;
}
function runtime(stdout = Buffer.from(receipt()), overrides = {}) {
  const calls = [];
  return { calls, options: { platform: 'win32', isPackaged: true, executablePath, systemRoot: 'C:\\Windows',
    execFile: (file, args, options, callback) => { calls.push({ file, args, options }); callback(null, stdout); }, ...overrides } };
}

test('installer receipt query uses only the fixed machine key and hidden bounded 64-bit reg.exe', async () => {
  const f = runtime();
  assert.equal(await readInstallerLanguage(f.options), 'en-US');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].file, 'C:\\Windows\\System32\\reg.exe');
  assert.deepEqual(f.calls[0].args, ['query', KEY, '/reg:64']);
  assert.deepEqual(f.calls[0].options, { encoding: 'buffer', windowsHide: true, timeout: 2000, maxBuffer: 65536 });
});

test('only packaged Windows applications read the receipt and no PATH lookup is allowed', async () => {
  for (const overrides of [{ platform: 'linux' }, { platform: 'darwin' }, { isPackaged: false },
    { systemRoot: '' }, { systemRoot: 'Windows' }, { executablePath: 'app.exe' }]) {
    const f = runtime(undefined, overrides);
    assert.equal(await readInstallerLanguage(f.options), null);
    assert.equal(f.calls.length, 0);
  }
});

test('all five canonical locales are accepted but aliases, invalid types and duplicate fields are rejected', () => {
  for (const locale of ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR']) assert.equal(parseInstallerReceipt(receipt(locale), executablePath), locale);
  for (const locale of ['en', 'EN-US', '1033', 'fr-FR', 'en-US --other-option', '']) assert.equal(parseInstallerReceipt(receipt(locale), executablePath), null);
  assert.equal(parseInstallerReceipt(receipt().replace('Language    REG_SZ', 'Language    REG_EXPAND_SZ'), executablePath), null);
  assert.equal(parseInstallerReceipt(`${receipt()}    Language    REG_SZ    ja-JP\n`, executablePath), null);
  assert.equal(parseInstallerReceipt(`${receipt()}    InstallLocation    REG_SZ    ${LOCATION}\n`, executablePath), null);
  assert.equal(parseInstallerReceipt(receipt().replace(KEY, 'HKEY_CURRENT_USER\\Other'), executablePath), null);
});

test('installation directory is mandatory and must match the executable directory, not a prefix', () => {
  assert.equal(parseInstallerReceipt(receipt('ko-KR', 'c:/PROGRAM Files/Veylo/'), executablePath), 'ko-KR');
  assert.equal(parseInstallerReceipt(receipt('ja-JP', `${LOCATION}\\.\\`), executablePath), 'ja-JP');
  for (const location of ['C:\\Other', `${LOCATION}2`, 'C:\\Program Files', '.\\Veylo', 'C:Veylo', '', `${LOCATION}\\child`, `${LOCATION}\u0000`]) {
    assert.equal(parseInstallerReceipt(receipt('en-US', location), executablePath), null);
  }
  assert.equal(parseInstallerReceipt(receipt().split('    InstallLocation')[0], executablePath), null);
});

test('Unicode installation paths work with UTF-8 and UTF-16 redirected output', async () => {
  const location = 'D:\\Apps\\测试目录\\Veylo';
  for (const encoding of ['utf8', 'utf16le']) {
    const f = runtime(Buffer.from(receipt('zh-TW', location), encoding), { executablePath: `${location}\\app.exe` });
    assert.equal(await readInstallerLanguage(f.options), 'zh-TW');
  }
});

test('common Windows Chinese output is decoded before exact install-path matching', async () => {
  const bytes = Buffer.concat([Buffer.from(receipt('zh-CN', 'D:\\Apps\\').trimEnd(), 'ascii'), Buffer.from([0xb2, 0xe2, 0xca, 0xd4]), Buffer.from('\r\n')]);
  const f = runtime(bytes, { executablePath: 'D:\\Apps\\测试\\app.exe' });
  assert.equal(await readInstallerLanguage(f.options), 'zh-CN');
  assert.equal(await readInstallerLanguage({ ...f.options, executablePath: 'D:\\Apps\\別の場所\\app.exe' }), null);
});

test('missing keys, command failures and oversized or malformed output fall back without throwing', async () => {
  for (const execFile of [(_file, _args, _options, done) => done(new Error('not found')),
    () => { throw new Error('spawn failed'); },
    (_file, _args, _options, done) => done(null, Buffer.alloc(65537)),
    (_file, _args, _options, done) => done(null, null),
    (_file, _args, _options, done) => done(null, Buffer.from([0xff, 0xff, 0xff]))]) {
    assert.equal(await readInstallerLanguage(runtime(undefined, { execFile }).options), null);
  }
});
