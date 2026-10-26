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
  DWORD_PTR result = 0;
  Check(SendMessageTimeoutW(Control(id), BM_CLICK, 0, 0, SMTO_ABORTIFHUNG, 1500, &result) != 0, "fixture button click is acknowledged by its GUI thread");
  Pump(80);
}
bool WaitForFixtureControl(int id, bool visible) {
  const ULONGLONG deadline = GetTickCount64() + 1500;
  while ((IsWindowVisible(Control(id)) != FALSE) != visible && GetTickCount64() < deadline) Pump(25);
  return (IsWindowVisible(Control(id)) != FALSE) == visible;
}
int EngineProgress() {
  for (HWND window : NativeWindows()) {
    wchar_t name[128]{}; GetClassNameW(window, name, 128);
    if (_wcsicmp(name, PROGRESS_CLASSW) != 0) continue;
    DWORD_PTR position = 0, high = 0, low = 0;
    if (SendMessageTimeoutW(window, PBM_GETPOS, 0, 0, SMTO_ABORTIFHUNG, 100, &position) &&
        SendMessageTimeoutW(window, PBM_GETRANGE, FALSE, 0, SMTO_ABORTIFHUNG, 100, &high) &&
        SendMessageTimeoutW(window, PBM_GETRANGE, TRUE, 0, SMTO_ABORTIFHUNG, 100, &low) && high > low)
      return static_cast<int>((position - low) * 100 / (high - low));
  }
  return -1;
}
bool EngineCheckpointActive(const std::wstring& installPath) {
  return GetFileAttributesW((installPath + L"\\qa-progress-checkpoint.txt").c_str()) != INVALID_FILE_ATTRIBUTES;
}
void ObserveInstallation(const std::wstring& installPath, bool cleanEntry = true) {
  bool progressSeen = false, finished = false;
  bool overlayObserved = !cleanEntry, overlayCaptured = false, progressPaintingMatched = true;
  int lastProgress = -2, progressChanges = 0, frames = 0, capturedPosition = -2, stableMeasurements = 0;
  std::string trace = "[\n";
  const ULONGLONG started = GetTickCount64();
  ULONGLONG stableSince = started;
  while (GetTickCount64() - started < 20000 && IsWindow(parent)) {
    Pump(35);
    if (VisibleNativeCount()) {
      overlayObserved = true;
      if (!overlayCaptured) { ParentEvidence(L"native-overlay-failure"); overlayCaptured = true; }
    }
    if (!IsWindowVisible(Control(Language)) && !IsWindowVisible(Control(Primary))) {
      progressSeen = true;
      const int position = EngineProgress();
      const bool checkpointActive = EngineCheckpointActive(installPath);
      if (!checkpointActive) stableSince = GetTickCount64();
      if (position >= 0 && position != lastProgress) {
        if (progressChanges) trace += ",\n";
        trace += "  {\"elapsedMs\":" + std::to_string(GetTickCount64() - started) + ",\"nativePercent\":" + std::to_string(position) + "}";
        ++progressChanges; lastProgress = position; stableSince = GetTickCount64();
      }
      if (checkpointActive && position >= 0 && position != capturedPosition && GetTickCount64() - stableSince >= 250 && frames < 6) {
        int painted = -1;
        if (!ParentEvidence(L"fixture-installing-" + std::to_wstring(frames++), &painted)) overlayObserved = true;
        const int after = EngineProgress();
        const bool stable = after == position && EngineCheckpointActive(installPath);
        const bool matched = std::abs(painted - position) <= 2;
        if (stable) { ++stableMeasurements; capturedPosition = position; progressPaintingMatched = progressPaintingMatched && matched; }
        std::printf("INFO stable engine progress before=%d after=%d actual whole-parent painted=%d stable=%d matched=%d\n", position, after, painted, stable, matched);
      }
    }
    if (!IsWindowVisible(Control(Language)) && IsWindowVisible(Control(Primary)) && IsWindowVisible(Control(Secondary))) {
      finished = true;
      if (!ParentEvidence(L"fixture-finish")) overlayObserved = true;
      FixtureClick(Secondary); break;
    }
  }
  WriteEvidence(L"engine-progress.json", trace + "\n]\n");
  Check(progressSeen, "actual NSIS install page was observed");
  Check(progressChanges >= 2, "actual NSIS progress changed during payload extraction and engine execution");
  Check(finished, "real NSIS install automatically reaches finish and Later exits");
  Check(!overlayObserved, "whole installer parent never exposes native page/progress/list/buttons, including actual File extraction");
  Check(stableMeasurements >= 2, "at least two actual engine progress positions were stable for a full refresh interval");
  Check(progressPaintingMatched, "custom progress pixels in the whole parent follow actual NSIS PBM positions");
}
int RunFixture(const std::wstring& executable, const std::wstring& installPath, int locale, const std::wstring& action) {
  Check(executable.find(L"\\.superpowers\\") != std::wstring::npos && executable.find(L"fixture") != std::wstring::npos, "fixture executable is confined to test output");
  Check(installPath.find(L"\\.superpowers\\") != std::wstring::npos, "fixture payload directory is confined to test output");
  Check(action == L"install" || action == L"cancel" || action == L"updated", "fixture action explicitly selected");
  const bool updated = action == L"updated";
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
  std::wstring command = L"\"" + executable + (updated ? L"\" --updated /D=" : L"\" /D=") + installPath;
  Check(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED, nullptr, nullptr, &startup, &process), "isolated NSIS fixture process created suspended");
  if (!AssignProcessToJobObject(job, process.hProcess)) {
    TerminateProcess(process.hProcess, 125);
    CloseHandle(process.hThread); CloseHandle(process.hProcess); CloseHandle(job);
    throw std::runtime_error("could not assign own fixture child to watchdog job");
  }
  fixtureProcessId = process.dwProcessId;
  ResumeThread(process.hThread); CloseHandle(process.hThread);
  const ULONGLONG started = GetTickCount64();
  while ((!skin || !IsWindowVisible(parent) || (!updated && !IsWindowVisible(Control(Language)))) && GetTickCount64() - started < 15000 && WaitForSingleObject(process.hProcess, 0) == WAIT_TIMEOUT) {
    EnumDesktopWindows(desktop, FindFixtureWindow, 0); Pump(30);
  }
  Check(skin && IsWindowVisible(parent), "real NSIS fixture reached a visible native skin");
  const int expectedLanguageIds[] = {2052, 1028, 1033, 1041, 1042};
  const int initialSelection = static_cast<int>(SendMessageW(Control(Language), CB_GETCURSEL, 0, 0));
  const int initialLanguage = initialSelection >= 0 && initialSelection < 5 ? expectedLanguageIds[initialSelection] : -1;
  std::printf("INFO initial native skin language=%d expected=%d\n", initialLanguage, locale);
  if (updated) {
    Check(!IsWindowVisible(Control(Language)), "--updated truly skips the welcome page");
    const bool cleanEntry = ParentEvidence(L"fixture-updated-entry");
    ObserveInstallation(installPath, cleanEntry);
    Check(initialLanguage == locale, "--updated preserves the expected profile or updater locale without a welcome interaction");
  } else {
    Check(IsWindowVisible(Control(Language)), "fresh installer starts at welcome");
    const int languages[] = {2052, 1028, 1033, 1041, 1042};
    int selection = -1;
    for (int index = 0; index < 5; ++index) if (languages[index] == locale) selection = index;
    Check(selection >= 0, "fixture locale is supported");
    SendMessageW(Control(Language), CB_SETCURSEL, selection, 0);
    PostMessageW(skin, WM_COMMAND, MAKEWPARAM(Language, CBN_SELCHANGE), reinterpret_cast<LPARAM>(Control(Language)));
    Pump(80);
    Check(ParentEvidence(L"fixture-welcome"), "whole welcome installer contains no visible native controls");
    if (action == L"cancel") {
      FixtureClick(Cancel);
      Check(WaitForFixtureControl(Keep, true), "real NSIS cancel opens confirmation");
      Check(ParentEvidence(L"fixture-cancel-confirmation"), "whole cancel confirmation contains no visible native controls");
      FixtureClick(Keep);
      Check(WaitForFixtureControl(Keep, false) && IsWindowVisible(Control(Primary)), "real NSIS continue returns to welcome");
      FixtureClick(Cancel); FixtureClick(Exit);
    } else {
      FixtureClick(Secondary);
      SetWindowTextW(Control(Path), installPath.c_str());
      Check(Text(Control(Path)) == installPath, "real NSIS custom path remains fixture-only");
      Check(ParentEvidence(L"fixture-custom-path"), "whole custom-path page contains no visible native controls");
      FixtureClick(Primary); ObserveInstallation(installPath);
    }
  }
  Check(WaitForSingleObject(process.hProcess, 10000) == WAIT_OBJECT_0, "own NSIS fixture exits after selected action");
  DWORD exitCode = 0; GetExitCodeProcess(process.hProcess, &exitCode);
  std::printf("INFO fixture process exit=%lu; receipt and payload verification belong to fixture runner\n", exitCode);
  Check(action == L"cancel" ? exitCode == 1 || exitCode == 2 : exitCode == 0, "NSIS fixture exit code matches action");
  CloseHandle(process.hProcess); CloseHandle(job);
  std::printf("RESULT %d fixture-driver checks passed; whole parent was inspected and production installer was not run\n", checks);
  return 0;
}
}
