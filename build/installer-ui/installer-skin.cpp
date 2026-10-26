#include "installer-skin.h"
#include "installer-path.h"
#include "installer-path-filesystem.h"
#include "installer-orbit.h"
#include "installer-progress.h"
#include <commctrl.h>
#include <objidl.h>
#include <gdiplus.h>
#include <shobjidl.h>
#include <shlobj.h>
#include <cmath>
#include <memory>
#include <string>
#include <vector>

#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "uuid.lib")

namespace skin {
#include "installer-strings.generated.h"

constexpr int kWidth = 760, kHeight = 500, kLeft = 250;
constexpr UINT_PTR kTimer = 475, kSubclass = 475, kNativeSubclass = 476;
constexpr UINT kConcealNativeMessage = WM_APP + 476;
constexpr UINT kInstallStageMessage = WM_APP + 477;
constexpr COLORREF kBackground = RGB(0, 0, 0), kLeftBackground = RGB(0, 0, 0);
constexpr COLORREF kText = RGB(244, 244, 244), kMuted = RGB(164, 164, 164);
constexpr COLORREF kAccent = RGB(29, 213, 162), kBorder = RGB(37, 37, 37);
constexpr COLORREF kEditBackground = RGB(12, 12, 12);
enum ControlId { Primary = 300, Secondary, Browse, Cancel, Path, Shortcut, Details, Copy, Keep, Exit, Language };
enum class Mode { Welcome, Install, Finish };
struct NativeWindow {
  HWND window = nullptr;
  bool requestedVisible = false, internalHide = false;
  bool requestedTabStop = false, requestedControlParent = false;
  HRGN originalRegion = nullptr;
  ~NativeWindow() { if (originalRegion) DeleteObject(originalRegion); }
};
struct State {
  HWND parent = nullptr, window = nullptr, path = nullptr, shortcut = nullptr;
  HWND primary = nullptr, secondary = nullptr, browse = nullptr, cancel = nullptr;
  HWND details = nullptr, copy = nullptr, keep = nullptr, exit = nullptr, detailEdit = nullptr, language = nullptr;
  HWND progress = nullptr, nativeDetails = nullptr, nativeCancel = nullptr;
  HINSTANCE instance = nullptr;
  HFONT font = nullptr;
  HBRUSH backgroundBrush = nullptr, editBrush = nullptr;
  ULONG_PTR gdiplusToken = 0;
  std::unique_ptr<Gdiplus::Image> image;
  std::vector<std::unique_ptr<NativeWindow>> nativeWindows;
  std::wstring version, initialPath, trustedInitialPath, installPath, folderName, error;
  int locale = 0;
  InstallationProgress installation;
  ULONGLONG lastSampleAt = 0, lastDetailsAt = 0, displayedElapsed = 0;
  bool displayedDeterminate = false;
  float scale = 1;
  bool custom = false, launch = false, animate = true, failed = false, uninstall = false;
  bool cancelOverlay = false, showingDetails = false, bypassCancel = false, forwardingNext = false;
  bool concealPending = false;
  ULONGLONG start = 0;
  Mode mode = Mode::Welcome;
};
static State s;
static HINSTANCE gInstance = nullptr;
constexpr int kLanguageIds[] = {2052, 1028, 1033, 1041, 1042};
int Px(float value);
bool ProtectNativeWindow(HWND window);
void ReadDetails();
void QueueNativeConceal() {
  if (s.window && !s.concealPending)
    s.concealPending = PostMessageW(s.window, kConcealNativeMessage, 0, 0) != FALSE;
}
bool IsNativeControl(HWND window) {
  if (!window) return false;
  for (const auto& native : s.nativeWindows)
    if (native->window && (native->window == window || IsChild(native->window, window))) return true;
  return false;
}
HWND SkinFocusTarget() {
  if (s.cancelOverlay) return s.keep;
  return s.mode == Mode::Install || s.failed ? s.details : s.primary;
}
void HideNativeWindow(NativeWindow* native) {
  if (!native->window || native->internalHide) return;
  native->internalHide = true;
  SetWindowPos(native->window, nullptr, 0, 0, 0, 0,
    SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_HIDEWINDOW);
  native->internalHide = false;
}

// NSIS shows an instfiles page *after* its SHOW callback. Hiding it once in that
// callback is insufficient: later native show/style/z-order operations must be
// intercepted before they take effect. Keep HWNDs alive for progress and engine
// messages; never change their enabled state or suppress independent dialogs.
LRESULT CALLBACK NativeWindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam,
                                 UINT_PTR, DWORD_PTR reference) {
  auto* native = reinterpret_cast<NativeWindow*>(reference);
  if (message == WM_NCDESTROY) {
    native->window = nullptr;
    RemoveWindowSubclass(window, NativeWindowProc, kNativeSubclass);
    return DefSubclassProc(window, message, wParam, lParam);
  }
  if (message == WM_WINDOWPOSCHANGING && lParam) {
    auto* position = reinterpret_cast<WINDOWPOS*>(lParam);
    if (!native->internalHide) {
      if (position->flags & SWP_SHOWWINDOW) { native->requestedVisible = true; QueueNativeConceal(); }
      if (position->flags & SWP_HIDEWINDOW) native->requestedVisible = false;
    }
    position->flags &= ~SWP_SHOWWINDOW;
    position->flags |= SWP_HIDEWINDOW | SWP_NOACTIVATE | SWP_NOZORDER;
    const auto result = DefSubclassProc(window, message, wParam, lParam);
    position->flags &= ~SWP_SHOWWINDOW;
    position->flags |= SWP_HIDEWINDOW | SWP_NOACTIVATE | SWP_NOZORDER;
    return result;
  } else if (message == WM_STYLECHANGING && static_cast<int>(wParam) == GWL_STYLE && lParam) {
    auto* style = reinterpret_cast<STYLESTRUCT*>(lParam);
    if (!native->internalHide) {
      if ((style->styleNew ^ style->styleOld) & WS_VISIBLE) native->requestedVisible = (style->styleNew & WS_VISIBLE) != 0;
      if ((style->styleNew ^ style->styleOld) & WS_TABSTOP) native->requestedTabStop = (style->styleNew & WS_TABSTOP) != 0;
    }
    style->styleNew &= ~(WS_VISIBLE | WS_TABSTOP);
    const auto result = DefSubclassProc(window, message, wParam, lParam);
    style->styleNew &= ~(WS_VISIBLE | WS_TABSTOP);
    return result;
  } else if (message == WM_STYLECHANGING && static_cast<int>(wParam) == GWL_EXSTYLE && lParam) {
    auto* style = reinterpret_cast<STYLESTRUCT*>(lParam);
    if (!native->internalHide && ((style->styleNew ^ style->styleOld) & WS_EX_CONTROLPARENT))
      native->requestedControlParent = (style->styleNew & WS_EX_CONTROLPARENT) != 0;
    style->styleNew &= ~WS_EX_CONTROLPARENT;
    const auto result = DefSubclassProc(window, message, wParam, lParam);
    style->styleNew &= ~WS_EX_CONTROLPARENT;
    return result;
  } else if (message == WM_SHOWWINDOW && wParam && !native->internalHide) {
    // Dialog ShowWindow paths can bypass a vetoable WINDOWPOSCHANGING message.
    // Suppress synchronously after the dialog's own processing, before painting.
    native->requestedVisible = true;
    QueueNativeConceal();
    const auto result = DefSubclassProc(window, message, wParam, lParam);
    HideNativeWindow(native);
    return result;
  } else if (message == WM_WINDOWPOSCHANGED && !native->internalHide) {
    // SWP_NOSENDCHANGING explicitly skips the pre-change notification.
    const auto result = DefSubclassProc(window, message, wParam, lParam);
    if (native->window && (GetWindowLongPtrW(window, GWL_STYLE) & WS_VISIBLE)) {
      native->requestedVisible = true;
      HideNativeWindow(native);
      QueueNativeConceal();
    }
    return result;
  }
  return DefSubclassProc(window, message, wParam, lParam);
}

