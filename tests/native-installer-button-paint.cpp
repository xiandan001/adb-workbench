#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <commctrl.h>
#include <algorithm>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
constexpr int kCapacity = 1024, kCancel = 303;
struct Stack { Stack* next; wchar_t text[1]; };
using Export = void(__cdecl*)(HWND, int, wchar_t*, Stack**, void*);
struct Pixels { int black = 0, white = 0, ink = 0, total = 0; };
struct Stage { const char* name; int draws = 0; UINT state = 0; Pixels drawn{}, retained{}; };
HWND parent = nullptr, skin = nullptr, cancel = nullptr;
HMODULE library = nullptr;
Stage* current = nullptr;
std::wstring Handle(HWND window) { return std::to_wstring(reinterpret_cast<UINT_PTR>(window)); }
void Push(Stack** stack, const std::wstring& value) {
  auto* entry = static_cast<Stack*>(GlobalAlloc(GPTR, sizeof(Stack) + kCapacity * sizeof(wchar_t)));
  if (!entry) throw std::runtime_error("stack allocation failed");
  wcscpy_s(entry->text, kCapacity, value.c_str()); entry->next = *stack; *stack = entry;
}
std::wstring Pop(Stack** stack) {
  if (!*stack) throw std::runtime_error("missing DLL result");
  auto* entry = *stack; const std::wstring result(entry->text); *stack = entry->next; GlobalFree(entry); return result;
}
std::wstring Call(const char* name, const std::vector<std::wstring>& args = {}, bool returns = true) {
  auto function = reinterpret_cast<Export>(GetProcAddress(library, name));
  if (!function) throw std::runtime_error("missing DLL export");
  Stack* stack = nullptr; Push(&stack, L"owned-paint-sentinel");
  for (auto it = args.rbegin(); it != args.rend(); ++it) Push(&stack, *it);
  wchar_t variables[kCapacity * 32]{}; function(parent, kCapacity, variables, &stack, nullptr);
  const auto result = returns ? Pop(&stack) : L"";
  if (Pop(&stack) != L"owned-paint-sentinel" || stack) throw std::runtime_error("DLL stack mismatch");
  return result;
}
void Pump(DWORD duration) {
  const auto until = GetTickCount64() + duration;
  do {
    MSG message{};
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&message); DispatchMessageW(&message); }
    MsgWaitForMultipleObjects(0, nullptr, FALSE, 5, QS_ALLINPUT);
  } while (GetTickCount64() < until);
}
Pixels Sample(HDC dc, int width, int height) {
  Pixels result;
  HDC memory = CreateCompatibleDC(dc);
  BITMAPINFO info{}; info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = width; info.bmiHeader.biHeight = -height;
  info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32; info.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr; HBITMAP bitmap = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &bits, nullptr, 0);
  if (!memory || !bitmap) { if (memory) DeleteDC(memory); if (bitmap) DeleteObject(bitmap); return result; }
  auto old = SelectObject(memory, bitmap);
  const bool copied = BitBlt(memory, 0, 0, width, height, dc, 0, 0, SRCCOPY) != FALSE; GdiFlush();
  for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x) {
    if (!copied) continue;
    const DWORD pixel = static_cast<DWORD*>(bits)[y * width + x];
    const int r = (pixel >> 16) & 255, g = (pixel >> 8) & 255, b = pixel & 255; ++result.total;
    if (r < 16 && g < 16 && b < 16) ++result.black;
    else if (r >= 238 && g >= 238 && b >= 238) ++result.white;
    else if (std::max({r, g, b}) >= 50) ++result.ink;
  }
  SelectObject(memory, old); DeleteObject(bitmap); DeleteDC(memory);
  return result;
}
LRESULT CALLBACK Observe(HWND window, UINT message, WPARAM wParam, LPARAM lParam, UINT_PTR, DWORD_PTR) {
  const auto result = DefSubclassProc(window, message, wParam, lParam);
  if (current && message == WM_DRAWITEM && lParam) {
    const auto& item = *reinterpret_cast<DRAWITEMSTRUCT*>(lParam);
    if (item.hwndItem == cancel) {
      ++current->draws; current->state = item.itemState;
      current->drawn = Sample(item.hDC, item.rcItem.right - item.rcItem.left, item.rcItem.bottom - item.rcItem.top);
    }
  }
  return result;
}
void ReadRetained(Stage& stage) {
  RECT area{}; GetClientRect(cancel, &area); HDC dc = GetDC(cancel);
  if (dc) { stage.retained = Sample(dc, area.right, area.bottom); ReleaseDC(cancel, dc); }
}
INT_PTR CALLBACK HostProc(HWND, UINT, WPARAM, LPARAM) { return FALSE; }
#pragma pack(push, 2)
struct DialogTemplate { DLGTEMPLATE dialog; WORD menu = 0, cls = 0, title = 0; };
#pragma pack(pop)
void CreateHost(const std::wstring& icon, int locale) {
  DialogTemplate description{}; description.dialog.style = WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN;
  description.dialog.cx = 760; description.dialog.cy = 500;
  parent = CreateDialogIndirectParamW(GetModuleHandleW(nullptr), &description.dialog, nullptr, HostProc, 0);
  if (!parent) throw std::runtime_error("owned dialog creation failed");
  CreateWindowExW(0, L"BUTTON", L"engine cancel", WS_CHILD, 0, 0, 80, 25, parent, reinterpret_cast<HMENU>(IDCANCEL), nullptr, nullptr);
  HWND progress = CreateWindowExW(0, PROGRESS_CLASSW, L"", WS_CHILD, 0, 0, 100, 10, parent, nullptr, nullptr, nullptr);
  if (Call("Init", {Handle(parent), icon, std::to_wstring(locale), L"button paint fixture"}) != L"ok") throw std::runtime_error("DLL Init failed");
  for (HWND child = GetWindow(parent, GW_CHILD); child; child = GetWindow(child, GW_HWNDNEXT)) {
    wchar_t name[80]{}; GetClassNameW(child, name, 80); if (wcscmp(name, L"VeyloInstallerSkin475") == 0) skin = child;
  }
  cancel = GetDlgItem(skin, kCancel);
  if (!skin || !cancel || !SetWindowSubclass(skin, Observe, 4725, 0)) throw std::runtime_error("owned skin observer failed");
  if (Call("Page", {L"install", L"C:\\NeverInstalled\\Veylo", L"Veylo", Handle(progress), L"0"}) != L"ok") throw std::runtime_error("DLL Page failed");
}
void PrintPixels(const Pixels& value) { std::printf("{\"black\":%d,\"white\":%d,\"ink\":%d,\"total\":%d}", value.black, value.white, value.ink, value.total); }
void PrintStage(const Stage& value) {
  std::printf("{\"name\":\"%s\",\"naturalDraws\":%d,\"itemState\":%u,\"drawHdc\":", value.name, value.draws, value.state);
  PrintPixels(value.drawn); std::printf(",\"retainedClient\":"); PrintPixels(value.retained); std::printf("}");
}
void ProbeBackground(int& brushColor, int& erasedColor, LRESULT& erased) {
  HDC reference = GetDC(cancel), memory = CreateCompatibleDC(reference);
  HBITMAP bitmap = CreateCompatibleBitmap(reference, 100, 32); auto old = SelectObject(memory, bitmap);
  HBRUSH brush = reinterpret_cast<HBRUSH>(SendMessageW(skin, WM_CTLCOLORBTN, reinterpret_cast<WPARAM>(memory), reinterpret_cast<LPARAM>(cancel)));
  LOGBRUSH object{}; brushColor = GetObjectW(brush, sizeof(object), &object) == sizeof(object) ? static_cast<int>(object.lbColor) : -1;
  RECT area{0, 0, 100, 32}; HBRUSH sentinel = CreateSolidBrush(RGB(255, 0, 255)); FillRect(memory, &area, sentinel); DeleteObject(sentinel);
  erased = SendMessageW(cancel, WM_ERASEBKGND, reinterpret_cast<WPARAM>(memory), 0);
  erasedColor = static_cast<int>(GetPixel(memory, 20, 20));
  SelectObject(memory, old); DeleteObject(bitmap); DeleteDC(memory); ReleaseDC(cancel, reference);
}
}
int wmain(int argc, wchar_t** argv) {
  HDESK original = nullptr, owned = nullptr;
  try {
    if (argc != 3) return 2;
    const std::wstring root(argv[1]), dll = root + L"\\VeyloInstaller.dll", icon = root + L"\\icon.png";
    if (root.find(L"veylo-button-paint-test-") == std::wstring::npos) return 2;
    auto aware = reinterpret_cast<BOOL(WINAPI*)(HANDLE)>(GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetProcessDpiAwarenessContext"));
    if (aware) aware(reinterpret_cast<HANDLE>(-4));
    original = GetThreadDesktop(GetCurrentThreadId());
    const std::wstring desktop = L"VeyloButtonPaint-" + std::to_wstring(GetCurrentProcessId());
    owned = CreateDesktopW(desktop.c_str(), nullptr, nullptr, 0, GENERIC_ALL, nullptr);
    if (!owned || !SetThreadDesktop(owned)) throw std::runtime_error("private desktop failed");
    INITCOMMONCONTROLSEX controls{sizeof(controls), ICC_STANDARD_CLASSES | ICC_PROGRESS_CLASS}; InitCommonControlsEx(&controls);
    library = LoadLibraryExW(dll.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH); if (!library) throw std::runtime_error("owned DLL load failed");
    const int locale = _wtoi(argv[2]); CreateHost(icon, locale);
    Stage first{"initial"}, disabled{"disabled"}, restored{"restored"}; current = &first;
    ShowWindow(parent, SW_SHOWNOACTIVATE); Pump(100); ReadRetained(first);
    current = &disabled; EnableWindow(GetDlgItem(parent, IDCANCEL), FALSE); Pump(260); ReadRetained(disabled);
    const bool disabledState = !IsWindowEnabled(cancel);
    current = &restored; EnableWindow(GetDlgItem(parent, IDCANCEL), TRUE); Pump(260); ReadRetained(restored);
    const bool restoredState = IsWindowEnabled(cancel) != FALSE; current = nullptr;
    int brushColor = -1, erasedColor = -1; LRESULT erased = 0; ProbeBackground(brushColor, erasedColor, erased);
    auto getDpi = reinterpret_cast<UINT(WINAPI*)(HWND)>(GetProcAddress(GetModuleHandleW(L"user32.dll"), "GetDpiForWindow"));
    wchar_t observed[128]{}; DWORD bytes = 0; GetUserObjectInformationW(GetThreadDesktop(GetCurrentThreadId()), UOI_NAME, observed, sizeof(observed), &bytes);
    std::printf("{\"locale\":%d,\"actualWindowDpi\":%u,\"privateDesktopVerified\":%s,\"backgroundBrushColor\":%d,\"eraseResult\":%lld,\"eraseColor\":%d,\"engineDisabledMirrored\":%s,\"engineEnabledMirrored\":%s,\"stages\":[", locale, getDpi ? getDpi(parent) : 0,
      desktop == observed ? "true" : "false", brushColor, static_cast<long long>(erased), erasedColor, disabledState ? "true" : "false", restoredState ? "true" : "false");
    PrintStage(first); std::printf(","); PrintStage(disabled); std::printf(","); PrintStage(restored);
    std::printf("],\"naturalFrameMethod\":\"observe actual WM_DRAWITEM HDC after production handler; no forced repaint or input; retained client DC recorded separately and may be cached on inactive desktops\",\"scratchEraseProbeAfterFrames\":true}\n");
    Call("Dispose", {}, false); DestroyWindow(parent); FreeLibrary(library); SetThreadDesktop(original); CloseDesktop(owned); return 0;
  } catch (const std::exception& error) { std::fprintf(stderr, "%s (Win32 %lu)\n", error.what(), GetLastError());
    if (parent) DestroyWindow(parent); if (library) FreeLibrary(library); if (original) SetThreadDesktop(original); if (owned) CloseDesktop(owned); return 1; }
}
