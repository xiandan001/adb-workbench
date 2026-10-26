#include <windows.h>
#include <iostream>
#include <string>
#include <vector>

int wmain(int argc, wchar_t** argv) {
  if (argc == 3 && std::wstring(argv[1]) == L"--style") {
    HWND window = reinterpret_cast<HWND>(_wcstoui64(argv[2], nullptr, 10));
    if (!IsWindow(window)) return 2;
    const LONG_PTR style = GetWindowLongPtrW(window, GWL_EXSTYLE);
    BYTE alpha = 0; COLORREF color = 0; DWORD flags = 0;
    const BOOL attributes = GetLayeredWindowAttributes(window, &color, &alpha, &flags);
    std::cout << "{\"exStyle\":" << style << ",\"layered\":" << ((style & WS_EX_LAYERED) ? "true" : "false")
      << ",\"hasAlpha\":" << (attributes ? "true" : "false") << ",\"alpha\":" << static_cast<int>(alpha) << "}\n";
    return 0;
  }
  if (argc != 5) return 2;
  std::wstring desktopName = L"VeyloRestoreFixture" + std::to_wstring(GetCurrentProcessId());
  HDESK desktop = CreateDesktopW(desktopName.c_str(), nullptr, nullptr, 0, GENERIC_ALL, nullptr);
  if (!desktop) return 3;
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return 4;
  std::wstring command = L"\"" + std::wstring(argv[1]) + L"\" \"" + argv[2] + L"\" \"" + argv[3] + L"\" \"" + argv[4] + L"\"";
  std::vector<wchar_t> mutableCommand(command.begin(), command.end()); mutableCommand.push_back(0);
  STARTUPINFOW startup{}; startup.cb = sizeof(startup); startup.lpDesktop = desktopName.data();
  PROCESS_INFORMATION process{};
  BOOL created = CreateProcessW(argv[1], mutableCommand.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED,
    nullptr, argv[3], &startup, &process);
  if (!created || !AssignProcessToJobObject(job, process.hProcess)) {
    if (created) TerminateProcess(process.hProcess, 5);
    CloseHandle(job); CloseDesktop(desktop); return 5;
  }
  ResumeThread(process.hThread); CloseHandle(process.hThread);
  const DWORD waited = WaitForSingleObject(process.hProcess, 90000);
  DWORD exitCode = 6;
  if (waited == WAIT_OBJECT_0) GetExitCodeProcess(process.hProcess, &exitCode);
  CloseHandle(job); CloseHandle(process.hProcess); CloseDesktop(desktop);
  return static_cast<int>(exitCode);
}