bool ProtectNativeWindow(HWND window) {
  if (!window || window == s.window || GetParent(window) != s.parent || !(GetWindowLongPtrW(window, GWL_STYLE) & WS_CHILD)) return true;
  if (GetWindowThreadProcessId(window, nullptr) != GetCurrentThreadId()) return false;
  for (const auto& native : s.nativeWindows) if (native->window == window) return true;
  auto native = std::make_unique<NativeWindow>();
  native->window = window;
  native->requestedVisible = (GetWindowLongPtrW(window, GWL_STYLE) & WS_VISIBLE) != 0;
  native->requestedTabStop = (GetWindowLongPtrW(window, GWL_STYLE) & WS_TABSTOP) != 0;
  native->requestedControlParent = (GetWindowLongPtrW(window, GWL_EXSTYLE) & WS_EX_CONTROLPARENT) != 0;
  native->originalRegion = CreateRectRgn(0, 0, 0, 0);
  if (!native->originalRegion) return false;
  if (GetWindowRgn(window, native->originalRegion) == ERROR) {
    DeleteObject(native->originalRegion); native->originalRegion = nullptr;
  }
  if (!SetWindowSubclass(window, NativeWindowProc, kNativeSubclass, reinterpret_cast<DWORD_PTR>(native.get()))) return false;
  auto* installed = native.get();
  s.nativeWindows.push_back(std::move(native));
  // A real NSIS dialog can commit WS_VISIBLE only after WM_SHOWWINDOW returns.
  // Its empty region makes it unpaintable even before the queued visibility
  // normalization runs; no frame can leak the engine's original progress bar.
  HRGN emptyRegion = CreateRectRgn(0, 0, 0, 0);
  if (!emptyRegion || !SetWindowRgn(window, emptyRegion, TRUE)) {
    if (emptyRegion) DeleteObject(emptyRegion);
    RemoveWindowSubclass(window, NativeWindowProc, kNativeSubclass);
    s.nativeWindows.pop_back(); return false;
  }
  // Windows owns emptyRegion after successful SetWindowRgn.
  installed->internalHide = true;
  SetWindowLongPtrW(window, GWL_STYLE, GetWindowLongPtrW(window, GWL_STYLE) & ~WS_TABSTOP);
  SetWindowLongPtrW(window, GWL_EXSTYLE, GetWindowLongPtrW(window, GWL_EXSTYLE) & ~WS_EX_CONTROLPARENT);
  installed->internalHide = false;
  HideNativeWindow(installed);
  return true;
}

bool ProtectNativeChildren() {
  for (HWND child = GetWindow(s.parent, GW_CHILD); child; child = GetWindow(child, GW_HWNDNEXT))
    if (!ProtectNativeWindow(child)) return false;
  SetWindowPos(s.window, HWND_TOP, 0, 0, Px(kWidth), Px(kHeight), SWP_SHOWWINDOW | SWP_NOACTIVATE);
  return true;
}

void RestoreNativeChildren() {
  for (const auto& native : s.nativeWindows) {
    // WM_NCDESTROY clears the handle, so an unrelated reused HWND is never touched.
    if (!native->window || !IsWindow(native->window)) continue;
    RemoveWindowSubclass(native->window, NativeWindowProc, kNativeSubclass);
    const LONG_PTR style = GetWindowLongPtrW(native->window, GWL_STYLE);
    const LONG_PTR extended = GetWindowLongPtrW(native->window, GWL_EXSTYLE);
    SetWindowLongPtrW(native->window, GWL_STYLE, native->requestedTabStop ? style | WS_TABSTOP : style & ~WS_TABSTOP);
    SetWindowLongPtrW(native->window, GWL_EXSTYLE, native->requestedControlParent ? extended | WS_EX_CONTROLPARENT : extended & ~WS_EX_CONTROLPARENT);
    // Transfer the saved region back to Windows, or restore the default region.
    if (SetWindowRgn(native->window, native->originalRegion, TRUE)) native->originalRegion = nullptr;
    SetWindowPos(native->window, nullptr, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE |
      (native->requestedVisible ? SWP_SHOWWINDOW : SWP_HIDEWINDOW));
  }
  s.nativeWindows.clear();
}

const wchar_t* T(const wchar_t* key) {
  for (size_t i = 0; i < kSkinStringCount; ++i)
    if (wcscmp(key, kSkinStringKeys[i]) == 0) return kSkinStrings[s.locale][i];
  return L"";
}
const wchar_t* ActionText(const wchar_t* install, const wchar_t* uninstall) {
  return T(s.uninstall ? uninstall : install);
}
const wchar_t* PhaseText(InstallPhase phase) {
  if (s.uninstall) return T(phase == InstallPhase::Completed ? L"unPhaseCompleted" : L"unPhaseRemoving");
  return T(phase == InstallPhase::Configuring ? L"phaseConfiguring" :
    phase == InstallPhase::Completed ? L"phaseCompleted" : L"phaseDeploying");
}
std::wstring DurationText(uint64_t seconds) {
  const auto remainder = seconds % 60;
  return std::to_wstring(seconds / 60) + L":" + (remainder < 10 ? L"0" : L"") + std::to_wstring(remainder);
}
std::wstring CurrentStatus() {
  return std::wstring(PhaseText(s.installation.phase)) + L" · " + T(L"elapsed") + L" " + DurationText(s.installation.Elapsed(GetTickCount64()));
}
void ApplyInstallStage(WPARAM stage) {
  if (s.mode != Mode::Install || s.failed || s.uninstall) return;
  if (stage != static_cast<WPARAM>(InstallPhase::Deploying) && stage != static_cast<WPARAM>(InstallPhase::Configuring)) return;
  s.installation.SetPhase(static_cast<InstallPhase>(stage), GetTickCount64());
  if (s.showingDetails && !s.cancelOverlay) ReadDetails();
  InvalidateRect(s.window, nullptr, FALSE);
}
int Px(float value) { return static_cast<int>(std::lround(value * s.scale)); }
Gdiplus::Color Color(COLORREF c, BYTE alpha = 255) { return {alpha, GetRValue(c), GetGValue(c), GetBValue(c)}; }

