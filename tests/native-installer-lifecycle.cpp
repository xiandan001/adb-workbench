#define VEYLO_INSTALLER_LIFECYCLE_TEST
#include "../build/installer-ui/installer-lifecycle.h"
#include <iostream>
#include <stdexcept>
#include <thread>

namespace {
int checks = 0;
void Check(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
  ++checks;
  std::cout << "ok " << checks << " - " << message << std::endl;
}
std::wstring Token() {
  GUID guid{};
  if (FAILED(CoCreateGuid(&guid))) throw std::runtime_error("cannot create an owned event token");
  wchar_t text[40]{};
  StringFromGUID2(guid, text, 40);
  std::wstring token;
  for (wchar_t character : text) if (iswxdigit(character)) token.push_back(static_cast<wchar_t>(towlower(character)));
  return token;
}
bool MutexExists(const std::wstring& name) {
  HANDLE handle = OpenMutexW(SYNCHRONIZE, FALSE, name.c_str());
  if (!handle) return false;
  CloseHandle(handle);
  return true;
}
std::string Read(const std::wstring& path) {
  veylo::installer::detail::Handle file(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!file.value) throw std::runtime_error("cannot read owned fixture file");
  char content[1024]{};
  DWORD bytes = 0;
  if (!ReadFile(file.value, content, sizeof(content), &bytes, nullptr)) throw std::runtime_error("cannot read fixture bytes");
  return std::string(content, bytes);
}
void Write(const std::wstring& path, const std::string& bytes) {
  veylo::installer::detail::Handle file(CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
  DWORD written = 0;
  if (!file.value || !WriteFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr)
      || written != bytes.size()) throw std::runtime_error("cannot write owned fixture bytes");
}
void ArgumentsAndReady() {
  using namespace veylo::installer;
  Check(ParseUpdateArguments(L"fixture.exe /S --updated --force-run").valid, "legacy updated arguments remain valid");
  Check(ParseUpdateArguments(L"fixture.exe /D=C:\\OwnedFixture").valid, "ordinary NSIS arguments are ignored");
  const auto token = Token();
  const auto line = L"fixture.exe --updated --veylo-ready-token=" + token + L" --veylo-update-pid=000123 --veylo-language=zh-CN";
  auto parsed = ParseUpdateArguments(line);
  Check(parsed.valid && parsed.updated && parsed.tokenProvided && parsed.token == token && parsed.parentPid == L"123" && parsed.locale == L"zh-CN",
    "the complete handoff is validated and PID normalized");
  for (const wchar_t* suffix : {L" --veylo-language=en-US", L" --veylo-ready-token", L" --veylo-unknown=x"})
    Check(!ParseUpdateArguments(line + suffix).valid, "duplicates and malformed reserved arguments are rejected");
  for (const wchar_t* pid : {L"0", L"-1", L"1;exit", L"2147483648", L"99999999999"})
    Check(!ParseUpdateArguments(L"fixture.exe --updated --veylo-ready-token=" + token + L" --veylo-update-pid=" + pid + L" --veylo-language=en-US").valid,
      "invalid or out-of-range PIDs are rejected");
  Check(!ParseUpdateArguments(L"fixture.exe --updated --veylo-ready-token=" + token).valid, "partial handoffs are rejected");
  Check(!ParseUpdateArguments(L"fixture.exe --veylo-ready-token=" + token + L" --veylo-update-pid=1 --veylo-language=en-US").valid,
    "new handoff fields require update mode");
  Check(!ParseUpdateArguments(L"fixture.exe --updated --veylo-ready-token=abcd --veylo-update-pid=1 --veylo-language=en-US").valid,
    "short or injected ready tokens are rejected");
  Check(SignalReady(ParseUpdateArguments(L"fixture.exe")), "manual setup does not require a launcher event");
  const std::wstring eventName = L"Local\\Veylo.Update.Ready." + token;
  SetLastError(ERROR_SUCCESS);
  veylo::installer::detail::Handle event(CreateEventW(nullptr, TRUE, FALSE, eventName.c_str()));
  Check(event.value && GetLastError() != ERROR_ALREADY_EXISTS, "a unique owned manual-reset event is created");
  Check(WaitForSingleObject(event.value, 0) == WAIT_TIMEOUT, "the ready event starts unsignaled");
  auto invalid = parsed; invalid.valid = false;
  Check(!SignalReady(invalid) && WaitForSingleObject(event.value, 0) == WAIT_TIMEOUT, "invalid handoff never signals readiness");
  Check(SignalReady(parsed), "valid readiness signals the already-created event");
  Check(WaitForSingleObject(event.value, 0) == WAIT_OBJECT_0 && WaitForSingleObject(event.value, 0) == WAIT_OBJECT_0,
    "the acknowledgement remains signaled for a manual-reset event");
  event.Reset();
  Check(!SignalReady(parsed), "a timed-out or absent launcher event cannot be recreated by the installer");
}
void MutexAcl(const std::wstring& name) {
  using namespace veylo::installer;
  detail::Handle mutex(OpenMutexW(READ_CONTROL, FALSE, name.c_str()));
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  Check(mutex.value && GetSecurityInfo(mutex.value, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION,
    nullptr, nullptr, &acl, nullptr, &descriptor) == ERROR_SUCCESS, "owned mutex DACL can be inspected");
  bool found = false, readOnly = true;
  for (DWORD index = 0; acl && index < acl->AceCount; ++index) {
    void* entry = nullptr;
    if (!GetAce(acl, index, &entry)) { readOnly = false; break; }
    const auto* allowed = static_cast<ACCESS_ALLOWED_ACE*>(entry);
    if (detail::SameSid(const_cast<DWORD*>(&allowed->SidStart), WinAuthenticatedUserSid)) {
      found = true; readOnly = allowed->Mask == SYNCHRONIZE;
    }
  }
  if (descriptor) LocalFree(descriptor);
  Check(found && readOnly, "authenticated users have only SYNCHRONIZE on the install mutex");
}
void GuardChecks(const veylo::installer::FixtureScope& scope) {
  using namespace veylo::installer;
  const auto marker = scope.programDataRoot + L"\\Veylo\\adb-workbench\\install-active.json";
  InstallGuard productionDefault;
  Check(productionDefault.Begin() == L"error", "test builds cannot acquire the production Global guard by accident");
  InstallGuard missingRoot(FixtureScope{L"", scope.mutexName});
  Check(missingRoot.Begin() == L"error", "an empty fixture root never falls back to production ProgramData");
  Check(!MutexExists(scope.mutexName), "no owned install guard exists before deployment");
  InstallGuard guard(scope);
  Check(guard.Begin() == L"ok" && MutexExists(scope.mutexName), "deployment creates an owned named guard");
  Check(Read(marker) == kInstallMarker, "the marker contains only the fixed version and production mutex name");
  Check(Read(marker).find("pid") == std::string::npos && Read(marker).find("path") == std::string::npos,
    "marker bytes contain no PID or user path");
  MutexAcl(scope.mutexName);
  detail::Handle directory(detail::OpenDirectory(scope.programDataRoot + L"\\Veylo\\adb-workbench"));
  Check(directory.value && detail::SafeSecurity(directory.value, detail::TestUserSid(), true), "marker directory has protected read-only authenticated-user ACL");
  directory.Reset();
  Check(!MoveFileW((scope.programDataRoot + L"\\Veylo").c_str(), (scope.programDataRoot + L"\\vendor-renamed").c_str()),
    "held directory handles prevent namespace replacement while deploying");
  InstallGuard other(scope);
  Check(other.Begin() == L"busy", "another deployment is rejected without replacing the marker");
  Check(guard.Begin() == L"ok", "the current guard begins idempotently");
  std::thread finish([&guard] { guard.End(); }); finish.join();
  Check(!MutexExists(scope.mutexName), "a different UI thread can close the unowned mutex lifetime safely");
  Check(GetFileAttributesW(marker.c_str()) == INVALID_FILE_ATTRIBUTES, "successful completion removes the owned marker");
  guard.End();
  Check(guard.Begin() == L"ok", "a later deployment accepts only the previously protected namespace");
  guard.End();
  const auto personal = scope.programDataRoot + L"\\owned-personal.txt";
  Write(personal, "owned contents must survive\n");
  Check(CreateHardLinkW(marker.c_str(), personal.c_str(), nullptr) != FALSE, "an owned hard-link rejection fixture is prepared");
  Check(guard.Begin() == L"error" && !MutexExists(scope.mutexName), "a hard-linked marker is rejected and the guard released");
  Check(Read(personal) == "owned contents must survive\n" && GetFileAttributesW(marker.c_str()) != INVALID_FILE_ATTRIBUTES,
    "rejecting an unsafe marker neither truncates its target nor deletes its entry");
}
void RejectionCheck(const veylo::installer::FixtureScope& scope) {
  veylo::installer::InstallGuard guard(scope);
  Check(guard.Begin() == L"error", "unsafe existing or reparse namespace is rejected before marker writes");
  Check(!MutexExists(scope.mutexName), "a rejected namespace does not leave the install mutex alive");
}
}

