#pragma once

// Isolated WriteUninstaller fixtures only, never a production uninstaller.
namespace qa {
int visibleFixtureWindows = 0;
int clippedNativeSamples = 0;
BOOL CALLBACK CountFixtureWindows(HWND window, LPARAM) {
  DWORD process = 0; GetWindowThreadProcessId(window, &process);
  if (process == fixtureProcessId && IsWindowVisible(window)) ++visibleFixtureWindows;
  return TRUE;
}
std::wstring RemoteText(HWND window) {
  wchar_t text[512]{}; DWORD_PTR result = 0;
  SendMessageTimeoutW(window, WM_GETTEXT, 512, reinterpret_cast<LPARAM>(text), SMTO_ABORTIFHUNG, 1000, &result);
  return text;
}
void UninstallControls() {
  for (int id : {Secondary, Browse, Path, Shortcut, Language})
    Check(!IsWindowVisible(Control(id)), "real uninstaller hides every install-only control");
}
int PaintableUninstallNativeCount() {
  int count = 0;
  HRGN region = CreateRectRgn(0, 0, 0, 0);
  for (HWND window : NativeWindows()) {
    if (!IsWindowVisible(window)) continue;
    bool clipped = false;
    // NSIS can commit WS_VISIBLE after WM_SHOWWINDOW returns. The production
    // guard keeps these engine windows unpaintable with an empty region until
    // its queued style normalization runs; child controls inherit that clipping.
    for (HWND ancestor = window; ancestor && ancestor != parent; ancestor = GetParent(ancestor)) {
      if (GetWindowRgn(ancestor, region) == NULLREGION) { clipped = true; break; }
    }
    if (!clipped) ++count;
    else ++clippedNativeSamples;
  }
  DeleteObject(region);
  return count;
}
int RunUninstallFixture(const std::wstring& executable, const std::wstring& installPath, int locale, const std::wstring& action) {
  Check(executable.find(L"\\.superpowers\\") != std::wstring::npos && executable.find(L"uninstall-fixture.exe") != std::wstring::npos, "only an owned uninstall fixture is executable");
  Check(installPath.find(L"\\.superpowers\\") != std::wstring::npos, "uninstall fixture path is confined to test output");
  Check(action == L"finish" || action == L"cancel" || action == L"fail" || action == L"silent" || action == L"updated", "uninstall fixture action is explicit");
  const bool silent = action == L"silent" || action == L"updated";
  SetProcessDPIAware();
  std::wstring desktopName = L"VeyloUninstallFixture-" + std::to_wstring(GetCurrentProcessId());
  HDESK desktop = CreateDesktopW(desktopName.c_str(), nullptr, nullptr, 0, GENERIC_ALL, nullptr);
  Check(desktop && SetThreadDesktop(desktop), "uninstall fixture uses a private desktop");
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limit{};
  limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  Check(job && SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limit, sizeof(limit)), "uninstall fixture children are bounded by an owned job");
  STARTUPINFOW startup{}; startup.cb = sizeof(startup); startup.lpDesktop = desktopName.data();
  PROCESS_INFORMATION process{};
  std::wstring command = L"\"" + executable + L"\"" + (silent ? L" /S /KEEP_APP_DATA" : L"") +
    (action == L"updated" ? L" --updated" : L"") + L" _?=" + installPath;
  Check(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED, nullptr, nullptr, &startup, &process), "owned uninstall process created suspended");
  if (!AssignProcessToJobObject(job, process.hProcess)) {
    TerminateProcess(process.hProcess, 125);
    CloseHandle(process.hThread); CloseHandle(process.hProcess); CloseHandle(job);
    throw std::runtime_error("could not assign uninstall fixture to its watchdog job");
  }
  fixtureProcessId = process.dwProcessId;
  ResumeThread(process.hThread); CloseHandle(process.hThread);
  const ULONGLONG started = GetTickCount64();
  if (silent) {
    while (WaitForSingleObject(process.hProcess, 0) == WAIT_TIMEOUT && GetTickCount64() - started < 15000) {
      EnumDesktopWindows(desktop, CountFixtureWindows, 0);
      EnumDesktopWindows(desktop, FindFixtureWindow, 0);
      Pump(15);
    }
    Check(!skin && visibleFixtureWindows == 0, "silent and updater uninstall never creates a visible window or skin");
  } else {
    while ((!skin || !IsWindowVisible(parent)) && GetTickCount64() - started < 15000 && WaitForSingleObject(process.hProcess, 0) == WAIT_TIMEOUT) {
      EnumDesktopWindows(desktop, FindFixtureWindow, 0); Pump(25);
    }
    Check(skin && IsWindowVisible(parent) && IsWindowVisible(Control(Primary)), "real BUILD_UNINSTALLER branch reaches confirmation");
    const int ids[] = {2052, 1028, 1033, 1041, 1042};
    const int selected = static_cast<int>(SendMessageW(Control(Language), CB_GETCURSEL, 0, 0));
    Check(selected >= 0 && selected < 5 && ids[selected] == locale, "uninstaller inherits the expected profile or receipt language");
    UninstallControls();
    Check(ParentEvidence(L"uninstall-confirm"), "real confirmation contains no default NSIS controls");
    if (action == L"cancel") {
      FixtureClick(Cancel); Check(WaitForFixtureControl(Keep, true), "cancel opens custom uninstall confirmation");
      Check(ParentEvidence(L"uninstall-cancel"), "custom cancel confirmation covers default controls");
      FixtureClick(Keep); Check(WaitForFixtureControl(Keep, false), "continue preserves the pending uninstall confirmation");
      FixtureClick(Cancel); FixtureClick(Exit);
    } else {
      FixtureClick(Primary);
      bool finished = false, failed = false, detailsSeen = false, clean = true;
      int lastProgress = -1, progressChanges = 0;
      const auto deadline = GetTickCount64() + 15000;
      while (IsWindow(parent) && GetTickCount64() < deadline) {
        Pump(40);
        if (PaintableUninstallNativeCount()) {
          if (clean) ParentEvidence(L"uninstall-native-overlay-failure");
          clean = false;
        }
        if (!IsWindowVisible(Control(Primary)) && IsWindowVisible(Control(Details))) {
          const int position = EngineProgress();
          if (position >= 0 && position != lastProgress) { ++progressChanges; lastProgress = position; }
          const auto close = RemoteText(Control(Cancel));
          if (action == L"fail" && (close == L"Close" || close == L"关闭" || close == L"關閉" || close == L"閉じる" || close == L"닫기")) {
            failed = true; Check(ParentEvidence(L"uninstall-failed"), "real section Abort keeps the localized failure skin");
            FixtureClick(Cancel); break;
          }
          if (!detailsSeen && action != L"fail") {
            FixtureClick(Details); Pump(100);
            Check(!RemoteDetailsText().empty(), "uninstall details come from the engine and stage history");
            Check(ParentEvidence(L"uninstall-progress-details"), "real uninstall progress has no blue-white engine overlay");
            FixtureClick(Details); detailsSeen = true;
          }
        }
        if (IsWindowVisible(Control(Primary)) && !IsWindowVisible(Control(Cancel))) {
          finished = true; UninstallControls();
          Check(ParentEvidence(L"uninstall-finish"), "stock finish SHOW hook uses the custom completion skin");
          FixtureClick(Primary); break;
        }
      }
      Check(clean, "real uninstaller never exposes original page/progress/buttons");
      Check(action == L"fail" ? failed && !finished : finished && detailsSeen && progressChanges >= 2, "uninstall outcome and genuine engine progress match the selected action");
    }
  }
  Check(WaitForSingleObject(process.hProcess, 10000) == WAIT_OBJECT_0, "owned uninstall fixture exits within its deadline");
  DWORD exitCode = 0; GetExitCodeProcess(process.hProcess, &exitCode);
  std::printf("INFO uninstall fixture action=%ls exit=%lu\n", action.c_str(), exitCode);
  WriteEvidence(L"uninstall-visibility.json", "{\"clippedNativeSamples\":" + std::to_string(clippedNativeSamples) + ",\"visibleSilentWindows\":" + std::to_string(visibleFixtureWindows) + "}\n");
  Check(action == L"cancel" ? exitCode == 1 || exitCode == 2 : action == L"fail" ? exitCode != 0 : exitCode == 0, "uninstaller exit code matches its outcome");
  CloseHandle(process.hProcess); CloseHandle(job);
  std::printf("RESULT %d actual uninstall fixture checks passed\n", checks);
  return 0;
}
}