std::wstring Pop(NsisStack** stack, int capacity) {
  if (!stack || !*stack || capacity < 1) return {};
  NsisStack* entry = *stack;
  std::wstring result(entry->text, wcsnlen_s(entry->text, static_cast<size_t>(capacity)));
  *stack = entry->next;
  GlobalFree(entry);
  return result;
}
void Push(NsisStack** stack, int capacity, const std::wstring& value) {
  if (!stack || capacity < 1) return;
  auto* entry = static_cast<NsisStack*>(GlobalAlloc(GPTR, sizeof(NsisStack) + static_cast<size_t>(capacity) * sizeof(wchar_t)));
  if (!entry) return;
  wcsncpy_s(entry->text, static_cast<size_t>(capacity), value.c_str(), _TRUNCATE);
  entry->next = *stack;
  *stack = entry;
}
HWND Handle(const std::wstring& value) {
  wchar_t* end = nullptr;
  const auto parsed = _wcstoui64(value.c_str(), &end, 0);
  return end && *end == 0 ? reinterpret_cast<HWND>(static_cast<UINT_PTR>(parsed)) : nullptr;
}
std::wstring Text(HWND window, size_t limit = 4096) {
  const auto count = std::min(static_cast<size_t>(std::max(0, GetWindowTextLengthW(window))), limit);
  std::vector<wchar_t> buffer(count + 1);
  GetWindowTextW(window, buffer.data(), static_cast<int>(buffer.size()));
  return buffer.data();
}
bool CanCancel() { return !s.nativeCancel || (IsWindow(s.nativeCancel) && IsWindowEnabled(s.nativeCancel)); }
void Repaint() { if (s.window) InvalidateRect(s.window, nullptr, FALSE); }
void Place(HWND window, int x, int y, int width, int height, bool show = true) {
  SetWindowPos(window, nullptr, Px(x), Px(y), Px(width), Px(height), SWP_NOZORDER | SWP_NOACTIVATE);
  ShowWindow(window, show ? SW_SHOW : SW_HIDE);
}
HWND Button(const wchar_t* title, int id) {
  HWND window = CreateWindowExW(0, L"BUTTON", title, WS_CHILD | WS_TABSTOP | BS_OWNERDRAW,
    0, 0, 0, 0, s.window, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), s.instance, nullptr);
  SendMessageW(window, WM_SETFONT, reinterpret_cast<WPARAM>(s.font), FALSE);
  return window;
}
void SetButton(HWND window, const wchar_t* key) { SetWindowTextW(window, T(key)); }

void Layout() {
  if (!s.window) return;
  const bool welcome = s.mode == Mode::Welcome, finish = s.mode == Mode::Finish;
  SetButton(s.primary, s.uninstall ? (finish ? L"close" : L"unRemove") : (finish ? L"launch" : L"install"));
  SetButton(s.secondary, finish ? L"later" : s.custom ? L"collapse" : L"custom");
  SetWindowTextW(s.details, s.showingDetails ? ActionText(L"hideDetails", L"unHideDetails") : ActionText(L"details", L"unDetails"));
  SetButton(s.cancel, s.failed ? L"close" : L"cancel");
  SetButton(s.browse, L"browse"); SetButton(s.copy, L"copy");
  SetWindowTextW(s.keep, ActionText(L"continue", L"unContinue")); SetWindowTextW(s.exit, ActionText(L"exit", L"unExit"));
  SetWindowTextW(s.shortcut, T(L"shortcut")); SetWindowTextW(s.parent, ActionText(L"title", L"unTitle"));
  Place(s.language, 578, 7, 150, 200, welcome && !s.uninstall);
  Place(s.primary, 282, 354, 446, 46, welcome || (finish && !s.failed));
  Place(s.secondary, 282, 410, welcome ? 310 : 446, 34, !s.uninstall && (welcome || (finish && !s.failed)));
  Place(s.path, 284, 240, 342, 32, welcome && s.custom && !s.uninstall);
  Place(s.browse, 634, 239, 94, 34, welcome && s.custom && !s.uninstall);
  Place(s.shortcut, 282, 284, 446, 30, welcome && s.custom && !s.uninstall);
  Place(s.cancel, 628, 410, 100, 32, !finish || s.failed);
  Place(s.details, 282, 410, 190, 32, s.mode == Mode::Install || s.failed);
  Place(s.detailEdit, 282, 152, 446, 240, s.showingDetails);
  Place(s.copy, 485, 410, 130, 32, s.showingDetails);
  if (s.showingDetails) ShowWindow(s.primary, SW_HIDE);
  const HWND controls[] = {s.primary, s.secondary, s.path, s.browse, s.shortcut, s.cancel, s.details, s.copy, s.language, s.detailEdit};
  for (HWND control : controls) {
    EnableWindow(control, !s.cancelOverlay);
    if (s.cancelOverlay) ShowWindow(control, SW_HIDE);
  }
  EnableWindow(s.cancel, !s.cancelOverlay && (CanCancel() || s.failed));
  Place(s.keep, 300, 285, 170, 40, s.cancelOverlay);
  Place(s.exit, 490, 285, 170, 40, s.cancelOverlay);
  Repaint();
}

