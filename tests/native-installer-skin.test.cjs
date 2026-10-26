const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const folder = path.join(root, 'build', 'installer-ui');
const read = (name) => fs.readFileSync(path.join(folder, name), 'utf8');

test('native installer uses complete five-language catalogs and localized brand', () => {
  const catalog = JSON.parse(read('strings.json'));
  assert.deepEqual(Object.keys(catalog), ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR']);
  const keys = Object.keys(catalog['zh-CN']).sort();
  for (const [locale, messages] of Object.entries(catalog)) {
    assert.deepEqual(Object.keys(messages).sort(), keys, locale);
    for (const [key, value] of Object.entries(messages)) {
      assert.equal(typeof value, 'string', `${locale}:${key}`);
      assert.ok(value.trim(), `${locale}:${key}`);
      assert.equal(value.includes('\uFFFD'), false, `${locale}:${key}`);
    }
  }
  assert.equal(catalog['zh-CN'].brand, '卓控台');
  assert.equal(catalog['zh-TW'].brand, '卓控臺');
  for (const locale of ['en-US', 'ja-JP', 'ko-KR']) assert.equal(catalog[locale].brand, 'Veylo');
});

test('native display plugin preserves the explicit NSIS ABI', () => {
  const exports = ['Init', 'Page', 'GetPath', 'GetShortcut', 'GetLaunch', 'GetLanguage', 'TrustExistingPath', 'Failed', 'Dispose'];
  const source = read('installer-skin.cpp');
  for (const name of exports) {
    assert.ok(read('installer-skin.def').includes(`${name}=Skin${name}`), name);
    assert.ok(source.includes(`SKIN_EXPORT(${name})`), name);
  }
  assert.match(read('installer-skin.h'), /__cdecl/);
  assert.match(source, /GlobalFree\(entry\)/);
  assert.match(source, /GlobalAlloc\(GPTR/);
});

test('skin observes genuine engine progress and never installs or launches processes', () => {
  const source = read('installer-skin.cpp');
  assert.match(source, /PBM_GETRANGE/);
  assert.match(source, /PBM_GETPOS/);
  assert.doesNotMatch(source, /PBM_SETPOS|PBM_STEPIT|CreateProcess|ShellExecute|WinExec|RegSetValue|CreateDirectory|WriteFile|CopyFile|DeleteFile|TerminateProcess/);
  assert.match(source, /PostMessageW\(s\.parent, WM_COMMAND, IDOK/);
  assert.match(source, /IsWindowEnabled\(s\.nativeCancel\)/);
  assert.match(source, /GetWindowThreadProcessId\(parent, nullptr\) != GetCurrentThreadId/);
});

test('native skin animation, cancellation and owned resources have bounded lifecycles', () => {
  const source = read('installer-skin.cpp');
  assert.match(source, /SPI_GETCLIENTAREAANIMATION/);
  assert.match(source, /IsIconic\(s\.parent\)/);
  assert.match(source, /KillTimer\(s\.window, kTimer\)/);
  assert.match(source, /RemoveWindowSubclass/);
  assert.match(source, /GdiplusShutdown/);
  assert.match(source, /32768/);
  assert.match(source, /FOS_DONTADDTORECENT/);
  assert.match(source, /s\.cancelOverlay/);
  assert.match(source, /CBN_SELCHANGE/);
});

test('native engine windows stay hidden across post-show callbacks without polling', () => {
  const source = read('installer-skin.cpp');
  assert.match(source, /WM_WINDOWPOSCHANGING/);
  assert.match(source, /position->flags &= ~SWP_SHOWWINDOW/);
  assert.match(source, /position->flags \|= SWP_HIDEWINDOW \| SWP_NOACTIVATE \| SWP_NOZORDER/);
  assert.match(source, /WM_STYLECHANGING/);
  assert.match(source, /style->styleNew &= ~\(WS_VISIBLE \| WS_TABSTOP\)/);
  assert.match(source, /WM_PARENTNOTIFY && LOWORD\(wParam\) == WM_CREATE/);
  assert.match(source, /window == s\.window \|\| GetParent\(window\) != s\.parent/);
  assert.match(source, /SetWindowSubclass\(window, NativeWindowProc/);
  assert.match(source, /WM_NCDESTROY/);
  assert.match(source, /native->window = nullptr/);
  assert.match(source, /RestoreNativeChildren\(\)/);
  assert.match(source, /RemoveWindowSubclass\(native->window, NativeWindowProc/);
  assert.match(source, /CreateRectRgn\(0, 0, 0, 0\)/);
  assert.match(source, /GetWindowRgn\(window, native->originalRegion\)/);
  assert.match(source, /SetWindowRgn\(window, emptyRegion, TRUE\)/);
  assert.match(source, /SetWindowRgn\(native->window, native->originalRegion, TRUE\)\) native->originalRegion = nullptr/);
  assert.match(source, /WM_APP \+ 476/);
  assert.match(source, /PostMessageW\(s\.window, kConcealNativeMessage/);
  assert.match(source, /WM_SHOWWINDOW && wParam && !native->internalHide/);
  assert.match(source, /WM_NEXTDLGCTL && lParam && IsNativeControl/);
  assert.match(source, /requestedControlParent/);
  assert.doesNotMatch(source, /VeyloGuardAtPage|VeyloGuardFlags|VeyloGuardCreated|VeyloGuardShowStyle|SetPropW\(/);
  const tick = source.slice(source.indexOf('void Tick()'), source.indexOf('LRESULT CALLBACK ParentProc'));
  assert.doesNotMatch(tick, /ProtectNative|HideNative|SW_HIDE|SWP_HIDEWINDOW|WS_VISIBLE/);
});

test('native skin matches the approved pure-black elliptical orbit design', () => {
  const source = read('installer-skin.cpp');
  const orbit = read('installer-orbit.h');
  assert.match(source, /kBackground = RGB\(0, 0, 0\), kLeftBackground = RGB\(0, 0, 0\)/);
  assert.match(source, /kAccent = RGB\(29, 213, 162\)/);
  assert.match(orbit, /kOrbitRotationDegrees = -16\.0/);
  assert.match(orbit, /kOuterOrbitWidth = 160\.0, kOuterOrbitHeight = 136\.0/);
  assert.match(orbit, /kInnerOrbitWidth = 132\.0, kInnerOrbitHeight = 108\.0/);
  assert.match(source, /SetDashPattern\(dashes, 2\)/);
  assert.match(source, /const Gdiplus::REAL dashes\[\] = \{2\.0f, 3\.0f\}/);
  assert.match(source, /EllipsePoint\(/);
  assert.doesNotMatch(source, /for \(int tail|SolidBrush glow/);
});

test('new installer targets use an isolated app folder and reject unsafe existing contents', () => {
  const source = read('installer-skin.cpp');
  const guard = read('installer-path-filesystem.h');
  assert.match(source, /AppendApplicationFolder\(entered, s\.initialPath, s\.folderName\)/);
  assert.match(source, /SetWindowTextW\(s\.path, path\.c_str\(\)\)/);
  assert.match(source, /SamePath\(path, s\.initialPath\) && SamePath\(path, s\.trustedInitialPath\)/);
  assert.match(source, /SafeInstallDirectory\(path, trusted\)/);
  assert.match(source, /SKIN_EXPORT\(TrustExistingPath\)/);
  assert.match(guard, /FILE_ATTRIBUTE_REPARSE_POINT/);
  assert.match(guard, /FindFirstFileW/);
  assert.match(guard, /ERROR_NO_MORE_FILES/);
  assert.doesNotMatch(guard, /CreateFileW|CreateDirectoryW|DeleteFileW|RemoveDirectoryW|WriteFile/);
  const catalog = JSON.parse(read('strings.json'));
  for (const messages of Object.values(catalog)) {
    assert.ok(messages.pathSafety);
    assert.ok(messages.unsafeTarget);
  }
});

test('native installer source files use UTF-8 without replacement characters and LF', () => {
  for (const name of fs.readdirSync(folder).filter((name) => /\.(cpp|h|def|json)$/.test(name))) {
    const text = read(name);
    assert.equal(text.includes('\r'), false, name);
    assert.equal(text.includes('\uFFFD'), false, name);
  }
});
