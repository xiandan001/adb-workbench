#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <commctrl.h>
#include <objidl.h>
#include <gdiplus.h>
#include <algorithm>
#include <cstdio>
#include <cstdlib>
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
uint64_t RegionHash(const Capture& capture, int left, int top, int width, int height) {
  uint64_t hash = 1469598103934665603ULL;
  for (int y = top; y < top + height; ++y) for (int x = left; x < left + width; ++x) {
    hash ^= capture.At(static_cast<float>(x), static_cast<float>(y)); hash *= 1099511628211ULL;
  }
  return hash;
}
int RegionInk(const Capture& capture, int left, int top, int width, int height) {
  int count = 0;
  for (int y = top; y < top + height; ++y) for (int x = left; x < left + width; ++x)
    if (capture.At(static_cast<float>(x), static_cast<float>(y)) != 0) ++count;
  return count;
}
// Method 3 captures the entire client DC, including all native siblings.
// Full-frame PrintWindow on an inactive desktop is not a reliable visual oracle.
Capture Screenshot(HWND window, const std::wstring& filename, int method = 0) {
  RECT area{}; GetClientRect(window, &area);
  Capture capture; capture.width = area.right; capture.height = area.bottom;
  HDC reference = GetDC(window), memory = CreateCompatibleDC(reference);
  BITMAPINFO info{}; info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = capture.width; info.bmiHeader.biHeight = -capture.height;
  info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32; info.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr;
  HBITMAP bitmap = CreateDIBSection(reference, &info, DIB_RGB_COLORS, &bits, nullptr, 0);
  memset(bits, 0, static_cast<size_t>(capture.width) * capture.height * sizeof(DWORD));
  auto old = SelectObject(memory, bitmap);
  RedrawWindow(window, nullptr, nullptr, RDW_INVALIDATE | RDW_UPDATENOW | RDW_ALLCHILDREN | RDW_FRAME);
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
std::string Utf8(const std::wstring& value) {
  const int size = WideCharToMultiByte(CP_UTF8, 0, value.c_str(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::string result(size, '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.c_str(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
  return result;
}
std::string Json(const std::wstring& value) {
  std::string output = "\"";
  for (unsigned char character : Utf8(value)) {
    if (character == '\\' || character == '"') output += '\\';
    if (character >= 32) output += static_cast<char>(character);
    else output += ' ';
  }
  return output + "\"";
}
void WriteEvidence(const std::wstring& name, const std::string& text) {
  std::string normalized = text;
  normalized.erase(std::remove(normalized.begin(), normalized.end(), '\r'), normalized.end());
  FILE* file = nullptr;
  if (_wfopen_s(&file, (fixture + L"\\" + name).c_str(), L"wb") || !file) throw std::runtime_error("open evidence file");
  const size_t written = fwrite(normalized.data(), 1, normalized.size(), file); fclose(file);
  if (written != normalized.size()) throw std::runtime_error("write evidence file");
}
BOOL CALLBACK CollectNative(HWND window, LPARAM pointer) {
  if (window != skin && !IsChild(skin, window)) reinterpret_cast<std::vector<HWND>*>(pointer)->push_back(window);
  return TRUE;
}
std::vector<HWND> NativeWindows() {
  std::vector<HWND> windows;
  EnumChildWindows(parent, CollectNative, reinterpret_cast<LPARAM>(&windows));
  return windows;
}
int VisibleNativeCount() {
  int count = 0;
  for (HWND window : NativeWindows()) if (IsWindowVisible(window)) ++count;
  return count;
}
bool ParentEvidence(const std::wstring& name, int* paintedProgress = nullptr) {
  const auto clientImage = Screenshot(parent, name + L"-parent-client-window-dc", 3);
  int accentSamples = 0;
  for (int x = 282; x < 728; ++x) if (clientImage.At(static_cast<float>(x) + 0.5f, 283) == 0x1dd5a2) ++accentSamples;
  const int drawnPercent = accentSamples * 100 / 446;
  if (paintedProgress) *paintedProgress = drawnPercent;
  const HMODULE user = GetModuleHandleW(L"user32.dll");
  auto getDpi = reinterpret_cast<UINT(WINAPI*)(HWND)>(GetProcAddress(user, "GetDpiForWindow"));
  auto getContext = reinterpret_cast<HANDLE(WINAPI*)(HWND)>(GetProcAddress(user, "GetWindowDpiAwarenessContext"));
  auto getAwareness = reinterpret_cast<int(WINAPI*)(HANDLE)>(GetProcAddress(user, "GetAwarenessFromDpiAwarenessContext"));
  const UINT dpi = getDpi ? getDpi(parent) : 0;
  const HANDLE context = getContext ? getContext(parent) : nullptr;
  const int awareness = getAwareness && context ? getAwareness(context) : -1;
  RECT client{}, outer{}; GetClientRect(parent, &client); GetWindowRect(parent, &outer);
  std::string json = "{\n  \"parentTitle\": " + Json(Text(parent)) + ",\n  \"targetWindowDpi\": " + std::to_string(dpi) +
    ",\n  \"targetAwareness\": " + std::to_string(awareness) + ",\n  \"targetDpiContext\": " + std::to_string(reinterpret_cast<INT_PTR>(context)) +
    ",\n  \"paintedProgressPercent\": " + std::to_string(drawnPercent) + ",\n  \"percentInkPixels\": " + std::to_string(RegionInk(clientImage, 654, 235, 74, 30)) +
    ",\n  \"activityHash\": " + std::to_string(RegionHash(clientImage, 282, 281, 446, 5)) +
    ",\n  \"elapsedStageHash\": " + std::to_string(RegionHash(clientImage, 282, 306, 446, 50)) +
    ",\n  \"clientSize\": [" + std::to_string(client.right) + "," + std::to_string(client.bottom) + "],\n  \"windowSize\": [" +
    std::to_string(outer.right - outer.left) + "," + std::to_string(outer.bottom - outer.top) + "],\n  \"nativeChildren\": [\n";
  int count = 0; bool first = true;
  for (HWND window : NativeWindows()) {
    wchar_t name[128]{}; GetClassNameW(window, name, 128);
    const HWND owner = GetParent(window);
    wchar_t ownerClass[128]{}; GetClassNameW(owner, ownerClass, 128);
    DWORD process = 0; const DWORD thread = GetWindowThreadProcessId(window, &process);
    RECT area{}; GetWindowRect(window, &area);
    const bool visible = IsWindowVisible(window) != FALSE;
    count += visible ? 1 : 0;
    if (!first) json += ",\n"; first = false;
    json += "    {\"hwnd\":" + std::to_string(reinterpret_cast<UINT_PTR>(window)) + ",\"id\":" + std::to_string(GetDlgCtrlID(window)) +
      ",\"parentHwnd\":" + std::to_string(reinterpret_cast<UINT_PTR>(owner)) + ",\"parentClass\":" + Json(ownerClass) +
      ",\"directChild\":" + (owner == parent ? "true" : "false") + ",\"threadId\":" + std::to_string(thread) + ",\"processId\":" + std::to_string(process) +
      ",\"windowProcedure\":" + std::to_string(static_cast<UINT_PTR>(GetWindowLongPtrW(window, GWLP_WNDPROC))) +
      ",\"class\":" + Json(name) + ",\"visible\":" + (visible ? "true" : "false") + ",\"styleVisible\":" +
      ((GetWindowLongW(window, GWL_STYLE) & WS_VISIBLE) ? "true" : "false") + ",\"enabled\":" + (IsWindowEnabled(window) ? "true" : "false") +
      ",\"rect\":[" + std::to_string(area.left) + "," + std::to_string(area.top) + "," + std::to_string(area.right) + "," + std::to_string(area.bottom) + "]}";
    if (json.back() == '}') json.pop_back();
    for (const wchar_t* property : {L"VeyloGuardCreated", L"VeyloGuardAtPage", L"VeyloGuardPos", L"VeyloGuardChanged", L"VeyloGuardShow", L"VeyloGuardShowStyle", L"VeyloGuardStyle", L"VeyloGuardFlags"})
      json += "," + Json(property) + ":" + std::to_string(reinterpret_cast<UINT_PTR>(GetPropW(window, property)));
    json += "}";
  }
  json += "\n  ],\n  \"visibleNativeCount\": " + std::to_string(count) + "\n}\n";
  WriteEvidence(name + L"-native-windows.json", json);
  std::printf("INFO whole-parent snapshot visible-native-count=%d\n", count);
  std::printf("INFO target window DPI=%u awareness=%d (0=unaware,1=system,2=per-monitor)\n", dpi, awareness);
  return count == 0;
}
std::wstring Version() {
  wchar_t value[64]{};
  return GetEnvironmentVariableW(L"VEYLO_QA_VERSION", value, 64) ? value : L"QA";
}
bool ArchiveFixture() {
  wchar_t value[32]{};
  return GetEnvironmentVariableW(L"VEYLO_QA_PAYLOAD_KIND", value, 32) && wcscmp(value, L"app-7z") == 0;
}
void Initialize(int language) {
  if (offscreen) ShowWindow(parent, SW_HIDE);
  Check(Call("Init", {Handle(parent), fixture + L"\\icon.png", std::to_wstring(language), Version()}) == L"ok", "Init consumes arguments and returns ok");
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
  Check(ParentEvidence(L"progress-25"), "whole parent exposes no native controls at 25 percent");
  SendMessageW(progress, PBM_SETPOS, 750, 0); Pump(250);
  const auto threeQuarters = Screenshot(skin, L"progress-75");
  Check(ParentEvidence(L"progress-75"), "whole parent exposes no native controls at 75 percent");
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
HWND DetailsEdit() {
  for (HWND child = GetWindow(skin, GW_CHILD); child; child = GetWindow(child, GW_HWNDNEXT)) {
    wchar_t name[32]{}; GetClassNameW(child, name, 32);
    if (_wcsicmp(name, L"EDIT") == 0 && child != Control(Path)) return child;
  }
  return nullptr;
}
struct CaptionMetrics { float naturalWidth = 0, availableWidth = 0; int fitted = 0, lines = 0; };
CaptionMetrics MeasureFooterCaption(HWND button) {
  RECT client{}, buttonArea{}; GetClientRect(skin, &client); GetClientRect(button, &buttonArea);
  const float scale = client.right / 760.0f;
  const auto caption = Text(button);
  CaptionMetrics result; result.availableWidth = buttonArea.right / scale - 12;
  HDC dc = GetDC(button);
  {
    Gdiplus::Graphics graphics(dc); graphics.ScaleTransform(scale, scale);
    graphics.SetTextRenderingHint(Gdiplus::TextRenderingHintClearTypeGridFit);
    Gdiplus::FontFamily family(L"Segoe UI");
    Gdiplus::Font font(&family, 12, Gdiplus::FontStyleRegular, Gdiplus::UnitPixel);
    Gdiplus::StringFormat format; format.SetTrimming(Gdiplus::StringTrimmingEllipsisCharacter);
    Gdiplus::RectF bounds{};
    graphics.MeasureString(caption.c_str(), -1, &font, Gdiplus::RectF(6, 6, result.availableWidth, 24), &format, &bounds, &result.fitted, &result.lines);
    format.SetFormatFlags(Gdiplus::StringFormatFlagsNoWrap); format.SetTrimming(Gdiplus::StringTrimmingNone);
    graphics.MeasureString(caption.c_str(), -1, &font, Gdiplus::PointF(0, 0), &format, &bounds);
    result.naturalWidth = bounds.Width;
  }
  ReleaseDC(button, dc); return result;
}
void FooterChecks(int locale, bool mirrorEngineCancel = false) {
  RECT reference{}, client{}; GetClientRect(skin, &client);
  GetWindowRect(Control(Details), &reference); MapWindowPoints(nullptr, skin, reinterpret_cast<POINT*>(&reference), 2);
  std::string records = "{\"locale\":" + std::to_string(locale) + ",\"buttons\":[";
  bool first = true;
  for (int id : {Details, Copy, Cancel}) {
    HWND button = Control(id); RECT area{}; GetWindowRect(button, &area);
    MapWindowPoints(nullptr, skin, reinterpret_cast<POINT*>(&area), 2);
    const bool expectedEnabled = id != Cancel || !mirrorEngineCancel || IsWindowEnabled(GetDlgItem(parent, IDCANCEL));
    Check(IsWindowVisible(button) && !!IsWindowEnabled(button) == expectedEnabled, "footer action visibility and enabled state match the engine contract");
    Check(area.top == reference.top && area.bottom - area.top == reference.bottom - reference.top, "all three footer actions have identical Y and height");
    Check(area.left >= 0 && area.right <= client.right && area.bottom <= client.bottom, "footer action remains inside client bounds");
    Check(!Text(button).empty(), "footer action has a localized caption");
    const auto caption = MeasureFooterCaption(button);
    std::printf("INFO footer locale=%d id=%d textWidth=%.2f available=%.2f fitted=%d lines=%d\n", locale, id, caption.naturalWidth, caption.availableWidth, caption.fitted, caption.lines);
    const bool fits = caption.lines == 1 && caption.fitted == static_cast<int>(Text(button).size()) && caption.naturalWidth <= caption.availableWidth;
    if (!fits) Screenshot(parent, L"footer-caption-overflow-" + std::to_wstring(locale), 3);
    Check(fits, "localized footer caption fits on one complete line without clipping or ellipsis");
    if (!first) records += ","; first = false;
    records += "{\"id\":" + std::to_string(id) + ",\"caption\":" + Json(Text(button)) + ",\"enabled\":" + (IsWindowEnabled(button) ? "true" : "false") + ",\"y\":" + std::to_string(area.top) + ",\"height\":" + std::to_string(area.bottom - area.top) + ",\"captionWidth\":" + std::to_string(caption.naturalWidth) + ",\"availableCaptionWidth\":" + std::to_string(caption.availableWidth) + ",\"captionLines\":" + std::to_string(caption.lines) + "}";
  }
  WriteEvidence(L"footer-" + std::to_wstring(locale) + L".json", records + "]}\n");
}
DWORD WINAPI ConfigureOnWorker(void* result) {
  try { Call("Stage", {L"configuring"}, false); *static_cast<bool*>(result) = true; }
  catch (...) { *static_cast<bool*>(result) = false; }
  return 0;
}
void BusyProgressChecks(const std::wstring& initial) {
  Initialize(1033);
  SendMessageW(details, LVM_DELETEALLITEMS, 0, 0);
  SendMessageW(progress, PBM_SETRANGE32, 0, 1000);
  SendMessageW(progress, PBM_SETPOS, 410, 0);
  Page(L"install", initial); Pump(250);
  const ULONGLONG holdStarted = GetTickCount64();
  const auto known = Screenshot(parent, L"stall41-known-parent", 3);
  Check(RegionInk(known, 654, 235, 74, 30) > 10, "fresh genuine 41-percent reading is shown before the stale threshold");
  while (GetTickCount64() - holdStarted < 2700) {
    Pump(100); Check(SendMessageW(progress, PBM_GETPOS, 0, 0) == 410, "native engine stays at exactly 41 percent");
  }
  const auto busy = Screenshot(parent, L"stall41-busy-parent", 3);
  Check(RegionInk(busy, 654, 235, 74, 30) == 0, "stale 41-percent label is hidden instead of fabricated or increased");
  while (GetTickCount64() - holdStarted < 5500) {
    Pump(100); Check(SendMessageW(progress, PBM_GETPOS, 0, 0) == 410, "native engine stays fixed throughout the long wait");
  }
  const auto later = Screenshot(parent, L"stall41-later-parent", 3);
  Check(RegionInk(later, 654, 235, 74, 30) == 0, "long busy wait still does not invent a percentage");
  Check(RegionHash(busy, 282, 306, 446, 50) != RegionHash(later, 282, 306, 446, 50), "actual elapsed/stage region updates independently of the orbit");
  BOOL animations = FALSE; SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &animations, 0);
  if (animations) Check(RegionHash(busy, 282, 281, 446, 5) != RegionHash(later, 282, 281, 446, 5), "busy activity bar changes independently of fixed engine progress");
  Check(ParentEvidence(L"stall41-final"), "long busy state never exposes native controls");
  Click(Details); Pump(600);
  const HWND edit = DetailsEdit();
  const auto startingDetails = Text(edit);
  Check(startingDetails.find(L"Preparing and deploying the app") != std::wstring::npos, "details contain the starting phase even when native logs are empty");
  Check(startingDetails.find(L"no per-file log") != std::wstring::npos, "details explain absent raw engine logs honestly");
  bool configured = false;
  HANDLE worker = CreateThread(nullptr, 0, ConfigureOnWorker, &configured, 0, nullptr);
  Check(worker && WaitForSingleObject(worker, 1500) == WAIT_OBJECT_0, "worker Stage call completes without invoking GUI work inline");
  CloseHandle(worker); Pump(800);
  const auto configuredDetails = Text(edit);
  Check(configured && configuredDetails.find(L"Finishing installation settings") != std::wstring::npos && configuredDetails != startingDetails,
    "visible details update to the next phase without closing and reopening");
  SendMessageW(edit, EM_SETSEL, 0, 5);
  const auto selected = Text(edit);
  LVITEMW row{}; row.mask = LVIF_TEXT; row.pszText = const_cast<wchar_t*>(L"QA log appended while text is selected");
  SendMessageW(details, LVM_INSERTITEMW, 0, reinterpret_cast<LPARAM>(&row)); Pump(700);
  Check(Text(edit) == selected, "automatic detail refresh preserves an active text selection");
  SendMessageW(edit, EM_SETSEL, -1, -1); Pump(700);
  Check(Text(edit).find(row.pszText) != std::wstring::npos, "details catch up after the text selection is cleared");
  FooterChecks(1033);
  WriteEvidence(L"stall41-summary.json", "{\"heldMilliseconds\":" + std::to_string(GetTickCount64() - holdStarted) + ",\"nativePosition\":410,\"nativeMaximum\":1000,\"percentFabricated\":false,\"elapsedUpdated\":true,\"liveDetails\":true,\"result\":\"passed\"}\n");
  Screenshot(parent, L"live-details-parent", 3);
  Check(Call("Page", {L"install", initial, L"Veylo", L"0", Handle(details)}) == L"ok", "unknown native progress is accepted as an unquantified stage");
  Pump(300);
  const auto unknown = Screenshot(parent, L"unknown-progress-parent", 3);
  Check(RegionInk(unknown, 654, 235, 74, 30) == 0, "unknown progress never displays a fabricated percentage");
  Click(Details); Pump(600);
  Check(Text(DetailsEdit()).find(L"No measurable engine progress") != std::wstring::npos, "details explicitly explain unavailable engine progress");
  SendMessageW(progress, PBM_SETPOS, 1000, 0);
  Page(L"install", initial); Pump(250);
  const auto stepComplete = Screenshot(parent, L"engine-step-complete-parent", 3);
  Check(RegionInk(stepComplete, 654, 235, 74, 30) == 0, "an in-flight engine step at maximum cannot claim overall 100-percent completion");
  Check(SendMessageW(progress, PBM_GETPOS, 0, 0) == 1000, "waiting at engine maximum never rewrites its native position");
  SendMessageW(progress, PBM_SETPOS, 560, 0); Pump(250);
  int resumedPercent = -1;
  Check(ParentEvidence(L"engine-next-step-56", &resumedPercent), "a later engine step remains free of native overlays");
  Check(std::abs(resumedPercent - 56) <= 2, "a real next-step 56-percent reading replaces waiting without fake monotonic progress");
  Dispose();
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
void CheckNativeClipped(HWND window, const char* message) {
  HRGN region = CreateRectRgn(0, 0, 0, 0);
  const int type = GetWindowRgn(window, region);
  DeleteObject(region);
  Check(type == NULLREGION, message);
}
void NativeLifecycleChecks(const std::wstring& initial) {
  HRGN expectedRegion = CreateRectRgn(0, 0, 80, 20);
  HRGN originalRegion = CreateRectRgn(0, 0, 80, 20);
  Check(SetWindowRgn(progress, originalRegion, FALSE) != 0, "fixture native progress starts with a restorable custom region");
  Initialize(1033); Page(L"install", initial);
  SendMessageW(parent, WM_NEXTDLGCTL, reinterpret_cast<WPARAM>(progress), TRUE);
  Check(IsChild(skin, GetFocus()) && IsWindowVisible(GetFocus()) && IsWindowEnabled(GetFocus()), "engine native focus request redirects to a visible enabled skin control");
  ShowWindow(progress, SW_SHOWNA);
  CheckNativeClipped(progress, "late native progress cannot draw even before queued visibility correction");
  Pump();
  Check(ParentEvidence(L"late-show-progress"), "late ShowWindow cannot expose native progress");
  SetWindowPos(details, HWND_TOP, 30, 80, 650, 80, SWP_SHOWWINDOW | SWP_NOACTIVATE); Pump();
  Check(ParentEvidence(L"late-position-native"), "late SetWindowPos cannot expose or cover skin with native controls");
  SetWindowPos(details, HWND_TOP, 30, 80, 650, 80, SWP_SHOWWINDOW | SWP_NOACTIVATE | SWP_NOSENDCHANGING);
  CheckNativeClipped(details, "native show with SWP_NOSENDCHANGING cannot paint before message dispatch");
  Pump();
  Check(!IsWindowVisible(details), "native show with SWP_NOSENDCHANGING is hidden after queued correction");
  SetWindowLongW(progress, GWL_STYLE, GetWindowLongW(progress, GWL_STYLE) | WS_VISIBLE); Pump();
  Check(ParentEvidence(L"late-style-native"), "late visible style cannot expose native progress");
  HWND page = CreateWindowW(L"STATIC", L"Native page created after plugin initialization", WS_CHILD | WS_VISIBLE | WS_TABSTOP,
    20, 100, 700, 200, parent, reinterpret_cast<HMENU>(1998), nullptr, nullptr);
  HWND childProgress = CreateWindowW(PROGRESS_CLASSW, L"", WS_CHILD | WS_VISIBLE, 0, 20, 650, 30, page, reinterpret_cast<HMENU>(1999), nullptr, nullptr);
  SetWindowPos(page, HWND_TOP, 20, 100, 700, 200, SWP_SHOWWINDOW | SWP_NOACTIVATE); Pump();
  Check(ParentEvidence(L"late-created-native-page"), "new native page and its progress stay hidden");
  HWND direct = CreateWindowW(PROGRESS_CLASSW, L"", WS_CHILD | WS_VISIBLE, 0, 0, 600, 60, parent, reinterpret_cast<HMENU>(1997), nullptr, nullptr);
  Pump();
  Check(ParentEvidence(L"late-created-direct-progress"), "new direct native progress cannot cover skin");
  const HWND previousDirect = direct;
  DestroyWindow(direct);
  direct = CreateWindowW(PROGRESS_CLASSW, L"", WS_CHILD | WS_VISIBLE, 0, 0, 600, 60, parent, reinterpret_cast<HMENU>(1997), nullptr, nullptr);
  Pump();
  std::printf("INFO replacement native HWND old=%u new=%u sameHandle=%d\n", static_cast<unsigned>(reinterpret_cast<UINT_PTR>(previousDirect)), static_cast<unsigned>(reinterpret_cast<UINT_PTR>(direct)), previousDirect == direct);
  Check(ParentEvidence(L"recreated-native-progress"), "destroyed native control can be replaced with the same ID without exposing it");
  struct NativeDialogTemplate { DLGTEMPLATE dialog; WORD menu = 0, windowClass = 0, title = 0; } nativeTemplate{};
  nativeTemplate.dialog.style = WS_CHILD | DS_CONTROL;
  nativeTemplate.dialog.dwExtendedStyle = WS_EX_NOPARENTNOTIFY | WS_EX_CONTROLPARENT;
  nativeTemplate.dialog.cx = 300; nativeTemplate.dialog.cy = 120;
  HWND nativeDialog = CreateDialogIndirectParamW(GetModuleHandleW(nullptr), &nativeTemplate.dialog, parent, HostProc, 0);
  Check(nativeDialog != nullptr, "real native dialog page without parent notification was created");
  CreateWindowW(PROGRESS_CLASSW, L"", WS_CHILD | WS_VISIBLE, 0, 20, 300, 30, nativeDialog, reinterpret_cast<HMENU>(1004), nullptr, nullptr);
  Page(L"install", initial);
  ShowWindow(nativeDialog, SW_SHOWNA);
  CheckNativeClipped(nativeDialog, "native dialog SW_SHOWNA cannot paint before queued correction");
  Pump();
  Check(!IsWindowVisible(nativeDialog), "native dialog SW_SHOWNA is hidden after queued correction");
  Check(ParentEvidence(L"late-native-dialog"), "whole parent contains no late native dialog or its progress bar");
  Check(IsWindow(childProgress) && IsWindowEnabled(childProgress), "native progress still exists and remains enabled for the engine");
  Dispose();
  Check(IsWindowVisible(page) && IsWindowVisible(direct) && IsWindowVisible(progress), "Dispose restores the last requested visible state before another ShowWindow call");
  Check(IsWindowVisible(nativeDialog), "Dispose restores the native dialog's last show request");
  Check((GetWindowLongW(page, GWL_STYLE) & WS_TABSTOP) != 0 && (GetWindowLongW(nativeDialog, GWL_EXSTYLE) & WS_EX_CONTROLPARENT) != 0, "Dispose restores original native navigation styles");
  HRGN restoredRegion = CreateRectRgn(0, 0, 0, 0);
  Check(GetWindowRgn(progress, restoredRegion) != ERROR && EqualRgn(expectedRegion, restoredRegion), "Dispose restores the original native clipping region");
  DeleteObject(expectedRegion); DeleteObject(restoredRegion); SetWindowRgn(progress, nullptr, FALSE);
  ShowWindow(page, SW_SHOWNA); ShowWindow(direct, SW_SHOWNA); Pump();
  Check(IsWindowVisible(page) && IsWindowVisible(direct), "Dispose restores native windows' normal show behavior");
  DestroyWindow(page); DestroyWindow(direct); DestroyWindow(nativeDialog);
  ShowWindow(progress, SW_HIDE); ShowWindow(details, SW_HIDE);
}
DWORD WINAPI Watchdog(void*) {
  Sleep(ArchiveFixture() ? 180000 : 45000);
  TerminateProcess(GetCurrentProcess(), 124);
  return 0;
}
DWORD WINAPI RejectForeignGuiThread(void* result) {
  try {
    *static_cast<bool*>(result) = Call("Init", {Handle(parent), fixture + L"\\icon.png", L"1033", Version()}) == L"error";
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
  Check(Call("Init", {L"0", fixture + L"\\icon.png", L"1033", Version()}) == L"error", "wrong host handle rejected without corrupting stack");
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
    Check(ParentEvidence(L"welcome-" + std::to_wstring(locale)), "whole welcome parent contains no visible native siblings");
    if (locale == 1033) {
      Screenshot(Control(Cancel), L"cancel-direct");
      Screenshot(Control(Language), L"language-direct");
      Screenshot(Control(Cancel), L"cancel-wm-print", 1);
      Screenshot(Control(Cancel), L"cancel-wm-drawitem", 2);
      Screenshot(Control(Cancel), L"cancel-window-dc", 3);
      Screenshot(Control(Language), L"language-wm-print", 1);
      Screenshot(Control(Language), L"language-window-dc", 3);
    }
    Page(L"install", initial); Click(Details); Pump(100);
    FooterChecks(locale);
    Check(ParentEvidence(L"footer-" + std::to_wstring(locale)), "localized footer and details do not expose original NSIS controls");
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
  NativeLifecycleChecks(initial);
  BusyProgressChecks(initial);
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