void DrawText(Gdiplus::Graphics& graphics, const std::wstring& text, float x, float y,
              float width, float height, float size, COLORREF color, bool bold = false,
              Gdiplus::StringAlignment align = Gdiplus::StringAlignmentNear, bool singleLine = false,
              bool pathEllipsis = false) {
  Gdiplus::FontFamily family(L"Segoe UI");
  Gdiplus::Font font(&family, size, bold ? Gdiplus::FontStyleBold : Gdiplus::FontStyleRegular, Gdiplus::UnitPixel);
  Gdiplus::SolidBrush brush(Color(color));
  Gdiplus::StringFormat format;
  format.SetAlignment(align);
  if (singleLine) format.SetFormatFlags(Gdiplus::StringFormatFlagsNoWrap);
  format.SetTrimming(singleLine ? Gdiplus::StringTrimmingNone : Gdiplus::StringTrimmingEllipsisCharacter);
  if (pathEllipsis) {
    // Uninstall paths are read-only and may be much longer than two lines.
    format.SetFormatFlags(Gdiplus::StringFormatFlagsNoWrap);
    format.SetTrimming(Gdiplus::StringTrimmingEllipsisPath);
  }
  graphics.DrawString(text.c_str(), -1, &font, Gdiplus::RectF(x, y, width, height), &format, &brush);
}
void Line(Gdiplus::Graphics& graphics, float x, float y, float width, COLORREF color = kBorder) {
  Gdiplus::Pen pen(Color(color), 1);
  graphics.DrawLine(&pen, x, y, x + width, y);
}
void DrawBrand(Gdiplus::Graphics& graphics) {
  Gdiplus::SolidBrush left(Color(kLeftBackground));
  graphics.FillRectangle(&left, 0, 0, kLeft, kHeight - 32);
  Gdiplus::Pen border(Color(kBorder), 1);
  graphics.DrawLine(&border, 250, 0, 250, 468);
  DrawText(graphics, L"V E Y L O", 28, 28, 200, 25, 12, kAccent, true);
  DrawText(graphics, T(L"brand"), 28, 64, 208, 48, 32, kText, true);
  DrawText(graphics, T(L"tagline"), 28, 115, 204, 40, 12, kMuted);
  DrawText(graphics, T(L"tagline2"), 28, 145, 204, 40, 12, kMuted);
  if (s.image) graphics.DrawImage(s.image.get(), Gdiplus::RectF(67, 216, 116, 116));
  const auto orbitTransform = graphics.Save();
  graphics.TranslateTransform(125, 274);
  graphics.RotateTransform(static_cast<float>(kOrbitRotationDegrees));
  Gdiplus::Pen outer(Color(RGB(40, 124, 96)), 1), inner(Color(RGB(54, 164, 126)), 1);
  const Gdiplus::REAL dashes[] = {2.0f, 3.0f};
  inner.SetDashPattern(dashes, 2);
  graphics.DrawEllipse(&outer, static_cast<float>(-kOuterOrbitWidth / 2), static_cast<float>(-kOuterOrbitHeight / 2), static_cast<float>(kOuterOrbitWidth), static_cast<float>(kOuterOrbitHeight));
  graphics.DrawEllipse(&inner, static_cast<float>(-kInnerOrbitWidth / 2), static_cast<float>(-kInnerOrbitHeight / 2), static_cast<float>(kInnerOrbitWidth), static_cast<float>(kInnerOrbitHeight));
  graphics.Restore(orbitTransform);
  const double time = s.animate ? static_cast<double>(GetTickCount64() - s.start) / 1000.0 : 0;
  const double angles[] = {time * 6.283185307 / 14.0 - 1.0, -time * 6.283185307 / 21.0 + 0.7};
  for (int ring = 0; ring < 2; ++ring) {
    const auto point = EllipsePoint(ring ? kInnerOrbitWidth : kOuterOrbitWidth,
      ring ? kInnerOrbitHeight : kOuterOrbitHeight, angles[ring]);
    const float size = ring ? 4.0f : 6.0f;
    Gdiplus::SolidBrush dot(Color(ring ? RGB(37, 182, 140) : kAccent));
    graphics.FillEllipse(&dot, 125 + static_cast<float>(point.x) - size / 2,
      274 + static_cast<float>(point.y) - size / 2, size, size);
  }
  const wchar_t* labels[] = {L"feature1", L"feature2", L"feature3"};
  for (int index = 0; index < 3; ++index) {
    Gdiplus::SolidBrush dot(Color(kAccent));
    graphics.FillEllipse(&dot, 29.0f, static_cast<float>(388 + index * 25), 4.0f, 4.0f);
    DrawText(graphics, T(labels[index]), 43, static_cast<float>(381 + index * 25), 195, 25, 12, kMuted);
  }
}
void PaintTo(HWND window, HDC dc) {
  RECT client{}; GetClientRect(window, &client);
  HDC buffer = CreateCompatibleDC(dc);
  HBITMAP bitmap = CreateCompatibleBitmap(dc, client.right, client.bottom);
  auto old = SelectObject(buffer, bitmap);
  {
    Gdiplus::Graphics graphics(buffer);
    graphics.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
    graphics.SetTextRenderingHint(Gdiplus::TextRenderingHintClearTypeGridFit);
    graphics.ScaleTransform(s.scale, s.scale);
    graphics.Clear(Color(kBackground));
    DrawBrand(graphics);
    const bool welcome = s.mode == Mode::Welcome, finish = s.mode == Mode::Finish;
    DrawText(graphics, ActionText(welcome ? L"welcomeLabel" : finish ? L"finishLabel" : L"installLabel", welcome ? L"unWelcomeLabel" : finish ? L"unFinishLabel" : L"unInstallLabel"), 282, 39, 446, 24, 12, kAccent);
    DrawText(graphics, ActionText(s.failed ? L"failedTitle" : welcome ? L"welcomeTitle" : finish ? L"finishTitle" : L"installTitle", s.failed ? L"unFailedTitle" : welcome ? L"unWelcomeTitle" : finish ? L"unFinishTitle" : L"unInstallTitle"), 282, 77, 446, 55, 29, kText, true);
    if (!s.showingDetails) {
      DrawText(graphics, ActionText(s.failed ? L"failedBody" : welcome ? L"welcomeBody" : finish ? L"finishBody" : L"installBody", s.failed ? L"unFailedBody" : welcome ? L"unWelcomeBody" : finish ? L"unFinishBody" : L"unInstallBody"), 282, 137, 446, 65, 13, kMuted);
      if (welcome) {
        DrawText(graphics, T(L"pathLabel"), 282, 211, 446, 24, 12, kMuted);
        if (!s.custom) {
          DrawText(graphics, s.installPath, 282, 241, 446, 45, 13, kText, false, Gdiplus::StringAlignmentNear, false, s.uninstall);
          Line(graphics, 282, 294, 446);
        }
        DrawText(graphics, s.error.empty() ? ActionText(L"pathSafety", L"unRetention") : s.error, 282, 318, 446, 36, 11,
          s.error.empty() ? kMuted : RGB(255, 150, 145));
      } else if (finish && !s.failed) {
        Line(graphics, 282, 218, 446);
        DrawText(graphics, std::wstring(L"✓  ") + ActionText(L"installed", L"unInstalled"), 282, 240, 446, 26, 14, kAccent);
        DrawText(graphics, s.installPath, 282, 278, 446, 45, 12, kMuted, false, Gdiplus::StringAlignmentNear, false, s.uninstall);
        Line(graphics, 282, 325, 446);
      } else if (!s.failed) {
        DrawText(graphics, ActionText(L"progress", L"unProgress"), 282, 239, 320, 25, 13, kMuted);
        const auto now = GetTickCount64();
        const bool determinate = s.installation.Determinate(now);
        if (determinate) DrawText(graphics, std::to_wstring(s.installation.Percent()) + L"%", 654, 235, 74, 30, 18, kText, true, Gdiplus::StringAlignmentFar);
        Gdiplus::SolidBrush track(Color(kBorder)), fill(Color(kAccent));
        graphics.FillRectangle(&track, 282, 281, 446, 5);
        if (determinate) graphics.FillRectangle(&fill, 282.0f, 281.0f, static_cast<float>(446 * s.installation.Fraction()), 5.0f);
        else {
          const float x = s.animate ? static_cast<float>((now % 1800) / 1800.0 * 526 - 80) : 183;
          const float left = std::max(0.0f, x), right = std::min(446.0f, x + 80);
          if (right > left) graphics.FillRectangle(&fill, 282 + left, 281.0f, right - left, 5.0f);
        }
        DrawText(graphics, CurrentStatus(), 282, 306, 446, 24, 12, kMuted);
        if (!determinate) DrawText(graphics, ActionText(L"waitingStage", L"unWaitingStage"), 282, 334, 446, 48, 11, kMuted);
      }
    }
    if (s.showingDetails) DrawText(graphics, CurrentStatus(), 282, 126, 446, 22, 11, kMuted);
    Line(graphics, 0, 468, 760);
    DrawText(graphics, std::wstring(T(L"brand")) + L"  " + s.version, 20, 479, 470, 20, 10, kMuted);
    DrawText(graphics, L"Windows · x64", 585, 479, 155, 20, 10, kMuted, false, Gdiplus::StringAlignmentFar);
    if (s.cancelOverlay) {
      Gdiplus::SolidBrush scrim(Gdiplus::Color(205, 0, 0, 0)), panel(Color(kBackground));
      Gdiplus::Pen border(Color(kBorder), 1);
      graphics.FillRectangle(&scrim, 0, 0, kWidth, kHeight);
      graphics.FillRectangle(&panel, 270, 160, 420, 190);
      graphics.DrawRectangle(&border, 270, 160, 420, 190);
      DrawText(graphics, ActionText(L"cancelTitle", L"unCancelTitle"), 300, 184, 360, 36, 22, kText, true);
      DrawText(graphics, ActionText(L"cancelBody", L"unCancelBody"), 300, 230, 360, 48, 13, kMuted);
    }
  }
  BitBlt(dc, 0, 0, client.right, client.bottom, buffer, 0, 0, SRCCOPY);
  SelectObject(buffer, old); DeleteObject(bitmap); DeleteDC(buffer);
}
void Paint(HWND window) {
  PAINTSTRUCT ps{};
  HDC dc = BeginPaint(window, &ps);
  PaintTo(window, dc);
  EndPaint(window, &ps);
}

