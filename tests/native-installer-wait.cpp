#define VEYLO_INSTALLER_WAIT_TEST
#include "../build/installer-ui/installer-wait.cpp"
#include <objidl.h>
#include <gdiplus.h>
#include <cstdio>
#include <stdexcept>

namespace {
int checks = 0;
void Check(bool value, const char* label) { if (!value) throw std::runtime_error(label); ++checks; std::printf("PASS %s\n", label); }
std::wstring Encode(const std::wstring& value) {
  const int length = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::vector<BYTE> bytes(length); WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), reinterpret_cast<char*>(bytes.data()), length, nullptr, nullptr);
  DWORD size = 0; CryptBinaryToStringW(bytes.data(), static_cast<DWORD>(bytes.size()), CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &size);
  std::vector<wchar_t> result(size); CryptBinaryToStringW(bytes.data(), static_cast<DWORD>(bytes.size()), CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, result.data(), &size); return result.data();
}
bool Parse(std::vector<std::wstring> values, veylo::waiter::Arguments& arguments) {
  std::vector<wchar_t*> argv; for (auto& value : values) argv.push_back(value.data());
  return veylo::waiter::ParseArguments(static_cast<int>(argv.size()), argv.data(), arguments);
}
void Capture(waitui::WindowState& state, const std::wstring& filename) {
  RECT client{}; GetClientRect(state.window, &client); HDC dc = GetDC(state.window), memory = CreateCompatibleDC(dc);
  const auto bitmap = CreateCompatibleBitmap(dc, client.right, client.bottom); const auto old = SelectObject(memory, bitmap);
  SendMessageW(state.window, WM_PRINTCLIENT, reinterpret_cast<WPARAM>(memory), PRF_CLIENT);
  for (const auto control : {state.retry, state.close}) {
    RECT rectangle{}; GetWindowRect(control, &rectangle); MapWindowPoints(nullptr, state.window, reinterpret_cast<POINT*>(&rectangle), 2);
    const int saved = SaveDC(memory); SetViewportOrgEx(memory, rectangle.left, rectangle.top, nullptr);
    DRAWITEMSTRUCT draw{}; draw.CtlType = ODT_BUTTON; draw.CtlID = GetDlgCtrlID(control); draw.itemAction = ODA_DRAWENTIRE; draw.hwndItem = control; draw.hDC = memory; GetClientRect(control, &draw.rcItem);
    SendMessageW(state.window, WM_DRAWITEM, draw.CtlID, reinterpret_cast<LPARAM>(&draw)); RestoreDC(memory, saved);
  }
  CLSID png{0x557cf406, 0x1a04, 0x11d3, {0x9a, 0x73, 0x00, 0x00, 0xf8, 0x1e, 0xf3, 0x2e}};
  Gdiplus::Bitmap image(bitmap, nullptr); Check(image.Save(filename.c_str(), &png) == Gdiplus::Ok, "hidden native GDI painting captured");
  SelectObject(memory, old); DeleteObject(bitmap); DeleteDC(memory); ReleaseDC(state.window, dc);
}
void Measure(waitui::WindowState& state) {
  RECT area{}; GetClientRect(state.window, &area); HDC dc = GetDC(state.window);
  RECT title{0, 0, area.right - waitui::Px(state, 64), 0}; SelectObject(dc, state.title);
  DrawTextW(dc, waitui::Text(state.arguments.locale, L"waitTitle"), -1, &title, DT_CALCRECT | DT_WORDBREAK | DT_NOPREFIX);
  Check(title.bottom <= waitui::Px(state, 38), "locale title fits custom title region");
  RECT body{0, 0, area.right - waitui::Px(state, 64), 0}; SelectObject(dc, state.normal);
  DrawTextW(dc, waitui::Text(state.arguments.locale, state.messageKey.c_str()), -1, &body, DT_CALCRECT | DT_WORDBREAK | DT_NOPREFIX);
  Check(body.bottom <= area.bottom - waitui::Px(state, 226), "locale body wraps above action controls");
  for (const auto control : {state.retry, state.close}) {
    wchar_t label[128]{}; GetWindowTextW(control, label, 128); SIZE size{}; GetTextExtentPoint32W(dc, label, static_cast<int>(wcslen(label)), &size);
    RECT button{}; GetClientRect(control, &button); Check(size.cx <= button.right - waitui::Px(state, 16), "locale action label is not clipped");
  }
  ReleaseDC(state.window, dc);
}
}
int wmain(int argc, wchar_t** argv) {
  using namespace veylo::waiter;
  const auto self = ModulePath();
  if (argc == 1 && self.find(L"Synthetic target") != std::wstring::npos) {
    const auto marker = self.substr(0, self.find_last_of(L"\\/")) + L"\\child-started.txt";
    const auto file = CreateFileW(marker.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr); if (file == INVALID_HANDLE_VALUE) return 9;
    const char text[] = "argc=1\n"; DWORD written = 0; WriteFile(file, text, sizeof(text) - 1, &written, nullptr); CloseHandle(file); return 0;
  }
  if (argc != 3) return 2;
  const auto originalDesktop = GetThreadDesktop(GetCurrentThreadId());
  const auto desktopName = L"VeyloWaitFixture." + std::to_wstring(GetCurrentProcessId());
  const auto desktop = CreateDesktopW(desktopName.c_str(), nullptr, nullptr, 0, GENERIC_ALL, nullptr);
  if (!desktop || !SetThreadDesktop(desktop)) return 4;
  ULONG_PTR token = 0; Gdiplus::GdiplusStartupInput gdiplus; Gdiplus::GdiplusStartup(&token, &gdiplus, nullptr);
  try {
    const std::wstring directory = argv[1], output = argv[2];
    Check(directory.find(L"veylo-wait-native-test-") != std::wstring::npos, "fixture only uses its owned temporary root");
    const auto target = directory + L"\\Synthetic target 空格.exe", marker = directory + L"\\child-started.txt";
    Check(CopyFileW(self.c_str(), target.c_str(), TRUE), "synthetic no-window target copied inside owned root");
    Arguments parsed;
    Check(Parse({L"helper.exe", L"--locale=ja-JP", L"--target=" + Encode(target)}, parsed) && parsed.locale == 3 && parsed.target == target, "fixed locale and Base64 UTF8 absolute target parse");
    for (const auto values : std::vector<std::vector<std::wstring>>{
      {L"helper.exe", L"--locale=fr-FR", L"--target=" + Encode(target)}, {L"helper.exe", L"--locale=en-US", L"--target=" + Encode(target), L"--extra=1"},
      {L"helper.exe", L"--locale=en-US", L"--locale=zh-CN"}, {L"helper.exe", L"--locale=en-US", L"--target=%%%"},
      {L"helper.exe", L"--locale=en-US", L"--target=" + Encode(L"relative.exe")}, {L"helper.exe", L"--locale=en-US", L"--target=" + Encode(target + L" --bad")},
      {L"helper.exe", L"--locale=en-US", L"--target=" + Encode(target) + L"\n"}, {L"helper.exe", L"--locale=en-US", L"--target=//8="}})
      Check(!Parse(values, parsed), "malformed locale/flags/base64/UTF8/relative/command data rejected");
    Check(!ValidateTarget(self), "helper cannot execute its own image");
    const auto alias = directory + L"\\self-hardlink.exe"; Check(CreateHardLinkW(alias.c_str(), self.c_str(), nullptr), "owned self alias created");
    Check(!ValidateTarget(alias), "file identity also rejects a hardlink to itself"); Check(ValidateTarget(target), "independent regular MZ target accepted");
    const auto mutexName = L"Local\\Veylo.WaitFixture." + std::to_wstring(GetCurrentProcessId());
    const HANDLE mutex = CreateMutexW(nullptr, FALSE, mutexName.c_str()); Check(mutex != nullptr, "only unique Local fixture mutex created");
    Check(ProbeInstallation(mutexName.c_str()) == Installation::Active, "existing Local mutex is active without waiting or ownership");
    waitui::EnableDpi();
    const auto missing = directory + L"\\Synthetic target restored.exe";
    Check(Parse({L"helper.exe", L"--locale=en-US", L"--target=" + Encode(missing)}, parsed), "syntax-only startup accepts temporarily missing target");
    waitui::WindowState replacing; replacing.arguments = {2, missing}; replacing.mutexName = mutexName.c_str(); replacing.quitLoop = false;
    Check(waitui::CreateWaitWindow(replacing, false) && replacing.messageKey == L"waitActive", "active wait UI survives absent installed application");
    waitui::Retry(replacing); Check(IsWindow(replacing.window) && replacing.messageKey == L"waitActive", "active retry does not inspect or launch absent target"); DestroyWindow(replacing.window);
    for (int locale = 0; locale < 5; ++locale) {
      waitui::WindowState state; state.arguments = {locale, target}; state.mutexName = mutexName.c_str(); state.quitLoop = false;
      Check(waitui::CreateWaitWindow(state, false) != nullptr && !IsWindowVisible(state.window), "custom native window stays hidden/offscreen");
      Measure(state); Capture(state, output + L"\\active-" + kLocales[locale] + L".png");
      SendMessageW(state.retry, BM_CLICK, 0, 0); Check(IsWindow(state.window) && GetFileAttributesW(marker.c_str()) == INVALID_FILE_ATTRIBUTES, "active retry cannot start target");
      ShowWindow(state.window, SW_SHOWNOACTIVATE);
      SetFocus(state.retry); waitui::Key(state, VK_TAB); Check(GetFocus() == state.close, "Tab reaches custom close action");
      waitui::Key(state, VK_RETURN); Check(!IsWindow(state.window), "Enter on close exits only the wait window");
    }
    CloseHandle(mutex); Check(ProbeInstallation(mutexName.c_str()) == Installation::Inactive, "released Local mutex allows retry");
    waitui::WindowState absent; absent.arguments = {2, missing}; absent.mutexName = mutexName.c_str(); absent.quitLoop = false;
    Check(waitui::CreateWaitWindow(absent, false) != nullptr, "temporarily absent application does not prevent wait UI creation");
    waitui::Retry(absent); Check(IsWindow(absent.window) && absent.messageKey == L"waitLaunchFailed", "inactive missing target stays in custom failure UI");
    Check(CopyFileW(self.c_str(), missing.c_str(), TRUE), "installer replacement simulated only in owned fixture"); waitui::Retry(absent);
    Check(!IsWindow(absent.window), "restored target can be launched on a later retry");
    for (int i = 0; i < 200 && GetFileAttributesW(marker.c_str()) == INVALID_FILE_ATTRIBUTES; ++i) Sleep(10);
    Check(GetFileAttributesW(marker.c_str()) != INVALID_FILE_ATTRIBUTES, "restored owned target actually started"); Check(DeleteFileW(marker.c_str()), "owned child marker reset before next launch");
    const HANDLE event = CreateEventW(nullptr, TRUE, FALSE, mutexName.c_str()); Check(event != nullptr, "owned type-conflict fixture created");
    Check(ProbeInstallation(mutexName.c_str()) == Installation::Unknown, "mutex type conflict fails closed");
    waitui::WindowState unknown; unknown.arguments = {2, target}; unknown.mutexName = mutexName.c_str(); unknown.quitLoop = false; waitui::CreateWaitWindow(unknown, false);
    Check(unknown.messageKey == L"waitUnknown", "unknown status uses custom localized prompt"); Measure(unknown); Capture(unknown, output + L"\\unknown-en-US.png"); DestroyWindow(unknown.window); CloseHandle(event);
    waitui::WindowState ready; ready.arguments = {2, target}; ready.mutexName = mutexName.c_str(); ready.quitLoop = false; waitui::CreateWaitWindow(ready, false);
    Measure(ready); Capture(ready, output + L"\\ready-en-US.png");
    SetFocus(ready.retry); waitui::Key(ready, VK_RETURN); Check(!IsWindow(ready.window), "inactive retry launches fixed target and closes window");
    for (int i = 0; i < 200 && GetFileAttributesW(marker.c_str()) == INVALID_FILE_ATTRIBUTES; ++i) Sleep(10);
    Check(GetFileAttributesW(marker.c_str()) != INVALID_FILE_ATTRIBUTES, "actual CreateProcess started only owned synthetic target with argv0");
    std::printf("RESULT %d native wait checks passed\n", checks); Gdiplus::GdiplusShutdown(token); SetThreadDesktop(originalDesktop); CloseDesktop(desktop); return 0;
  } catch (const std::exception& error) { std::fprintf(stderr, "FAIL %s\n", error.what()); Gdiplus::GdiplusShutdown(token); SetThreadDesktop(originalDesktop); CloseDesktop(desktop); return 1; }
}
