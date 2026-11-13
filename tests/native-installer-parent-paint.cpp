#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <commctrl.h>
#include <cstdio>
#include <string>

namespace {
struct Stack { Stack* next; wchar_t text[1]; };
using Export = void(__cdecl*)(HWND, int, wchar_t*, Stack**, void*);
constexpr UINT kRecord = WM_APP + 906, kFinish = WM_APP + 907;
constexpr UINT_PTR kObserver = 479026;
HWND parent = nullptr, skin = nullptr, details = nullptr, cancel = nullptr;
HANDLE output = INVALID_HANDLE_VALUE;
std::wstring phase;
bool finishing = false, finished = false;

std::wstring Pop(Stack** stack) {
  if (!stack || !*stack) return {};
  Stack* entry = *stack; const std::wstring value(entry->text);
  *stack = entry->next; GlobalFree(entry); return value;
}
void Push(Stack** stack, int capacity, const wchar_t* text) {
  auto* entry = static_cast<Stack*>(GlobalAlloc(GPTR, sizeof(Stack) + capacity * sizeof(wchar_t)));
  if (!entry) return;
  wcsncpy_s(entry->text, capacity, text, _TRUNCATE); entry->next = *stack; *stack = entry;
}
void Write(const std::string& line) {
  if (output == INVALID_HANDLE_VALUE) return;
  DWORD written = 0; WriteFile(output, line.data(), static_cast<DWORD>(line.size()), &written, nullptr);
}
void CloseOutput() { if (output != INVALID_HANDLE_VALUE) CloseHandle(output); output = INVALID_HANDLE_VALUE; }
struct Pixels { int copied = 0, black = 0, white = 0, ink = 0, total = 0; };
Pixels ReadPixels(HWND window) {
  Pixels value; if (!window || !IsWindow(window)) return value;
  RECT area{}; GetClientRect(window, &area);
  if (area.right <= 0 || area.bottom <= 0 || area.right > 1024 || area.bottom > 256) return value;
  HDC dc = GetDC(window), memory = dc ? CreateCompatibleDC(dc) : nullptr;
  BITMAPINFO info{}; info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER); info.bmiHeader.biWidth = area.right;
  info.bmiHeader.biHeight = -area.bottom; info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32; info.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr; HBITMAP bitmap = dc ? CreateDIBSection(dc, &info, DIB_RGB_COLORS, &bits, nullptr, 0) : nullptr;
  if (memory && bitmap) {
    HGDIOBJ old = SelectObject(memory, bitmap);
    value.copied = BitBlt(memory, 0, 0, area.right, area.bottom, dc, 0, 0, SRCCOPY) != FALSE;
    // Sampling happens only in an explicit GUI snapshot, never inside a paint callback.
    GdiFlush();
    if (value.copied) for (int i = 0; i < area.right * area.bottom; ++i) {
      const DWORD pixel = static_cast<DWORD*>(bits)[i];
      const int r = (pixel >> 16) & 255, g = (pixel >> 8) & 255, b = pixel & 255; ++value.total;
      if (r < 16 && g < 16 && b < 16) ++value.black;
      else if (r >= 238 && g >= 238 && b >= 238) ++value.white;
      else if (r >= 50 || g >= 50 || b >= 50) ++value.ink;
    }
    SelectObject(memory, old);
  }
  if (bitmap) DeleteObject(bitmap); if (memory) DeleteDC(memory); if (dc) ReleaseDC(window, dc);
  return value;
}
bool ParentDcCovers(HWND child) {
  RECT area{}; GetClientRect(child, &area);
  MapWindowPoints(child, parent, reinterpret_cast<POINT*>(&area), 2);
  HDC dc = GetDC(parent); if (!dc) return true;
  const bool covered = RectVisible(dc, &area) != FALSE; ReleaseDC(parent, dc); return covered;
}
std::string ButtonJson(HWND button, const char* name) {
  const Pixels p = ReadPixels(button); char row[768];
  std::snprintf(row, sizeof(row), "{\"name\":\"%s\",\"type\":%lu,\"enabled\":%d,\"visible\":%d,\"parentDcCovers\":%d,\"pixels\":{\"copied\":%d,\"black\":%d,\"white\":%d,\"ink\":%d,\"total\":%d}}",
    name, static_cast<unsigned long>(GetWindowLongW(button, GWL_STYLE) & BS_TYPEMASK),
    IsWindowEnabled(button) != FALSE, IsWindowVisible(button) != FALSE, ParentDcCovers(button),
    p.copied, p.black, p.white, p.ink, p.total); return row;
}
void Record() {
  wchar_t desktop[128]{}; DWORD needed = 0;
  GetUserObjectInformationW(GetThreadDesktop(GetCurrentThreadId()), UOI_NAME, desktop, sizeof(desktop), &needed);
  std::string desktopName; for (wchar_t ch : desktop) { if (!ch) break; desktopName.push_back(ch < 128 ? static_cast<char>(ch) : '?'); }
  std::string label; for (wchar_t ch : phase) label.push_back(static_cast<char>(ch));
  using Dpi = UINT(WINAPI*)(HWND);
  auto dpi = reinterpret_cast<Dpi>(GetProcAddress(GetModuleHandleW(L"user32.dll"), "GetDpiForWindow"));
  char header[512]; std::snprintf(header, sizeof(header), "{\"phase\":\"%s\",\"thread\":%lu,\"ownerThread\":%lu,\"desktop\":\"%s\",\"dpi\":%u,\"parentStyle\":%lu,\"parentClipChildren\":%d,\"buttons\":[",
    label.c_str(), GetCurrentThreadId(), GetWindowThreadProcessId(skin, nullptr), desktopName.c_str(), dpi ? dpi(parent) : 0,
    static_cast<unsigned long>(GetWindowLongW(parent, GWL_STYLE)), (GetWindowLongW(parent, GWL_STYLE) & WS_CLIPCHILDREN) != 0);
  const std::string buttonRows = ButtonJson(details, "details") + "," + ButtonJson(cancel, "cancel");
  Write(std::string(header) + buttonRows + "]}\n");
}
void FinishOnGui() {
  if (!IsWindow(parent)) { CloseOutput(); return; }
  const LONG_PTR before = GetWindowLongPtrW(parent, GWL_STYLE);
  SetWindowLongPtrW(parent, GWL_STYLE, before ^ WS_HSCROLL);
  const LONG_PTR changed = GetWindowLongPtrW(parent, GWL_STYLE);
  auto dispose = reinterpret_cast<Export>(GetProcAddress(GetModuleHandleW(L"VeyloInstaller.dll"), "Dispose"));
  if (!dispose) return;
  finishing = true; Stack* stack = nullptr; wchar_t variables[1024 * 32]{};
  dispose(parent, 1024, variables, &stack, nullptr);
  const LONG_PTR after = GetWindowLongPtrW(parent, GWL_STYLE); char row[512];
  std::snprintf(row, sizeof(row), "{\"phase\":\"disposed\",\"thread\":%lu,\"beforeClip\":%d,\"afterClip\":%d,\"unrelatedBefore\":%d,\"unrelatedChanged\":%d,\"unrelatedAfter\":%d}\n",
    GetCurrentThreadId(), (before & WS_CLIPCHILDREN) != 0, (after & WS_CLIPCHILDREN) != 0,
    (before & WS_HSCROLL) != 0, (changed & WS_HSCROLL) != 0, (after & WS_HSCROLL) != 0);
  Write(row); finished = true; CloseOutput();
}
LRESULT CALLBACK Observe(HWND window, UINT message, WPARAM wParam, LPARAM lParam, UINT_PTR, DWORD_PTR) {
  if (message == kRecord) { Record(); return 1; }
  if (message == kFinish) { FinishOnGui(); return finished ? 1 : 0; }
  // Natural paint/erase/default-button processing is deliberately untouched.
  if (message == WM_NCDESTROY) { RemoveWindowSubclass(window, Observe, kObserver); if (!finishing) CloseOutput(); }
  return DefSubclassProc(window, message, wParam, lParam);
}
}