void DrawButton(const DRAWITEMSTRUCT& item) {
  Gdiplus::Graphics graphics(item.hDC);
  graphics.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
  graphics.SetTextRenderingHint(Gdiplus::TextRenderingHintClearTypeGridFit);
  graphics.ScaleTransform(s.scale, s.scale);
  const float width = (item.rcItem.right - item.rcItem.left) / s.scale;
  const float height = (item.rcItem.bottom - item.rcItem.top) / s.scale;
  const bool primary = item.CtlID == Primary || item.CtlID == Keep;
  const bool disabled = (item.itemState & ODS_DISABLED) != 0;
  const bool pressed = (item.itemState & ODS_SELECTED) != 0;
  graphics.Clear(Color(kBackground));
  Gdiplus::GraphicsPath outline;
  const float diameter = primary ? 16.0f : 12.0f;
  outline.AddArc(0.5f, 0.5f, diameter, diameter, 180, 90);
  outline.AddArc(width - diameter - 0.5f, 0.5f, diameter, diameter, 270, 90);
  outline.AddArc(width - diameter - 0.5f, height - diameter - 0.5f, diameter, diameter, 0, 90);
  outline.AddArc(0.5f, height - diameter - 0.5f, diameter, diameter, 90, 90);
  outline.CloseFigure();
  Gdiplus::SolidBrush fill(Color(primary ? (disabled ? RGB(40, 66, 57) : pressed ? RGB(18, 169, 135) : kAccent) : pressed ? RGB(32, 32, 32) : kBackground));
  graphics.FillPath(&fill, &outline);
  if (!primary) { Gdiplus::Pen border(Color(kBorder), 1); graphics.DrawPath(&border, &outline); }
  const auto text = Text(item.hwndItem);
  DrawText(graphics, text, 6, (height - 20) / 2, width - 12, 24, primary ? 14.0f : 12.0f,
    disabled ? RGB(105, 105, 105) : primary ? RGB(0, 42, 30) : kText, primary, Gdiplus::StringAlignmentCenter, true);
  if (item.itemState & ODS_FOCUS) {
    Gdiplus::Pen focus(Color(primary ? kLeftBackground : kAccent), 1);
    focus.SetDashStyle(Gdiplus::DashStyleDot);
    graphics.DrawRectangle(&focus, 3.0f, 3.0f, width - 6, height - 6);
  }
}

bool Validate() {
  const auto entered = TrimPath(s.custom ? Text(s.path, 1024) : s.installPath);
  const auto path = AppendApplicationFolder(entered, s.initialPath, s.folderName);
  wchar_t windows[MAX_PATH]{}; GetWindowsDirectoryW(windows, MAX_PATH);
  if (!ValidInstallPath(path, s.initialPath, windows)) {
    s.error = T(L"invalidPath"); s.custom = true; Layout(); SetFocus(s.path); return false;
  }
  // Reflect the exact final target before any installation and avoid repeated
  // folder appends on subsequent validation or when reopening custom options.
  SetWindowTextW(s.path, path.c_str());
  const bool trusted = !s.trustedInitialPath.empty() && SamePath(path, s.initialPath) && SamePath(path, s.trustedInitialPath);
  if (!SafeInstallDirectory(path, trusted)) {
    s.error = T(L"unsafeTarget"); s.custom = true; Layout(); SetFocus(s.path); return false;
  }
  s.installPath = path; s.error.clear(); return true;
}
void BrowseFolder() {
  IFileOpenDialog* dialog = nullptr;
  const HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  HRESULT result = CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog));
  if (SUCCEEDED(result)) {
    DWORD options = 0; dialog->GetOptions(&options);
    dialog->SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_DONTADDTORECENT);
    dialog->SetTitle(T(L"browseTitle"));
    IShellItem* initial = nullptr;
    if (SUCCEEDED(SHCreateItemFromParsingName(Text(s.path).c_str(), nullptr, IID_PPV_ARGS(&initial)))) { dialog->SetFolder(initial); initial->Release(); }
    result = dialog->Show(s.parent);
    if (SUCCEEDED(result)) {
      IShellItem* item = nullptr;
      if (SUCCEEDED(dialog->GetResult(&item))) {
        PWSTR path = nullptr;
        if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &path))) {
          SetWindowTextW(s.path, path); CoTaskMemFree(path); Validate();
        }
        item->Release();
      }
    } else if (result != HRESULT_FROM_WIN32(ERROR_CANCELLED)) s.error = T(L"browseError");
    dialog->Release();
  } else s.error = T(L"browseError");
  if (SUCCEEDED(initialized)) CoUninitialize();
  Repaint();
}

