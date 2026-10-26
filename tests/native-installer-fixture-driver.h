#pragma once

// Included by the standalone native harness; never linked into the product.
namespace qa {
DWORD fixtureProcessId = 0;
BOOL CALLBACK FindFixtureWindow(HWND window, LPARAM) {
  DWORD process = 0; GetWindowThreadProcessId(window, &process);
  if (process != fixtureProcessId) return TRUE;
  const HWND candidate = FindWindowExW(window, nullptr, L"VeyloInstallerSkin475", nullptr);
  if (candidate) { parent = window; skin = candidate; return FALSE; }
  return TRUE;
}
void FixtureClick(int id) {
  Check(IsWindowVisible(Control(id)) && IsWindowEnabled(Control(id)), "fixture action targets visible enabled control");
  PostMessageW(Control(id), BM_CLICK, 0, 0);
  Pump(150);
}
int RunFixture(const std::wstring& executable, const std::wstring& installPath, int locale, const std::wstring& action) {
  Check(executable.find(L"\\.superpowers\\") != std::wstring::npos && executable.find(L"fixture") != std::wstring::npos,
    "fixture executable is confined to test output");
  Check(installPath.find(L"\\.superpowers\\") != std::wstring::npos, "fixture payload directory is confined to test output");
  Check(action == L"install" || action == L"cancel", "fixture action explicitly selected");
  SetProcessDPIAware();
  std::wstring desktopName = L"VeyloNsisFixture-" + std::to_wstring(GetCurrentProcessId());
  HDESK desktop = CreateDesktopW(desktopName.c_str(), nullptr, nullptr, 0, GENERIC_ALL, nullptr);
  Check(desktop && SetThreadDesktop(desktop), "NSIS fixture assigned to a private desktop");
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limit{};
  limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  Check(job && SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limit, sizeof(limit)), "fixture job bounds child-process lifetime");
  STARTUPINFOW startup{}; startup.cb = sizeof(startup); startup.lpDesktop = desktopName.data();
  PROCESS_INFORMATION process{};
  std::wstring command = L"\"" + executable + L"\" /D=" + installPath;
  Check(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED, nullptr, nullptr, &startup, &process), "isolated NSIS fixture process created suspended");
  if (!AssignProcessToJobObject(job, process.hProcess)) {
    TerminateProcess(process.hProcess, 125);
    CloseHandle(process.hThread); CloseHandle(process.hProcess); CloseHandle(job);
    throw std::runtime_error("could not assign own fixture child to watchdog job");
  }
  fixtureProcessId = process.dwProcessId;
  ResumeThread(process.hThread); CloseHandle(process.hThread);
  const ULONGLONG started = GetTickCount64();
  while ((!skin || !IsWindowVisible(Control(Language))) && GetTickCount64() - started < 15000 && WaitForSingleObject(process.hProcess, 0) == WAIT_TIMEOUT) {
    EnumDesktopWindows(desktop, FindFixtureWindow, 0); Pump(100);
  }
  DWORD startupExit = 0; GetExitCodeProcess(process.hProcess, &startupExit);
  std::printf("INFO fixture startup skinFound=%d parentVisible=%d processExit=%lu\n", skin != nullptr, IsWindowVisible(parent), startupExit);
  Check(skin && IsWindowVisible(Control(Language)), "real NSIS fixture reached native welcome page");
  const int languages[] = {2052, 1028, 1033, 1041, 1042};
  int selection = -1;
  for (int index = 0; index < 5; ++index) if (languages[index] == locale) selection = index;
  Check(selection >= 0, "fixture locale is supported");
  SendMessageW(Control(Language), CB_SETCURSEL, selection, 0);
  PostMessageW(skin, WM_COMMAND, MAKEWPARAM(Language, CBN_SELCHANGE), reinterpret_cast<LPARAM>(Control(Language)));
  Pump(150);
  Screenshot(skin, L"fixture-welcome");
  if (action == L"cancel") {
    FixtureClick(Cancel);
    Check(IsWindowVisible(Control(Keep)), "real NSIS cancel opens confirmation");
    Screenshot(skin, L"fixture-cancel-confirmation");
    FixtureClick(Keep);
    Check(!IsWindowVisible(Control(Keep)) && IsWindowVisible(Control(Primary)), "real NSIS continue returns to welcome");
    FixtureClick(Cancel); FixtureClick(Exit);
  } else {
    FixtureClick(Secondary);
    SetWindowTextW(Control(Path), installPath.c_str());
    Check(Text(Control(Path)) == installPath, "real NSIS custom path editor accepted fixture-only path");
    Screenshot(skin, L"fixture-custom-path");
    FixtureClick(Primary);
    bool progressSeen = false, finished = false;
    const ULONGLONG installStarted = GetTickCount64();
    while (GetTickCount64() - installStarted < 20000 && WaitForSingleObject(process.hProcess, 0) == WAIT_TIMEOUT) {
      Pump(60);
      if (!IsWindowVisible(Control(Language)) && !IsWindowVisible(Control(Primary)) && !progressSeen) {
        progressSeen = true; Screenshot(skin, L"fixture-installing");
      }
      if (!IsWindowVisible(Control(Language)) && IsWindowVisible(Control(Primary)) && IsWindowVisible(Control(Secondary))) {
        finished = true; Screenshot(skin, L"fixture-finish"); FixtureClick(Secondary); break;
      }
    }
    if (!finished && IsWindow(skin)) {
      const HWND nativeNext = GetDlgItem(parent, IDOK);
      std::printf("INFO stalled nativeNext exists=%d enabled=%d visible=%d skinPrimary visible=%d enabled=%d\n",
        IsWindow(nativeNext), IsWindowEnabled(nativeNext), IsWindowVisible(nativeNext), IsWindowVisible(Control(Primary)), IsWindowEnabled(Control(Primary)));
      Screenshot(skin, L"fixture-stalled-after-payload");
      if (nativeNext && IsWindowEnabled(nativeNext)) {
        PostMessageW(parent, WM_COMMAND, IDOK, 0); Pump(500);
        const bool hiddenNextRequired = !IsWindowVisible(Control(Language)) && IsWindowVisible(Control(Primary)) && IsWindowVisible(Control(Secondary));
        std::printf("INFO diagnostic hidden-native-next reaches finish=%d; this does NOT count as an interactive flow pass\n", hiddenNextRequired);
        if (hiddenNextRequired) { Screenshot(skin, L"fixture-diagnostic-finish"); FixtureClick(Secondary); }
      }
    }
    Check(finished, "real NSIS welcome-install-finish transition completed");
    std::printf("INFO real NSIS install-page capture=%s (fast fixture may skip capture)\n", progressSeen ? "yes" : "no");
  }
  Check(WaitForSingleObject(process.hProcess, 10000) == WAIT_OBJECT_0, "own NSIS fixture exits after selected action");
  DWORD exitCode = 0; GetExitCodeProcess(process.hProcess, &exitCode);
  std::printf("INFO fixture process exit=%lu; receipt and payload verification belong to fixture runner\n", exitCode);
  Check(action == L"install" ? exitCode == 0 : exitCode == 1 || exitCode == 2, "NSIS fixture exit code matches install or cancel action");
  CloseHandle(process.hProcess); CloseHandle(job);
  std::printf("RESULT %d fixture-driver checks passed; production installer was not run\n", checks);
  return 0;
}
}