extern "C" __declspec(dllexport) void __cdecl ParentPaintInit(HWND host, int capacity, wchar_t*, Stack** stack, void*) {
  const auto path = Pop(stack); parent = host;
  skin = FindWindowExW(host, nullptr, L"VeyloInstallerSkin475", nullptr);
  if (!skin || path.find(L"veylo-ready-lifecycle-test-") == std::wstring::npos || GetWindowThreadProcessId(skin, nullptr) != GetCurrentThreadId()) { Push(stack, capacity, L"error"); return; }
  details = GetDlgItem(skin, 306); cancel = GetDlgItem(skin, 303);
  output = CreateFileW(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
  const bool ok = details && cancel && output != INVALID_HANDLE_VALUE && SetWindowSubclass(skin, Observe, kObserver, 0);
  if (!ok) CloseOutput(); Push(stack, capacity, ok ? L"ok" : L"error");
}
extern "C" __declspec(dllexport) void __cdecl ParentPaintSnapshot(HWND, int capacity, wchar_t*, Stack** stack, void*) {
  phase = Pop(stack); DWORD_PTR result = 0;
  const bool ok = phase.size() == 1 && phase[0] >= L'0' && phase[0] <= L'4'
    && SendMessageTimeoutW(skin, kRecord, 0, 0, SMTO_ABORTIFHUNG, 1000, &result) && result == 1;
  Push(stack, capacity, ok ? L"ok" : L"error");
}
extern "C" __declspec(dllexport) void __cdecl ParentPaintFinish(HWND, int capacity, wchar_t*, Stack** stack, void*) {
  DWORD_PTR result = 0;
  const bool ok = SendMessageTimeoutW(skin, kFinish, 0, 0, SMTO_ABORTIFHUNG, 1000, &result) && result == 1;
  Push(stack, capacity, ok ? L"ok" : L"error");
}