void ReadDetails() {
  std::wstring nativeOutput;
  if (IsWindow(s.nativeDetails) && GetWindowThreadProcessId(s.nativeDetails, nullptr) == GetCurrentThreadId()) {
    DWORD_PTR result = 0;
    if (SendMessageTimeoutW(s.nativeDetails, LVM_GETITEMCOUNT, 0, 0, SMTO_ABORTIFHUNG, 250, &result)) {
      const int count = std::min(static_cast<int>(result), 200);
      const int total = static_cast<int>(result);
      for (int index = std::max(0, total - count); index < total && nativeOutput.size() < 32768; ++index) {
        wchar_t buffer[1024]{};
        LVITEMW item{}; item.iSubItem = 0; item.pszText = buffer; item.cchTextMax = 1024;
        if (!SendMessageTimeoutW(s.nativeDetails, LVM_GETITEMTEXTW, index, reinterpret_cast<LPARAM>(&item), SMTO_ABORTIFHUNG, 250, &result)) break;
        nativeOutput.append(buffer); nativeOutput.append(L"\r\n");
        if (nativeOutput.size() > 32768) nativeOutput.resize(32768);
      }
    }
  }
  std::wstring output = std::wstring(ActionText(L"stageHistory", L"unStageHistory")) + L"\r\n";
  for (std::size_t index = 0; index < s.installation.historyCount; ++index) {
    const auto& entry = s.installation.history[index];
    output += L"[" + DurationText(entry.elapsedSeconds) + L"] " + PhaseText(entry.phase) + L"\r\n";
  }
  if (s.failed) output += std::wstring(ActionText(L"failedTitle", L"unFailedTitle")) + L"\r\n";
  output += L"\r\n";
  output += s.installation.sampleValid ? std::wstring(T(L"engineSnapshot")) + L" " + std::to_wstring(s.installation.Percent()) + L"%\r\n" : std::wstring(T(L"engineUnknown")) + L"\r\n";
  output += L"\r\n";
  output += nativeOutput.empty() ? ActionText(L"engineNoLogs", L"unEngineNoLogs") : std::wstring(ActionText(L"engineDetails", L"unEngineDetails")) + L"\r\n" + nativeOutput;
  if (output.size() > 32768) output.resize(32768);
  if (Text(s.detailEdit, 32768) == output) return;
  DWORD selectionStart = 0, selectionEnd = 0;
  SendMessageW(s.detailEdit, EM_GETSEL, reinterpret_cast<WPARAM>(&selectionStart), reinterpret_cast<LPARAM>(&selectionEnd));
  // Keep a user's selection stable while they inspect/copy a snapshot. The next
  // refresh catches up after selection is cleared; unchanged content is untouched.
  if (selectionStart != selectionEnd || GetCapture() == s.detailEdit) return;
  const auto firstLine = SendMessageW(s.detailEdit, EM_GETFIRSTVISIBLELINE, 0, 0);
  SendMessageW(s.detailEdit, WM_SETREDRAW, FALSE, 0);
  SetWindowTextW(s.detailEdit, output.c_str());
  SendMessageW(s.detailEdit, EM_SETSEL, selectionStart, selectionEnd);
  const auto currentLine = SendMessageW(s.detailEdit, EM_GETFIRSTVISIBLELINE, 0, 0);
  SendMessageW(s.detailEdit, EM_LINESCROLL, 0, firstLine - currentLine);
  SendMessageW(s.detailEdit, WM_SETREDRAW, TRUE, 0);
  InvalidateRect(s.detailEdit, nullptr, TRUE);
}
void CopyDetails() {
  const auto text = Text(s.detailEdit, 32768);
  if (!OpenClipboard(s.window)) return;
  const SIZE_T bytes = (text.size() + 1) * sizeof(wchar_t);
  HGLOBAL data = GlobalAlloc(GMEM_MOVEABLE, bytes);
  if (data) {
    void* destination = GlobalLock(data);
    if (destination) {
      memcpy(destination, text.c_str(), bytes); GlobalUnlock(data);
      if (!EmptyClipboard() || !SetClipboardData(CF_UNICODETEXT, data)) GlobalFree(data);
      else SetButton(s.copy, L"copied");
    } else GlobalFree(data);
  }
  CloseClipboard();
}
void RequestCancel() {
  if (s.mode == Mode::Finish || s.failed) {
    s.launch = false; s.bypassCancel = true;
    PostMessageW(s.parent, WM_COMMAND, IDCANCEL, 0); return;
  }
  if (!CanCancel()) return;
  s.cancelOverlay = true; Layout(); SetFocus(s.keep);
}
void ForwardNext() {
  if (s.forwardingNext) return;
  s.forwardingNext = true;
  EnableWindow(s.primary, FALSE); EnableWindow(s.secondary, FALSE);
  if (!PostMessageW(s.parent, WM_COMMAND, IDOK, 0)) { s.forwardingNext = false; Layout(); }
}
void Command(int id) {
  if (s.cancelOverlay) {
    if (id == Keep || id == IDCANCEL) { s.cancelOverlay = false; Layout(); SetFocus(s.cancel); }
    else if (id == Exit && CanCancel()) { s.bypassCancel = true; PostMessageW(s.parent, WM_COMMAND, IDCANCEL, 0); }
    return;
  }
  switch (id) {
    case Primary:
      if (s.mode == Mode::Welcome && !s.uninstall && !Validate()) break;
      s.launch = s.mode == Mode::Finish && !s.uninstall;
      ForwardNext(); break;
    case Secondary:
      if (s.uninstall) break;
      if (s.mode == Mode::Finish) { s.launch = false; ForwardNext(); }
      else {
        if (s.custom && !Validate()) break;
        s.custom = !s.custom; Layout(); if (s.custom) SetFocus(s.path);
      }
      break;
    case Browse: if (!s.uninstall) BrowseFolder(); break;
    case Cancel: RequestCancel(); break;
    case Details: s.showingDetails = !s.showingDetails; if (s.showingDetails) ReadDetails(); Layout(); break;
    case Copy: CopyDetails(); break;
  }
}