int wmain(int argc, wchar_t** argv) {
  try {
    if (argc != 4) return 2;
    const std::wstring mode(argv[1]), root(argv[2]), name(argv[3]);
    if (root.find(L"veylo-native-lifecycle-test-") == std::wstring::npos || name.rfind(L"Local\\Veylo.InstallFixture.", 0) != 0) return 2;
    const veylo::installer::FixtureScope scope{root, name};
    if (mode == L"--normal") { ArgumentsAndReady(); GuardChecks(scope); }
    else if (mode == L"--reject") RejectionCheck(scope);
    else if (mode == L"--crash") {
      veylo::installer::InstallGuard guard(scope);
      Check(guard.Begin() == L"ok", "owned crash fixture starts deployment");
      ExitProcess(0);
    } else if (mode == L"--stale") {
      Check(!MutexExists(name), "OS closes the named mutex after a process exits without disposal");
      Check(GetFileAttributesW((root + L"\\Veylo\\adb-workbench\\install-active.json").c_str()) != INVALID_FILE_ATTRIBUTES,
        "a stale marker is not evidence of an active deployment");
      veylo::installer::InstallGuard guard(scope);
      Check(guard.Begin() == L"ok", "a later owned install can recover the protected stale marker");
      guard.End();
    } else return 2;
    std::cout << "RESULT " << checks << " lifecycle checks passed" << std::endl;
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "FAIL " << error.what() << " (Win32=" << GetLastError() << ")" << std::endl;
    return 1;
  }
}
