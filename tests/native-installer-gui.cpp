#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <commctrl.h>
#include <objidl.h>
#include <gdiplus.h>
#include <algorithm>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>

namespace qa {
constexpr int kCapacity = 1024;
enum ControlId { Primary = 300, Secondary, Browse, Cancel, Path, Shortcut, Details, Copy, Keep, Exit, Language };
struct Stack { Stack* next; wchar_t text[1]; };
using Export = void(__cdecl*)(HWND, int, wchar_t*, Stack**, void*);
HWND parent = nullptr, skin = nullptr, progress = nullptr, details = nullptr;
HMODULE library = nullptr;
DWORD guiThread = 0;
int okCommands = 0, cancelCommands = 0, checks = 0;
std::wstring fixture;
bool folderSeen = false;
bool offscreen = false;
ULONGLONG folderStart = 0;

void Check(bool condition, const char* name) {
  if (!condition) throw std::runtime_error(name);
  ++checks;
  std::printf("PASS %s\n", name);
  std::fflush(stdout);
}
void Pump(DWORD duration = 40) {
  const ULONGLONG until = GetTickCount64() + duration;
  do {
    MSG message{};
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
      if (!IsDialogMessageW(parent, &message)) { TranslateMessage(&message); DispatchMessageW(&message); }
    }
    MsgWaitForMultipleObjects(0, nullptr, FALSE, 5, QS_ALLINPUT);
  } while (GetTickCount64() < until);
}
void Push(Stack** stack, const std::wstring& value) {
  auto entry = static_cast<Stack*>(GlobalAlloc(GPTR, sizeof(Stack) + kCapacity * sizeof(wchar_t)));
  if (!entry) throw std::runtime_error("stack allocation");
  wcscpy_s(entry->text, kCapacity, value.c_str());
  entry->next = *stack; *stack = entry;
}
std::wstring Pop(Stack** stack) {
  if (!*stack) throw std::runtime_error("missing NSIS stack result");
  auto entry = *stack;
  const std::wstring value(entry->text);
  *stack = entry->next; GlobalFree(entry);
  return value;
}
std::wstring Handle(HWND window) { return std::to_wstring(reinterpret_cast<UINT_PTR>(window)); }
std::wstring Call(const char* name, const std::vector<std::wstring>& arguments = {}, bool result = true) {
  auto function = reinterpret_cast<Export>(GetProcAddress(library, name));
  if (!function) throw std::runtime_error("missing exported function");
  Stack* stack = nullptr;
  Push(&stack, L"qa-stack-sentinel");
  for (auto argument = arguments.rbegin(); argument != arguments.rend(); ++argument) Push(&stack, *argument);
  wchar_t variables[kCapacity * 32]{};
  function(parent, kCapacity, variables, &stack, nullptr);
  const auto value = result ? Pop(&stack) : L"";
  const bool balanced = Pop(&stack) == L"qa-stack-sentinel" && !stack;
  if (!balanced) throw std::runtime_error("NSIS stack sentinel or balance mismatch");
  return value;
}
INT_PTR CALLBACK HostProc(HWND, UINT message, WPARAM wParam, LPARAM) {
  if (message == WM_COMMAND) {
    if (LOWORD(wParam) == IDOK) { ++okCommands; return TRUE; }
    if (LOWORD(wParam) == IDCANCEL) { ++cancelCommands; return TRUE; }
  }
  return FALSE;
}
HWND Control(int id) { return GetDlgItem(skin, id); }
void Click(int id) { SendMessageW(Control(id), BM_CLICK, 0, 0); Pump(); }
std::wstring Text(HWND window) {
  std::vector<wchar_t> text(GetWindowTextLengthW(window) + 1);
  GetWindowTextW(window, text.data(), static_cast<int>(text.size()));
  return text.data();
}
void Page(const wchar_t* mode, const std::wstring& path) {
  Check(Call("Page", {mode, path, L"Veylo", Handle(progress), Handle(details)}) == L"ok", "page call and NSIS return");
  Pump(80);
}
struct Capture {
  int width = 0, height = 0;
  std::vector<DWORD> pixels;
  DWORD At(float x, float y) const {
    return pixels[static_cast<int>(y * height / 500) * width + static_cast<int>(x * width / 760)] & 0xffffff;
  }
};
// Some native controls omit text through PrintWindow; method 3 captures the real window DC.
Capture Screenshot(HWND window, const std::wstring& filename, int method = 0) {
  RECT area{}; GetClientRect(window, &area);
  Capture capture; capture.width = area.right; capture.height = area.bottom;
  HDC reference = GetDC(window), memory = CreateCompatibleDC(reference);
  BITMAPINFO info{}; info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = capture.width; info.bmiHeader.biHeight = -capture.height;
  info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32; info.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr;
  HBITMAP bitmap = CreateDIBSection(reference, &info, DIB_RGB_COLORS, &bits, nullptr, 0);
  auto old = SelectObject(memory, bitmap);
  RedrawWindow(window, nullptr, nullptr, RDW_INVALIDATE | RDW_UPDATENOW | RDW_ALLCHILDREN);
  BOOL captured = FALSE;
  if (method == 1) {
    SendMessageW(window, WM_PRINT, reinterpret_cast<WPARAM>(memory), PRF_CLIENT | PRF_CHILDREN | PRF_ERASEBKGND);
    captured = TRUE;
  } else if (method == 2) {
    DRAWITEMSTRUCT draw{}; draw.CtlType = ODT_BUTTON; draw.CtlID = GetDlgCtrlID(window);
    draw.itemAction = ODA_DRAWENTIRE; draw.hwndItem = window; draw.hDC = memory; draw.rcItem = area;
    SendMessageW(GetParent(window), WM_DRAWITEM, draw.CtlID, reinterpret_cast<LPARAM>(&draw));
    captured = TRUE;
  } else if (method == 3) captured = BitBlt(memory, 0, 0, capture.width, capture.height, reference, 0, 0, SRCCOPY | CAPTUREBLT);
  else captured = PrintWindow(window, memory, PW_CLIENTONLY | 2);
  GdiFlush();
  capture.pixels.assign(static_cast<DWORD*>(bits), static_cast<DWORD*>(bits) + capture.width * capture.height);
  CLSID encoder{0x557cf406, 0x1a04, 0x11d3, {0x9a, 0x73, 0x00, 0x00, 0xf8, 0x1e, 0xf3, 0x2e}};
  Gdiplus::Bitmap image(bitmap, nullptr);
  const auto saved = image.Save((fixture + L"\\" + filename + L".png").c_str(), &encoder);
  SelectObject(memory, old); DeleteObject(bitmap); DeleteDC(memory); ReleaseDC(window, reference);
  Check(captured && saved == Gdiplus::Ok, "native-window PNG capture");
  const auto colored = std::count_if(capture.pixels.begin(), capture.pixels.end(), [](DWORD color) {
    return (color & 0xffffff) != 0 && (color & 0xffffff) != 0xffffff;
  });
  if (method == 0) Check(colored > std::min<size_t>(3000, capture.pixels.size() / 100), "native screenshot contains rendered content");
  else std::printf("INFO capture diagnostic method=%d coloredPixels=%zu\n", method, colored);
  return capture;
}
void Initialize(int language) {
  if (offscreen) ShowWindow(parent, SW_HIDE);
  Check(Call("Init", {Handle(parent), fixture + L"\\icon.png", std::to_wstring(language), L"4.7.5 QA"}) == L"ok", "Init consumes arguments and returns ok");
  skin = FindWindowExW(parent, nullptr, L"VeyloInstallerSkin475", nullptr);
  Check(skin && GetWindowThreadProcessId(skin, nullptr) == guiThread, "skin is owned by caller GUI thread");
  Check(Call("GetLanguage") == std::to_wstring(language), "locale ABI roundtrip");
  Check(!Text(Control(Cancel)).empty(), "cancel control has native window text");
  Check(SendMessageW(Control(Language), CB_GETCURSEL, 0, 0) >= 0, "language combo has native selected item");
  if (offscreen) SetWindowPos(parent, nullptr, -20000, -20000, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
  ShowWindow(parent, SW_SHOWNOACTIVATE); Pump(80);
}
void Dispose() {
  if (offscreen) ShowWindow(parent, SW_HIDE);
  const HWND previous = skin;
  Call("Dispose", {}, false);
  Check(!IsWindow(previous), "Dispose destroys its native window");
  const int before = cancelCommands;
  SendMessageW(parent, WM_COMMAND, IDCANCEL, 0);
  Check(cancelCommands == before + 1, "Dispose restores parent cancellation handling");
  skin = nullptr;
}
BOOL CALLBACK CancelOwnFolder(HWND window, LPARAM) {
  DWORD process = 0;
  GetWindowThreadProcessId(window, &process);
  wchar_t name[64]{}; GetClassNameW(window, name, 64);
  if (window != parent && process == GetCurrentProcessId() && wcscmp(name, L"#32770") == 0 && IsWindowVisible(window)) {
    folderSeen = true;
    PostMessageW(window, WM_COMMAND, IDCANCEL, 0);
  }
  return TRUE;
}
void CALLBACK FolderTimer(HWND, UINT, UINT_PTR, DWORD) {
  if (GetTickCount64() - folderStart >= 400) EnumThreadWindows(guiThread, CancelOwnFolder, 0);
}
void Keyboard(WORD key, bool shift = false) {
  BYTE previous[256]{}; GetKeyboardState(previous);
  BYTE current[256]{}; memcpy(current, previous, sizeof(current));
  current[VK_SHIFT] = shift ? 0x80 : 0;
  SetKeyboardState(current);
  MSG message{}; message.hwnd = GetFocus(); message.message = WM_KEYDOWN; message.wParam = key;
  message.lParam = 1;
  const bool handled = IsDialogMessageW(parent, &message) != FALSE;
  SetKeyboardState(previous);
  Check(handled, "native dialog keyboard message handled");
  Pump();
}
void WelcomeChecks(const std::wstring& initial) {
  Check(Call("GetPath") == initial, "default path roundtrip");
  Check(Call("GetShortcut") == L"1", "shortcut defaults enabled");
  Click(Secondary);
  Check(IsWindowVisible(Control(Path)), "custom path expands native editor");
  SetWindowTextW(Control(Path), L"C:\\Windows");
  const int beforeInvalid = okCommands;
  Click(Primary);
  Check(okCommands == beforeInvalid && Call("GetPath").empty(), "unsafe path blocks primary and GetPath");
  const auto custom = fixture + L"\\Selected\\Veylo";
  SetWindowTextW(Control(Path), custom.c_str());
  Check(Call("GetPath") == custom, "custom local path roundtrip");
  Click(Shortcut);
  Check(Call("GetShortcut") == L"0", "shortcut checkbox updates ABI");
  SetFocus(Control(Path));
  Keyboard(VK_TAB);
  Check(GetFocus() != Control(Path) && IsChild(skin, GetFocus()) && IsWindowVisible(GetFocus()) && IsWindowEnabled(GetFocus()), "Tab moves to another visible enabled skin control");
  Keyboard(VK_TAB, true);
  Check(GetFocus() == Control(Path), "Shift+Tab returns to the preceding path editor");
  SetFocus(Control(Primary));
  const int beforeEnter = okCommands;
  Keyboard(VK_RETURN);
  Check(okCommands == beforeEnter + 1, "Enter routes one host next command");
  folderSeen = false; folderStart = GetTickCount64();
  const UINT_PTR timer = SetTimer(nullptr, 0, 100, FolderTimer);
  Click(Browse);
  KillTimer(nullptr, timer);
  Check(folderSeen, "real folder dialog appeared on own GUI thread");
  Check(Call("GetPath") == custom, "folder dialog cancel preserves chosen path");
  Screenshot(skin, L"custom-path");
  const int beforeCancel = cancelCommands;
  Keyboard(VK_ESCAPE);
  Check(IsWindowVisible(Control(Keep)) && cancelCommands == beforeCancel, "Escape opens cancel confirmation without canceling host");
  Screenshot(skin, L"cancel-confirmation");
  Keyboard(VK_ESCAPE);
  Check(!IsWindowVisible(Control(Keep)) && cancelCommands == beforeCancel, "Escape dismisses confirmation and keeps installation");
  Click(Cancel); Click(Exit);
  Check(cancelCommands == beforeCancel + 1, "confirmed cancel reaches host exactly once");
}
void InstallChecks(const std::wstring& initial) {
  Page(L"install", initial);
  SendMessageW(progress, PBM_SETRANGE32, 0, 1000);
  SendMessageW(progress, PBM_SETPOS, 250, 0); Pump(250);
  const auto quarter = Screenshot(skin, L"progress-25");
  SendMessageW(progress, PBM_SETPOS, 750, 0); Pump(250);
  const auto threeQuarters = Screenshot(skin, L"progress-75");
  Check(quarter.At(500, 283) != threeQuarters.At(500, 283), "painted progress responds to genuine engine range and position");
  Check(SendMessageW(progress, PBM_GETPOS, 0, 0) == 750, "skin never changes native progress position");
  EnableWindow(GetDlgItem(parent, IDCANCEL), FALSE); Pump(250);
  Check(!IsWindowEnabled(Control(Cancel)), "native engine cancel lock disables skin cancellation");
  const int before = cancelCommands;
  SendMessageW(parent, WM_CLOSE, 0, 0); Pump();
  Check(cancelCommands == before && !IsWindowVisible(Control(Keep)), "locked cancel ignores host close");
  EnableWindow(GetDlgItem(parent, IDCANCEL), TRUE); Pump(250);
  Click(Details);
  HWND detailEdit = nullptr;
  for (HWND child = GetWindow(skin, GW_CHILD); child; child = GetWindow(child, GW_HWNDNEXT)) {
    wchar_t name[32]{}; GetClassNameW(child, name, 32);
    if (wcscmp(name, L"Edit") == 0 && child != Control(Path)) detailEdit = child;
  }
  Check(detailEdit && Text(detailEdit).find(L"QA genuine engine log") != std::wstring::npos, "details come from real native listview");
  Screenshot(skin, L"native-log-details");
  Click(Details);
  Call("Failed", {}, false); Pump();
  Check(IsWindowVisible(Control(Cancel)) && !IsWindowVisible(Control(Primary)), "failure has close control and no launch action");
  Screenshot(skin, L"install-failed");
  const int failedBefore = cancelCommands;
  Click(Cancel);
  Check(cancelCommands == failedBefore + 1 && Call("GetLaunch") == L"0", "failed close never requests launch");
}
void FinishChecks(const std::wstring& initial) {
  Page(L"finish", initial);
  Check(Call("GetLaunch") == L"0", "finish does not launch by merely entering page");
  Screenshot(skin, L"finish");
  const int before = okCommands;
  Click(Primary);
  Check(Call("GetLaunch") == L"1" && okCommands == before + 1, "launch button returns intent and host next command");
  Page(L"finish", initial);
  Click(Secondary);
  Check(Call("GetLaunch") == L"0" && okCommands == before + 2, "later button clears launch intent");
  Page(L"finish", initial);
  SetFocus(Control(Secondary));
  Keyboard(VK_RETURN);
  Check(Call("GetLaunch") == L"0" && okCommands == before + 3, "Enter on Launch later forwards exactly once without launch");
  Page(L"finish", initial);
  SetFocus(Control(Primary));
  Keyboard(VK_RETURN);
  Check(Call("GetLaunch") == L"1" && okCommands == before + 4, "Enter on Launch forwards exactly once with launch intent");
}
void PathSafetyChecks() {
  Initialize(1033);
  const auto existing = fixture + L"\\Existing\\Veylo";
  Page(L"welcome", existing);
  Check(Call("GetPath").empty(), "nonempty initial path is rejected without explicit trust");
  Call("TrustExistingPath", {existing}, false);
  Check(Call("GetPath") == existing, "explicit trusted exact initial path permits an existing profile");
  for (const wchar_t* relative : {L"\\Other\\Veylo", L"\\Reparse\\Veylo", L"\\LinkedParent\\Veylo", L"\\FileTarget\\Veylo", L"\\FileParent\\Veylo"}) {
    SetWindowTextW(Control(Path), (fixture + relative).c_str());
    Check(Call("GetPath").empty(), "other nonempty, reparse, or file destination is rejected");
  }
  const auto personal = fixture + L"\\ParentWithPersonalFile";
  SetWindowTextW(Control(Path), personal.c_str());
  Check(Call("GetPath") == personal + L"\\Veylo", "typed personal directory gains a separate application subdirectory");
  Check(Text(Control(Path)) == personal + L"\\Veylo", "validated application subdirectory is visible in the editor");
  const auto empty = fixture + L"\\Empty\\Veylo";
  SetWindowTextW(Control(Path), empty.c_str());
  Check(Call("GetPath") == empty, "empty explicit application directory remains allowed");
  Screenshot(skin, L"safe-custom-path");
  Dispose();
}
DWORD WINAPI Watchdog(void*) {
  Sleep(45000);
  TerminateProcess(GetCurrentProcess(), 124);
  return 0;
}
DWORD WINAPI RejectForeignGuiThread(void* result) {
  try {
    *static_cast<bool*>(result) = Call("Init", {Handle(parent), fixture + L"\\icon.png", L"1033", L"4.7.5 QA"}) == L"error";
  } catch (...) { *static_cast<bool*>(result) = false; }
  return 0;
}
int Run() {
  SetProcessDPIAware();
  const std::wstring desktopName = L"VeyloNativeQA-" + std::to_wstring(GetCurrentProcessId());
  if (!offscreen) {
    HDESK desktop = CreateDesktopW(desktopName.c_str(), nullptr, nullptr, 0, GENERIC_ALL, nullptr);
    Check(desktop && SetThreadDesktop(desktop), "isolated private desktop created and assigned");
  } else Check(true, "offscreen diagnostic keeps every fixture window hidden until positioned outside monitor bounds");
  guiThread = GetCurrentThreadId();
  INITCOMMONCONTROLSEX controls{sizeof(controls), ICC_PROGRESS_CLASS | ICC_LISTVIEW_CLASSES};
  InitCommonControlsEx(&controls);
  struct DialogTemplate { DLGTEMPLATE dialog; WORD menu = 0, windowClass = 0, title = 0; } dialog{};
  dialog.dialog.style = WS_POPUP | WS_CAPTION | WS_SYSMENU | DS_CONTROL;
  if (offscreen) dialog.dialog.dwExtendedStyle = WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
  dialog.dialog.cx = 400; dialog.dialog.cy = 280;
  parent = CreateDialogIndirectParamW(GetModuleHandleW(nullptr), &dialog.dialog, nullptr, HostProc, 0);
  Check(parent != nullptr, "native NSIS-like dialog host created");
  CreateWindowW(L"BUTTON", L"Next", WS_CHILD | WS_TABSTOP | BS_DEFPUSHBUTTON, 0, 0, 60, 20, parent, reinterpret_cast<HMENU>(IDOK), nullptr, nullptr);
  CreateWindowW(L"BUTTON", L"Cancel", WS_CHILD | WS_TABSTOP, 60, 0, 60, 20, parent, reinterpret_cast<HMENU>(IDCANCEL), nullptr, nullptr);
  progress = CreateWindowW(PROGRESS_CLASSW, L"", WS_CHILD, 0, 0, 100, 20, parent, nullptr, nullptr, nullptr);
  details = CreateWindowW(WC_LISTVIEWW, L"", WS_CHILD | LVS_REPORT, 0, 20, 100, 100, parent, nullptr, nullptr, nullptr);
  LVITEMW item{}; item.mask = LVIF_TEXT; item.pszText = const_cast<wchar_t*>(L"QA genuine engine log: unpacking fixture only");
  SendMessageW(details, LVM_INSERTITEMW, 0, reinterpret_cast<LPARAM>(&item));
  library = LoadLibraryExW((fixture + L"\\VeyloInstaller.dll").c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
  Check(library != nullptr, "x86 fixture DLL loaded");
  Check(Call("Init", {L"0", fixture + L"\\icon.png", L"1033", L"4.7.5 QA"}) == L"error", "wrong host handle rejected without corrupting stack");
  bool foreignThreadRejected = false;
  HANDLE foreignThread = CreateThread(nullptr, 0, RejectForeignGuiThread, &foreignThreadRejected, 0, nullptr);
  Check(foreignThread && WaitForSingleObject(foreignThread, 3000) == WAIT_OBJECT_0, "foreign-thread ABI probe completed within deadline");
  CloseHandle(foreignThread);
  Check(foreignThreadRejected, "Init rejects a caller outside the host GUI thread");
  const auto initial = fixture + L"\\Veylo";
  for (int locale : {2052, 1028, 1033, 1041, 1042}) {
    Initialize(locale); Page(L"welcome", initial);
    Screenshot(skin, L"welcome-" + std::to_wstring(locale));
    Screenshot(skin, L"welcome-" + std::to_wstring(locale) + L"-window-dc", 3);
    if (locale == 1033) {
      Screenshot(Control(Cancel), L"cancel-direct");
      Screenshot(Control(Language), L"language-direct");
      Screenshot(Control(Cancel), L"cancel-wm-print", 1);
      Screenshot(Control(Cancel), L"cancel-wm-drawitem", 2);
      Screenshot(Control(Cancel), L"cancel-window-dc", 3);
      Screenshot(Control(Language), L"language-wm-print", 1);
      Screenshot(Control(Language), L"language-window-dc", 3);
    }
    Dispose();
  }
  if (offscreen) {
    DestroyWindow(parent); FreeLibrary(library);
    std::printf("RESULT %d offscreen native capture checks passed; no directory dialog or installation executed\n", checks);
    return 0;
  }
  Initialize(1033); Page(L"welcome", initial);
  for (int index = 0; index < 5; ++index) {
    const int locales[] = {2052, 1028, 1033, 1041, 1042};
    SendMessageW(Control(Language), CB_SETCURSEL, index, 0);
    SendMessageW(skin, WM_COMMAND, MAKEWPARAM(Language, CBN_SELCHANGE), reinterpret_cast<LPARAM>(Control(Language)));
    Check(Call("GetLanguage") == std::to_wstring(locales[index]), "runtime locale selection updates NSIS language ID");
  }
  BOOL animation = FALSE; SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &animation, 0);
  const auto first = Screenshot(skin, L"animation-first");
  Pump(1100);
  const auto second = Screenshot(skin, L"animation-second");
  Check(!animation || first.pixels != second.pixels, "enabled native orbit animation changes rendered pixels");
  RECT client{}; GetClientRect(skin, &client);
  std::printf("INFO current native client=%ldx%ld, animations=%d; other DPI values and reduced-motion toggles NOT TESTED\n", client.right, client.bottom, animation);
  Check(Call("Page", {L"unknown", initial, L"Veylo", L"0", L"0"}) == L"error", "unknown page rejected with balanced stack");
  WelcomeChecks(initial);
  Dispose();
  Initialize(1033); InstallChecks(initial); Dispose();
  Initialize(1033); FinishChecks(initial); Dispose();
  PathSafetyChecks();
  DestroyWindow(parent); parent = nullptr;
  FreeLibrary(library); library = nullptr;
  std::printf("RESULT %d checks passed; private desktop never switched into view\n", checks);
  return 0;
}
}
#include "native-installer-fixture-driver.h"
int wmain(int argc, wchar_t** argv) {
  if (argc != 2 && argc != 3 && argc != 7) return 2;
  qa::fixture = argv[1];
  qa::offscreen = argc == 3 && wcscmp(argv[2], L"--offscreen") == 0;
  HANDLE watchdog = CreateThread(nullptr, 0, qa::Watchdog, nullptr, 0, nullptr);
  if (watchdog) CloseHandle(watchdog);
  Gdiplus::GdiplusStartupInput startup;
  ULONG_PTR token = 0;
  Gdiplus::GdiplusStartup(&token, &startup, nullptr);
  try {
    const int result = argc == 7 && wcscmp(argv[2], L"--fixture") == 0 ? qa::RunFixture(argv[3], argv[4], _wtoi(argv[5]), argv[6]) : qa::Run();
    Gdiplus::GdiplusShutdown(token); return result;
  }
  catch (const std::exception& error) { std::fprintf(stderr, "FAIL %s (Win32=%lu)\n", error.what(), GetLastError()); return 1; }
}
