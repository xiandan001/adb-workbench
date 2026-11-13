#include "installer-wait-policy.h"
#include <shellapi.h>
#include <algorithm>
#include <cmath>

namespace waitui {
using veylo::waiter::Arguments;
using veylo::waiter::Installation;
#include "installer-strings.generated.h"
constexpr int kRetry = 101, kClose = 102;
constexpr COLORREF kBackground = RGB(0, 0, 0), kCard = RGB(12, 20, 17), kBorder = RGB(37, 58, 49);
constexpr COLORREF kAccent = RGB(29, 213, 162), kText = RGB(242, 248, 245), kMuted = RGB(169, 189, 181);
struct WindowState {
  Arguments arguments; const wchar_t* mutexName = veylo::waiter::kInstallMutex;
  HWND window = nullptr, retry = nullptr, close = nullptr; UINT dpi = 96;
  HFONT normal = nullptr, title = nullptr, brand = nullptr; std::wstring messageKey = L"waitActive";
  bool quitLoop = true; int angle = 0;
};
const wchar_t* Text(int locale, const wchar_t* key) {
  for (size_t i = 0; i < kSkinStringCount; ++i) if (!wcscmp(kSkinStringKeys[i], key)) return kSkinStrings[locale][i];
  return L"";
}
void EnableDpi() {
  using SetContext = BOOL(WINAPI*)(HANDLE);
  const auto set = reinterpret_cast<SetContext>(GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetProcessDpiAwarenessContext"));
  if (set) set(reinterpret_cast<HANDLE>(-4)); else SetProcessDPIAware();
}
UINT Dpi(HWND window) {
  using GetDpi = UINT(WINAPI*)(HWND);
  const auto get = reinterpret_cast<GetDpi>(GetProcAddress(GetModuleHandleW(L"user32.dll"), "GetDpiForWindow"));
  if (window && get) return get(window);
  HDC dc = GetDC(nullptr); const UINT dpi = GetDeviceCaps(dc, LOGPIXELSX); ReleaseDC(nullptr, dc); return dpi ? dpi : 96;
}
int Px(const WindowState& state, int value) { return MulDiv(value, state.dpi, 96); }
void Fonts(WindowState& state) {
  for (auto font : {state.normal, state.title, state.brand}) if (font) DeleteObject(font);
  const auto make = [&](int size, int weight) { return CreateFontW(-Px(state, size), 0, 0, 0, weight, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI"); };
  state.normal = make(14, FW_NORMAL); state.title = make(20, FW_SEMIBOLD); state.brand = make(20, FW_BOLD);
  if (state.retry) SendMessageW(state.retry, WM_SETFONT, reinterpret_cast<WPARAM>(state.normal), TRUE);
  if (state.close) SendMessageW(state.close, WM_SETFONT, reinterpret_cast<WPARAM>(state.normal), TRUE);
}
void FillRound(HDC dc, RECT rect, int radius, COLORREF background, COLORREF border) {
  const auto brush = CreateSolidBrush(background); const auto pen = CreatePen(PS_SOLID, 1, border);
  const auto oldBrush = SelectObject(dc, brush), oldPen = SelectObject(dc, pen);
  RoundRect(dc, rect.left, rect.top, rect.right, rect.bottom, radius, radius);
  SelectObject(dc, oldBrush); SelectObject(dc, oldPen); DeleteObject(brush); DeleteObject(pen);
}
void Layout(WindowState& state) {
  RECT client{}; GetClientRect(state.window, &client); const int gap = Px(state, 12), margin = Px(state, 32);
  const int width = (client.right - margin * 2 - gap) / 2, y = client.bottom - Px(state, 72), height = Px(state, 40);
  MoveWindow(state.retry, margin, y, width, height, TRUE); MoveWindow(state.close, margin + width + gap, y, width, height, TRUE);
}
void Draw(WindowState& state, HDC target) {
  RECT area{}; GetClientRect(state.window, &area);
  HDC dc = CreateCompatibleDC(target); HBITMAP bitmap = CreateCompatibleBitmap(target, area.right, area.bottom); const auto oldBitmap = SelectObject(dc, bitmap);
  const auto black = CreateSolidBrush(kBackground); FillRect(dc, &area, black); DeleteObject(black);
  RECT card{Px(state, 16), Px(state, 16), area.right - Px(state, 16), area.bottom - Px(state, 16)};
  FillRound(dc, card, Px(state, 24), kCard, kBorder); SetBkMode(dc, TRANSPARENT);
  RECT mark{Px(state, 32), Px(state, 32), Px(state, 62), Px(state, 62)}; FillRound(dc, mark, Px(state, 10), kAccent, kAccent);
  SelectObject(dc, state.brand); SetTextColor(dc, kBackground); DrawTextW(dc, L"V", -1, &mark, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
  RECT brand{Px(state, 73), Px(state, 32), area.right - Px(state, 72), Px(state, 62)};
  SetTextColor(dc, kAccent); DrawTextW(dc, Text(state.arguments.locale, L"brand"), -1, &brand, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
  const auto pen = CreatePen(PS_SOLID, Px(state, 2), kAccent); const auto oldPen = SelectObject(dc, pen); const auto oldBrush = SelectObject(dc, GetStockObject(NULL_BRUSH));
  const int cx = area.right - Px(state, 47), cy = Px(state, 47), radius = Px(state, 10);
  const double radians = state.angle * 3.141592653589793 / 180;
  Arc(dc, cx - radius, cy - radius, cx + radius, cy + radius, cx + static_cast<int>(std::cos(radians) * radius), cy + static_cast<int>(std::sin(radians) * radius), cx + static_cast<int>(std::cos(radians + 4) * radius), cy + static_cast<int>(std::sin(radians + 4) * radius));
  SelectObject(dc, oldPen); SelectObject(dc, oldBrush); DeleteObject(pen);
  RECT title{Px(state, 32), Px(state, 86), area.right - Px(state, 32), Px(state, 124)};
  SelectObject(dc, state.title); SetTextColor(dc, kText); DrawTextW(dc, Text(state.arguments.locale, L"waitTitle"), -1, &title, DT_LEFT | DT_WORDBREAK | DT_NOPREFIX);
  RECT body{Px(state, 32), Px(state, 132), area.right - Px(state, 32), area.bottom - Px(state, 94)};
  SelectObject(dc, state.normal); SetTextColor(dc, kMuted); DrawTextW(dc, Text(state.arguments.locale, state.messageKey.c_str()), -1, &body, DT_LEFT | DT_WORDBREAK | DT_NOPREFIX);
  BitBlt(target, 0, 0, area.right, area.bottom, dc, 0, 0, SRCCOPY); SelectObject(dc, oldBitmap); DeleteObject(bitmap); DeleteDC(dc);
}
void DrawButton(WindowState& state, const DRAWITEMSTRUCT& item) {
  const bool primary = item.CtlID == kRetry; const bool pressed = (item.itemState & ODS_SELECTED) != 0;
  FillRound(item.hDC, item.rcItem, Px(state, 14), primary ? (pressed ? RGB(15, 184, 137) : kAccent) : RGB(28, 42, 34), primary ? kAccent : kBorder);
  SetBkMode(item.hDC, TRANSPARENT); SetTextColor(item.hDC, primary ? kBackground : kText); SelectObject(item.hDC, state.normal);
  RECT label = item.rcItem; InflateRect(&label, -Px(state, 8), -Px(state, 4));
  DrawTextW(item.hDC, Text(state.arguments.locale, primary ? L"waitRetry" : L"waitClose"), -1, &label, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
  if (item.itemState & ODS_FOCUS) { RECT focus = item.rcItem; InflateRect(&focus, -Px(state, 4), -Px(state, 4)); DrawFocusRect(item.hDC, &focus); }
}
void Retry(WindowState& state) {
  const auto installation = veylo::waiter::ProbeInstallation(state.mutexName);
  if (installation == Installation::Inactive) {
    if (veylo::waiter::LaunchTarget(state.arguments.target)) { DestroyWindow(state.window); return; }
    state.messageKey = L"waitLaunchFailed";
  } else state.messageKey = installation == Installation::Active ? L"waitActive" : L"waitUnknown";
  InvalidateRect(state.window, nullptr, FALSE);
}
bool Key(WindowState& state, WPARAM key, bool shift = false) {
  if (key == VK_TAB) { SetFocus(GetNextDlgTabItem(state.window, GetFocus(), shift)); return true; }
  if (key == VK_ESCAPE) { DestroyWindow(state.window); return true; }
  if (key == VK_RETURN) { if (GetFocus() == state.close) DestroyWindow(state.window); else Retry(state); return true; }
  return false;
}
LRESULT CALLBACK WindowProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
  auto* state = reinterpret_cast<WindowState*>(GetWindowLongPtrW(window, GWLP_USERDATA));
  if (message == WM_NCCREATE) { state = static_cast<WindowState*>(reinterpret_cast<CREATESTRUCTW*>(lParam)->lpCreateParams); state->window = window; SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(state)); }
  if (!state) return DefWindowProcW(window, message, wParam, lParam);
  switch (message) {
    case WM_CREATE: {
      state->dpi = Dpi(window); Fonts(*state);
      const auto make = [&](int id, const wchar_t* key) { return CreateWindowExW(0, L"BUTTON", Text(state->arguments.locale, key), WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_OWNERDRAW, 0, 0, 1, 1, window, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), GetModuleHandleW(nullptr), nullptr); };
      state->retry = make(kRetry, L"waitRetry"); state->close = make(kClose, L"waitClose"); Fonts(*state); Layout(*state); SetTimer(window, 1, 80, nullptr); return 0;
    }
    case WM_PAINT: { PAINTSTRUCT paint{}; const auto dc = BeginPaint(window, &paint); Draw(*state, dc); EndPaint(window, &paint); return 0; }
    case WM_PRINTCLIENT: Draw(*state, reinterpret_cast<HDC>(wParam)); return 0;
    case WM_ERASEBKGND: return 1;
    case WM_DRAWITEM: DrawButton(*state, *reinterpret_cast<DRAWITEMSTRUCT*>(lParam)); return TRUE;
    case WM_TIMER: state->angle = (state->angle + 24) % 360; InvalidateRect(window, nullptr, FALSE); return 0;
    case WM_SIZE: Layout(*state); return 0;
    case WM_DPICHANGED: { state->dpi = HIWORD(wParam); Fonts(*state); const auto rect = reinterpret_cast<RECT*>(lParam); SetWindowPos(window, nullptr, rect->left, rect->top, rect->right - rect->left, rect->bottom - rect->top, SWP_NOZORDER | SWP_NOACTIVATE); Layout(*state); return 0; }
    case WM_KEYDOWN: if (Key(*state, wParam, (GetKeyState(VK_SHIFT) & 0x8000) != 0)) return 0; break;
    case WM_COMMAND: if (HIWORD(wParam) == BN_CLICKED) { if (LOWORD(wParam) == kRetry) Retry(*state); else if (LOWORD(wParam) == kClose) DestroyWindow(window); } return 0;
    case WM_CLOSE: DestroyWindow(window); return 0;
    case WM_DESTROY: KillTimer(window, 1); for (auto font : {state->normal, state->title, state->brand}) if (font) DeleteObject(font); state->normal = state->title = state->brand = nullptr; if (state->quitLoop) PostQuitMessage(0); return 0;
  }
  return DefWindowProcW(window, message, wParam, lParam);
}
HWND CreateWaitWindow(WindowState& state, bool visible) {
  WNDCLASSW klass{}; klass.lpfnWndProc = WindowProcedure; klass.hInstance = GetModuleHandleW(nullptr); klass.lpszClassName = L"VeyloIndependentInstallWait"; klass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  RegisterClassW(&klass); state.dpi = Dpi(nullptr);
  const auto status = veylo::waiter::ProbeInstallation(state.mutexName);
  state.messageKey = status == Installation::Active ? L"waitActive" : status == Installation::Inactive ? L"waitReady" : L"waitUnknown";
  const HWND window = CreateWindowExW(WS_EX_CONTROLPARENT, klass.lpszClassName, Text(state.arguments.locale, L"waitTitle"), WS_POPUP | WS_SYSMENU,
    visible ? CW_USEDEFAULT : -30000, visible ? CW_USEDEFAULT : -30000, Px(state, 460), Px(state, 330), nullptr, nullptr, klass.hInstance, &state);
  if (window && visible) { ShowWindow(window, SW_SHOWNORMAL); UpdateWindow(window); SetFocus(state.retry); }
  return window;
}
}

#ifndef VEYLO_INSTALLER_WAIT_TEST
int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  int argc = 0; auto argv = CommandLineToArgvW(GetCommandLineW(), &argc); veylo::waiter::Arguments arguments;
  const bool valid = argv && veylo::waiter::ParseArguments(argc, argv, arguments);
  if (argv) LocalFree(argv); if (!valid) return 2;
  waitui::EnableDpi(); waitui::WindowState state; state.arguments = std::move(arguments);
  if (!waitui::CreateWaitWindow(state, true)) return 3;
  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    if (message.message == WM_KEYDOWN && waitui::Key(state, message.wParam, (GetKeyState(VK_SHIFT) & 0x8000) != 0)) continue;
    TranslateMessage(&message); DispatchMessageW(&message);
  }
  return 0;
}
#endif
