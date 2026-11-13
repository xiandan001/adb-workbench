#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <objbase.h>
#include <cstdio>
#include <cwctype>
#include <string>
#include <vector>
#include <stdexcept>

std::wstring Quote(const std::wstring& value) { return L"\"" + value + L"\""; }
std::wstring Token() {
  GUID value{}; wchar_t text[40]{};
  if (FAILED(CoCreateGuid(&value)) || !StringFromGUID2(value, text, 40)) throw std::runtime_error("owned event token failed");
  std::wstring token;
  for (wchar_t character : text) if (iswxdigit(character)) token.push_back(static_cast<wchar_t>(towlower(character)));
  return token;
}
int wmain(int argc, wchar_t** argv) {
  try {
    if (argc != 7) return 2;
    const std::wstring root(argv[1]), executable(argv[2]), name(argv[3]), phase(argv[4]), mode(argv[6]);
    const int show = _wtoi(argv[5]);
    if (root.find(L"veylo-ready-lifecycle-test-") == std::wstring::npos || executable.rfind(root + L"\\", 0) != 0
        || executable.find(L"ready-runtime-fixture.exe") == std::wstring::npos || (show != 0 && show != 2 && show != 10)) return 2;
    const std::wstring desktopName = L"VeyloReadyRuntime-" + std::to_wstring(GetCurrentProcessId());
    HDESK desktop = CreateDesktopW(desktopName.c_str(), nullptr, nullptr, 0, GENERIC_ALL, nullptr);
    if (!desktop) throw std::runtime_error("private desktop failed");
    std::wstring token = Token();
    if (mode == L"invalid") token.pop_back();
    const std::wstring eventName = L"Local\\Veylo.Update.Ready." + token;
    HANDLE event = nullptr;
    if (mode == L"valid" || mode == L"expired") {
      SetLastError(0); event = CreateEventW(nullptr, TRUE, FALSE, eventName.c_str());
      if (!event || GetLastError() == ERROR_ALREADY_EXISTS) throw std::runtime_error("nonunique owned event");
      if (mode == L"expired") { CloseHandle(event); event = nullptr; }
    }
    std::wstring command = Quote(executable) + L" --fixture-case=" + name + L" --fixture-phase=" + phase;
    if (mode != L"none") command += L" --updated --veylo-ready-token=" + token + L" --veylo-update-pid="
      + std::to_wstring(GetCurrentProcessId()) + L" --veylo-language=en-US";
    std::vector<wchar_t> mutableCommand(command.begin(), command.end()); mutableCommand.push_back(0);
    STARTUPINFOW startup{}; startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESHOWWINDOW;
    startup.wShowWindow = static_cast<WORD>(show); startup.lpDesktop = const_cast<wchar_t*>(desktopName.c_str());
    PROCESS_INFORMATION child{};
    if (!CreateProcessW(executable.c_str(), mutableCommand.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
        nullptr, root.c_str(), &startup, &child)) throw std::runtime_error("owned NSIS fixture could not start");
    CloseHandle(child.hThread);
    const DWORD waited = WaitForSingleObject(child.hProcess, 15000);
    if (waited != WAIT_OBJECT_0) { TerminateProcess(child.hProcess, 124); WaitForSingleObject(child.hProcess, 3000); }
    DWORD exitCode = 125; GetExitCodeProcess(child.hProcess, &exitCode); CloseHandle(child.hProcess);
    bool signaled = event && WaitForSingleObject(event, 0) == WAIT_OBJECT_0;
    if (event) CloseHandle(event);
    HANDLE absent = mode == L"missing" || mode == L"expired" || mode == L"invalid" ? OpenEventW(SYNCHRONIZE, FALSE, eventName.c_str()) : nullptr;
    const bool recreated = absent != nullptr; if (absent) CloseHandle(absent);
    CloseDesktop(desktop);
    std::printf("{\"exitCode\":%lu,\"requestedShow\":%d,\"eventSignaled\":%s,\"missingEventRecreated\":%s,\"privateDesktop\":true,\"realInstaller\":false}\n",
      exitCode, show, signaled ? "true" : "false", recreated ? "true" : "false");
    return waited == WAIT_OBJECT_0 && exitCode == 0 ? 0 : 1;
  } catch (const std::exception& error) { std::fprintf(stderr, "FAIL %s (Win32=%lu)\n", error.what(), GetLastError()); return 1; }
}