void Tick() {
  const auto now = GetTickCount64();
  if (s.mode == Mode::Install) {
    if (!s.lastSampleAt || now - s.lastSampleAt >= 200) {
      s.lastSampleAt = now;
      PBRANGE range{}; DWORD_PTR position = 0, ignored = 0;
      const bool readable = IsWindow(s.progress) && GetWindowThreadProcessId(s.progress, nullptr) == GetCurrentThreadId() &&
        SendMessageTimeoutW(s.progress, PBM_GETRANGE, 0, reinterpret_cast<LPARAM>(&range), SMTO_ABORTIFHUNG, 50, &ignored) &&
        SendMessageTimeoutW(s.progress, PBM_GETPOS, 0, 0, SMTO_ABORTIFHUNG, 50, &position);
      if (s.installation.Observe(readable, range.iLow, range.iHigh, static_cast<int>(position), now)) Repaint();
      EnableWindow(s.cancel, !s.cancelOverlay && CanCancel());
    }
    const auto elapsed = s.installation.Elapsed(now);
    const bool determinate = s.installation.Determinate(now);
    if (elapsed != s.displayedElapsed || determinate != s.displayedDeterminate) {
      s.displayedElapsed = elapsed; s.displayedDeterminate = determinate; Repaint();
    }
    if (s.showingDetails && !s.cancelOverlay && now - s.lastDetailsAt >= 500) {
      s.lastDetailsAt = now; ReadDetails();
    }
    if (!determinate && s.animate && !s.showingDetails && !s.cancelOverlay && IsWindowVisible(s.parent) && !IsIconic(s.parent)) {
      RECT bar{Px(282), Px(281), Px(728), Px(286)};
      InvalidateRect(s.window, &bar, FALSE);
    }
  }
  if (s.animate && !s.cancelOverlay && IsWindowVisible(s.parent) && !IsIconic(s.parent)) {
    RECT orbit{Px(37), Px(186), Px(213), Px(362)};
    InvalidateRect(s.window, &orbit, FALSE);
  }
}
LRESULT CALLBACK ParentProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam, UINT_PTR, DWORD_PTR) {
  if (message == WM_PARENTNOTIFY && LOWORD(wParam) == WM_CREATE)
    ProtectNativeWindow(reinterpret_cast<HWND>(lParam));
  if (message == WM_NEXTDLGCTL && lParam && IsNativeControl(reinterpret_cast<HWND>(wParam))) {
    const HWND target = SkinFocusTarget();
    if (IsWindowVisible(target) && IsWindowEnabled(target)) SetFocus(target);
    return 0;
  }
  if (message == WM_CLOSE || (message == WM_COMMAND && LOWORD(wParam) == IDCANCEL)) {
    if (!s.bypassCancel) {
      if (s.cancelOverlay) Command(Keep); else RequestCancel();
      return 0;
    }
  }
  if (message == WM_COMMAND && LOWORD(wParam) == IDOK && s.forwardingNext) {
    s.forwardingNext = false;
    return DefSubclassProc(window, message, wParam, lParam);
  }
  if (message == WM_COMMAND && LOWORD(wParam) == IDOK && s.cancelOverlay) {
    Command(Keep); return 0;
  }
  if (message == WM_COMMAND && LOWORD(wParam) == IDOK && s.failed) { RequestCancel(); return 0; }
  if (message == WM_COMMAND && LOWORD(wParam) == IDOK) {
    const HWND focused = GetFocus();
    if (focused == s.language) { SendMessageW(s.language, CB_SHOWDROPDOWN, FALSE, 0); return 0; }
    if (focused && IsChild(s.window, focused) && IsWindowEnabled(focused) && IsWindowVisible(focused)) {
      const int id = GetDlgCtrlID(focused);
      if (id == Secondary || id == Browse || id == Cancel || id == Details || id == Copy) { Command(id); return 0; }
    }
    if (s.mode == Mode::Finish) s.launch = !s.uninstall;
  }
  if (message == WM_COMMAND && LOWORD(wParam) == IDOK && s.mode == Mode::Welcome && !s.uninstall && !Validate()) return 0;
  return DefSubclassProc(window, message, wParam, lParam);
}
LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
  switch (message) {
    case kInstallStageMessage: ApplyInstallStage(wParam); return 0;
    case kConcealNativeMessage:
      s.concealPending = false;
      for (const auto& native : s.nativeWindows)
        if (native->window && (GetWindowLongPtrW(native->window, GWL_STYLE) & WS_VISIBLE)) HideNativeWindow(native.get());
      if (IsNativeControl(GetFocus())) {
        const HWND target = SkinFocusTarget();
        if (IsWindowVisible(target) && IsWindowEnabled(target)) SetFocus(target);
      }
      return 0;
    case WM_PAINT: Paint(window); return 0;
    case WM_PRINTCLIENT: PaintTo(window, reinterpret_cast<HDC>(wParam)); return 0;
    case WM_ERASEBKGND: return 1;
    case WM_COMMAND:
      if (LOWORD(wParam) == Language && HIWORD(wParam) == CBN_SELCHANGE && !s.uninstall) {
        const auto selected = SendMessageW(s.language, CB_GETCURSEL, 0, 0);
        if (selected >= 0 && selected < 5) { s.locale = static_cast<int>(selected); s.error.clear(); Layout(); }
      }
      else if (LOWORD(wParam) == Path && HIWORD(wParam) == EN_CHANGE) { s.error.clear(); Repaint(); }
      else if (HIWORD(wParam) == BN_CLICKED) Command(LOWORD(wParam));
      return 0;
    case WM_DRAWITEM: DrawButton(*reinterpret_cast<DRAWITEMSTRUCT*>(lParam)); return TRUE;
    case WM_TIMER: if (wParam == kTimer) Tick(); return 0;
    case WM_CTLCOLORSTATIC:
    case WM_CTLCOLOREDIT:
    case WM_CTLCOLORLISTBOX: {
      HDC dc = reinterpret_cast<HDC>(wParam);
      SetTextColor(dc, kText);
      const bool edit = message == WM_CTLCOLORLISTBOX || reinterpret_cast<HWND>(lParam) == s.language ||
        reinterpret_cast<HWND>(lParam) == s.path || reinterpret_cast<HWND>(lParam) == s.detailEdit;
      SetBkColor(dc, edit ? kEditBackground : kBackground);
      return reinterpret_cast<LRESULT>(edit ? s.editBrush : s.backgroundBrush);
    }
  }
  return DefWindowProcW(window, message, wParam, lParam);
}
void Cleanup() {
  if (s.parent) RemoveWindowSubclass(s.parent, ParentProc, kSubclass);
  if (s.window) { KillTimer(s.window, kTimer); DestroyWindow(s.window); }
  RestoreNativeChildren();
  s.image.reset();
  if (s.gdiplusToken) Gdiplus::GdiplusShutdown(s.gdiplusToken);
  if (s.font) DeleteObject(s.font);
  if (s.backgroundBrush) DeleteObject(s.backgroundBrush);
  if (s.editBrush) DeleteObject(s.editBrush);
  s = State{};
}
bool Initialize(HWND parent, const std::wstring& image, const std::wstring& language, const std::wstring& version) {
  Cleanup();
  if (!IsWindow(parent) || GetWindowThreadProcessId(parent, nullptr) != GetCurrentThreadId()) return false;
  s.parent = parent; s.instance = gInstance; s.version = version;
  const int lang = _wtoi(language.c_str());
  s.locale = lang == 1028 || lang == 3076 || lang == 5124 ? 1 : lang == 1041 ? 3 : lang == 1042 ? 4 : lang == 2052 || lang == 4100 ? 0 : 2;
  using DpiFunction = UINT(WINAPI*)(HWND);
  auto dpi = reinterpret_cast<DpiFunction>(GetProcAddress(GetModuleHandleW(L"user32.dll"), "GetDpiForWindow"));
  if (dpi) s.scale = std::clamp(dpi(parent) / 96.0f, 1.0f, 3.0f);
  BOOL animations = TRUE; SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &animations, 0); s.animate = animations != FALSE;
  Gdiplus::GdiplusStartupInput startup;
  if (Gdiplus::GdiplusStartup(&s.gdiplusToken, &startup, nullptr) != Gdiplus::Ok) return false;
  s.image.reset(Gdiplus::Image::FromFile(image.c_str()));
  if (!s.image || s.image->GetLastStatus() != Gdiplus::Ok) { Cleanup(); return false; }
  s.font = CreateFontW(-Px(13), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
  s.backgroundBrush = CreateSolidBrush(kBackground); s.editBrush = CreateSolidBrush(kEditBackground);
  WNDCLASSEXW cls{sizeof(cls)}; cls.lpfnWndProc = WindowProc; cls.hInstance = s.instance; cls.hCursor = LoadCursorW(nullptr, IDC_ARROW); cls.lpszClassName = L"VeyloInstallerSkin475";
  if (!RegisterClassExW(&cls) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) { Cleanup(); return false; }
  s.window = CreateWindowExW(WS_EX_CONTROLPARENT, cls.lpszClassName, T(L"title"), WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
    0, 0, Px(kWidth), Px(kHeight), parent, nullptr, s.instance, nullptr);
  if (!s.window) { Cleanup(); return false; }
  s.primary = Button(T(L"install"), Primary); s.secondary = Button(T(L"custom"), Secondary);
  s.browse = Button(T(L"browse"), Browse); s.cancel = Button(T(L"cancel"), Cancel);
  s.details = Button(T(L"details"), Details); s.copy = Button(T(L"copy"), Copy);
  s.keep = Button(T(L"continue"), Keep); s.exit = Button(T(L"exit"), Exit);
  s.path = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"", WS_CHILD | WS_TABSTOP | ES_AUTOHSCROLL, 0, 0, 0, 0, s.window, reinterpret_cast<HMENU>(Path), s.instance, nullptr);
  SendMessageW(s.path, EM_SETLIMITTEXT, 220, 0);
  s.shortcut = CreateWindowExW(0, L"BUTTON", T(L"shortcut"), WS_CHILD | WS_TABSTOP | BS_AUTOCHECKBOX, 0, 0, 0, 0, s.window, reinterpret_cast<HMENU>(Shortcut), s.instance, nullptr);
  SendMessageW(s.shortcut, BM_SETCHECK, BST_CHECKED, 0);
  s.detailEdit = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"", WS_CHILD | WS_TABSTOP | WS_VSCROLL | ES_READONLY | ES_MULTILINE | ES_AUTOVSCROLL, 0, 0, 0, 0, s.window, nullptr, s.instance, nullptr);
  s.language = CreateWindowExW(0, L"COMBOBOX", L"", WS_CHILD | WS_TABSTOP | WS_VSCROLL | CBS_DROPDOWNLIST, 0, 0, 0, 0, s.window, reinterpret_cast<HMENU>(Language), s.instance, nullptr);
  for (const wchar_t* languageName : {L"简体中文", L"繁體中文", L"English", L"日本語", L"한국어"})
    SendMessageW(s.language, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(languageName));
  SendMessageW(s.language, CB_SETCURSEL, s.locale, 0);
  for (HWND control : {s.path, s.shortcut, s.detailEdit, s.language}) SendMessageW(control, WM_SETFONT, reinterpret_cast<WPARAM>(s.font), FALSE);
  s.nativeCancel = GetDlgItem(parent, IDCANCEL);
  if (!SetWindowSubclass(parent, ParentProc, kSubclass, 0)) { Cleanup(); return false; }
  RECT rectangle{0, 0, Px(kWidth), Px(kHeight)};
  AdjustWindowRectEx(&rectangle, GetWindowLongW(parent, GWL_STYLE), GetMenu(parent) != nullptr, GetWindowLongW(parent, GWL_EXSTYLE));
  RECT old{}; GetWindowRect(parent, &old);
  const int width = rectangle.right - rectangle.left, height = rectangle.bottom - rectangle.top;
  MONITORINFO monitor{sizeof(monitor)}; GetMonitorInfoW(MonitorFromWindow(parent, MONITOR_DEFAULTTONEAREST), &monitor);
  SetWindowPos(parent, nullptr, monitor.rcWork.left + (monitor.rcWork.right - monitor.rcWork.left - width) / 2,
    monitor.rcWork.top + (monitor.rcWork.bottom - monitor.rcWork.top - height) / 2, width, height, SWP_NOZORDER | SWP_NOACTIVATE);
  SetWindowTextW(parent, T(L"title"));
  HMODULE dwm = LoadLibraryExW(L"dwmapi.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (dwm) {
    using DwmFunction = HRESULT(WINAPI*)(HWND, DWORD, LPCVOID, DWORD);
    auto set = reinterpret_cast<DwmFunction>(GetProcAddress(dwm, "DwmSetWindowAttribute"));
    if (set) {
      BOOL dark = TRUE; set(parent, 20, &dark, sizeof(dark)); set(parent, 19, &dark, sizeof(dark));
      const COLORREF caption = kBackground, text = kText;
      set(parent, 35, &caption, sizeof(caption)); set(parent, 36, &text, sizeof(text));
    }
    FreeLibrary(dwm);
  }
  s.start = GetTickCount64(); SetTimer(s.window, kTimer, s.animate ? 33 : 200, nullptr);
  if (!ProtectNativeChildren()) { Cleanup(); return false; }
  Layout();
  return true;
}
}

SKIN_EXPORT(Init) {
  const auto requestedParent = skin::Handle(skin::Pop(stack, stringSize));
  const auto image = skin::Pop(stack, stringSize), language = skin::Pop(stack, stringSize), version = skin::Pop(stack, stringSize);
  const bool ok = requestedParent == parent && skin::Initialize(parent, image, language, version);
  skin::Push(stack, stringSize, ok ? L"ok" : L"error");
}
SKIN_EXPORT(Page) {
  const auto mode = skin::Pop(stack, stringSize), path = skin::Pop(stack, stringSize), folder = skin::Pop(stack, stringSize);
  const auto progress = skin::Handle(skin::Pop(stack, stringSize)), details = skin::Handle(skin::Pop(stack, stringSize));
  const bool uninstall = mode == L"uninstall-confirm" || mode == L"uninstall" || mode == L"uninstall-finish";
  const bool welcome = mode == L"welcome" || mode == L"uninstall-confirm";
  const bool finish = mode == L"finish" || mode == L"uninstall-finish";
  if (!skin::s.window || parent != skin::s.parent || (!uninstall && mode != L"welcome" && mode != L"install" && mode != L"finish")) { skin::Push(stack, stringSize, L"error"); return; }
  skin::s.uninstall = uninstall;
  if (uninstall) { skin::s.custom = false; skin::s.launch = false; }
  if (!welcome && !finish && skin::s.mode != skin::Mode::Install) {
    skin::s.installation.Start(GetTickCount64()); skin::s.lastSampleAt = 0; skin::s.lastDetailsAt = 0;
  }
  if (finish) {
    // A worker's posted stage can otherwise be overtaken by NSIS's synchronous
    // install-done notification. Consume only this skin's fixed stage messages.
    MSG message{};
    while (PeekMessageW(&message, skin::s.window, skin::kInstallStageMessage, skin::kInstallStageMessage, PM_REMOVE))
      skin::ApplyInstallStage(message.wParam);
    skin::s.installation.SetPhase(skin::InstallPhase::Completed, GetTickCount64());
  }
  skin::s.mode = welcome ? skin::Mode::Welcome : finish ? skin::Mode::Finish : skin::Mode::Install;
  skin::s.installPath = path; skin::s.folderName = folder;
  if (skin::s.initialPath.empty()) skin::s.initialPath = path;
  SetWindowTextW(skin::s.path, path.c_str());
  skin::s.progress = progress && IsChild(parent, progress) ? progress : nullptr;
  skin::s.nativeDetails = details && IsChild(parent, details) ? details : nullptr;
  skin::s.cancelOverlay = false; skin::s.showingDetails = false;
  if (!skin::ProtectNativeChildren()) { skin::Push(stack, stringSize, L"error"); return; }
  skin::Layout();
  SetFocus(skin::s.mode == skin::Mode::Install ? skin::s.details : skin::s.primary);
  skin::Push(stack, stringSize, L"ok");
}
SKIN_EXPORT(Stage) {
  const auto value = skin::Pop(stack, stringSize);
  const auto phase = value == L"deploying" ? skin::InstallPhase::Deploying : value == L"configuring" ? skin::InstallPhase::Configuring : skin::InstallPhase::None;
  if (phase == skin::InstallPhase::None || !IsWindow(parent)) return;
  HWND window = FindWindowExW(parent, nullptr, L"VeyloInstallerSkin475", nullptr);
  DWORD processId = 0;
  if (window && GetWindowThreadProcessId(window, &processId) && processId == GetCurrentProcessId())
    PostMessageW(window, skin::kInstallStageMessage, static_cast<WPARAM>(phase), 0);
}
SKIN_EXPORT(GetPath) { skin::Push(stack, stringSize, skin::s.window && !skin::s.uninstall && skin::Validate() ? skin::s.installPath : L""); }
SKIN_EXPORT(GetShortcut) { skin::Push(stack, stringSize, SendMessageW(skin::s.shortcut, BM_GETCHECK, 0, 0) == BST_CHECKED ? L"1" : L"0"); }
SKIN_EXPORT(GetLaunch) { skin::Push(stack, stringSize, skin::s.launch ? L"1" : L"0"); }
SKIN_EXPORT(GetLanguage) { skin::Push(stack, stringSize, std::to_wstring(skin::kLanguageIds[skin::s.locale])); }
SKIN_EXPORT(TrustExistingPath) {
  const auto path = skin::TrimPath(skin::Pop(stack, stringSize));
  wchar_t windows[MAX_PATH]{}; GetWindowsDirectoryW(windows, MAX_PATH);
  if (skin::s.window && parent == skin::s.parent && skin::ValidInstallPath(path, L"", windows) && skin::SafeInstallDirectory(path, true))
    skin::s.trustedInitialPath = path;
}
SKIN_EXPORT(Failed) { skin::s.failed = true; skin::s.cancelOverlay = false; skin::Layout(); }
SKIN_EXPORT(Dispose) { skin::Cleanup(); }
BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) { skin::gInstance = instance; DisableThreadLibraryCalls(instance); }
  return TRUE;
}
