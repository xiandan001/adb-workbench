#pragma once
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <shellapi.h>
#include <shlobj.h>
#include <algorithm>
#include <cwctype>
#include <mutex>
#include <string>
#include <vector>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "uuid.lib")

namespace veylo::installer {
inline constexpr wchar_t kInstallMutex[] = L"Global\\Veylo.adb-workbench.Install.v1";
inline constexpr char kInstallMarker[] = "{\"version\":1,\"mutex\":\"Global\\\\Veylo.adb-workbench.Install.v1\"}\n";

struct UpdateArguments {
  bool valid = true, updated = false, tokenProvided = false;
  std::wstring token, parentPid, locale;
};

inline bool SupportedLocale(const std::wstring& locale) {
  return locale == L"zh-CN" || locale == L"zh-TW" || locale == L"en-US" || locale == L"ja-JP" || locale == L"ko-KR";
}

inline UpdateArguments ParseUpdateArguments(const std::wstring& commandLine) {
  UpdateArguments result;
  int count = 0;
  wchar_t** arguments = CommandLineToArgvW(commandLine.c_str(), &count);
  if (!arguments || commandLine.size() > 32768) { if (arguments) LocalFree(arguments); result.valid = false; return result; }
  bool seen[3]{};
  const wchar_t* keys[] = {L"--veylo-ready-token=", L"--veylo-update-pid=", L"--veylo-language="};
  for (int index = 1; index < count; ++index) {
    const std::wstring argument(arguments[index]);
    if (argument == L"--updated") { result.updated = true; continue; }
    if (argument.rfind(L"--veylo-", 0) != 0) continue;
    int field = -1;
    for (int candidate = 0; candidate < 3; ++candidate)
      if (argument.rfind(keys[candidate], 0) == 0) field = candidate;
    if (field < 0 || seen[field]) { result.valid = false; continue; }
    seen[field] = true;
    const std::wstring value = argument.substr(wcslen(keys[field]));
    if (field == 0) {
      result.tokenProvided = true;
      result.token = value;
      if (value.size() != 32 || !std::all_of(value.begin(), value.end(), [](wchar_t character) {
        return (character >= L'0' && character <= L'9') || (character >= L'a' && character <= L'f') || (character >= L'A' && character <= L'F');
      })) result.valid = false;
      std::transform(result.token.begin(), result.token.end(), result.token.begin(), [](wchar_t character) { return static_cast<wchar_t>(towlower(character)); });
    } else if (field == 1) {
      unsigned long long pid = 0;
      if (value.empty() || value.size() > 10) result.valid = false;
      for (wchar_t character : value) {
        if (character < L'0' || character > L'9') { result.valid = false; break; }
        pid = pid * 10 + character - L'0';
      }
      if (pid == 0 || pid > 2147483647ull) result.valid = false;
      result.parentPid = std::to_wstring(pid);
    } else {
      result.locale = value;
      if (!SupportedLocale(value)) result.valid = false;
    }
  }
  LocalFree(arguments);
  if ((seen[0] || seen[1] || seen[2]) && (!result.updated || !seen[0] || !seen[1] || !seen[2])) result.valid = false;
  return result;
}

// The caller must show and paint its custom window before acknowledging it.
inline bool SignalReady(const UpdateArguments& arguments) {
  if (!arguments.valid) return false;
  if (!arguments.tokenProvided) return true;
  const std::wstring name = L"Local\\Veylo.Update.Ready." + arguments.token;
  HANDLE event = OpenEventW(EVENT_MODIFY_STATE, FALSE, name.c_str());
  if (!event) return false;
  const bool signaled = SetEvent(event) != FALSE;
  CloseHandle(event);
  return signaled;
}

namespace detail {
class Handle {
 public:
  HANDLE value = nullptr;
  Handle() = default;
  explicit Handle(HANDLE initial) : value(initial == INVALID_HANDLE_VALUE ? nullptr : initial) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  ~Handle() { Reset(); }
  void Reset(HANDLE replacement = nullptr) { if (value) CloseHandle(value); value = replacement == INVALID_HANDLE_VALUE ? nullptr : replacement; }
};

class Descriptor {
 public:
  PSECURITY_DESCRIPTOR value = nullptr;
  ~Descriptor() { if (value) LocalFree(value); }
  bool Parse(const std::wstring& text) {
    return ConvertStringSecurityDescriptorToSecurityDescriptorW(text.c_str(), SDDL_REVISION_1, &value, nullptr) != FALSE;
  }
};

inline bool SameSid(PSID sid, WELL_KNOWN_SID_TYPE type) {
  BYTE known[SECURITY_MAX_SID_SIZE]{};
  DWORD size = sizeof(known);
  return sid && CreateWellKnownSid(type, nullptr, known, &size) && EqualSid(sid, known);
}

#ifdef VEYLO_INSTALLER_LIFECYCLE_TEST
inline std::wstring TestUserSid() {
  Handle token;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value)) return {};
  DWORD size = 0;
  GetTokenInformation(token.value, TokenUser, nullptr, 0, &size);
  std::vector<BYTE> buffer(size);
  if (!size || !GetTokenInformation(token.value, TokenUser, buffer.data(), size, &size)) return {};
  wchar_t* text = nullptr;
  if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(buffer.data())->User.Sid, &text)) return {};
  const std::wstring result(text);
  LocalFree(text);
  return result;
}
#endif

inline std::wstring SecurityText(bool directory, bool mutex, const std::wstring& fixtureSid) {
  const std::wstring inherit = directory ? L"OICI" : L"";
  const std::wstring full = mutex ? L"GA" : L"FA";
  const std::wstring read = mutex ? L"0x00100000" : directory ? L"FRFX" : L"FR";
  std::wstring result = fixtureSid.empty() ? L"O:BAG:BAD:P" : L"D:P";
  result += L"(A;" + inherit + L";" + full + L";;;SY)(A;" + inherit + L";" + full + L";;;BA)(A;" + inherit + L";" + read + L";;;AU)";
  if (!fixtureSid.empty()) result += L"(A;" + inherit + L";" + full + L";;;" + fixtureSid + L")";
  return result;
}

inline bool SafeSecurity(HANDLE handle, const std::wstring& fixtureSid, bool directory) {
  PSID owner = nullptr;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &owner, nullptr, &acl, nullptr, &descriptor) != ERROR_SUCCESS) return false;
  PSID testOwner = nullptr;
  if (!fixtureSid.empty()) ConvertStringSidToSidW(fixtureSid.c_str(), &testOwner);
  SECURITY_DESCRIPTOR_CONTROL control{};
  DWORD revision = 0;
  bool safe = descriptor && GetSecurityDescriptorControl(descriptor, &control, &revision)
    && (control & SE_DACL_PROTECTED) && acl && IsValidAcl(acl)
    && (SameSid(owner, WinLocalSystemSid) || SameSid(owner, WinBuiltinAdministratorsSid) || (testOwner && EqualSid(owner, testOwner)));
  bool system = false, administrators = false, readers = false;
  for (DWORD index = 0; safe && index < acl->AceCount; ++index) {
    void* entry = nullptr;
    if (!GetAce(acl, index, &entry)) { safe = false; break; }
    const auto* header = static_cast<ACE_HEADER*>(entry);
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE || (header->AceFlags & INHERITED_ACE)) { safe = false; break; }
    const auto* allowed = static_cast<ACCESS_ALLOWED_ACE*>(entry);
    PSID principal = const_cast<DWORD*>(&allowed->SidStart);
    if (SameSid(principal, WinLocalSystemSid)) system = (allowed->Mask & FILE_ALL_ACCESS) == FILE_ALL_ACCESS;
    else if (SameSid(principal, WinBuiltinAdministratorsSid)) administrators = (allowed->Mask & FILE_ALL_ACCESS) == FILE_ALL_ACCESS;
    else if (SameSid(principal, WinAuthenticatedUserSid)) {
      const DWORD permitted = FILE_GENERIC_READ | (directory ? FILE_GENERIC_EXECUTE : 0);
      readers = (allowed->Mask & FILE_GENERIC_READ) == FILE_GENERIC_READ;
      safe = (allowed->Mask & ~permitted) == 0;
    } else if (!(testOwner && EqualSid(principal, testOwner))) safe = false;
  }
  if (testOwner) LocalFree(testOwner);
  if (descriptor) LocalFree(descriptor);
  return safe && system && administrators && readers;
}

inline bool PlainAbsoluteDirectory(const std::wstring& path) {
  if (path.size() < 4 || path[1] != L':' || path[2] != L'\\') return false;
  const UINT drive = GetDriveTypeW(path.substr(0, 3).c_str());
  if (drive == DRIVE_UNKNOWN || drive == DRIVE_NO_ROOT_DIR || drive == DRIVE_REMOTE) return false;
  std::size_t offset = 3;
  while (offset <= path.size()) {
    const auto separator = path.find(L'\\', offset);
    const auto prefix = path.substr(0, separator == std::wstring::npos ? path.size() : separator);
    const DWORD attributes = GetFileAttributesW(prefix.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES || !(attributes & FILE_ATTRIBUTE_DIRECTORY) || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) return false;
    if (separator == std::wstring::npos) return true;
    offset = separator + 1;
  }
  return false;
}

inline HANDLE OpenDirectory(const std::wstring& path) {
  HANDLE handle = CreateFileW(path.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY,
    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (handle == INVALID_HANDLE_VALUE) return nullptr;
  BY_HANDLE_FILE_INFORMATION information{};
  if (!GetFileInformationByHandle(handle, &information) || !(information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
      || (information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) { CloseHandle(handle); return nullptr; }
  return handle;
}

inline std::wstring ProgramData() {
  wchar_t* folder = nullptr;
  if (FAILED(SHGetKnownFolderPath(FOLDERID_ProgramData, KF_FLAG_DEFAULT, nullptr, &folder))) return {};
  std::wstring result(folder);
  CoTaskMemFree(folder);
  while (!result.empty() && result.back() == L'\\') result.pop_back();
  return result;
}
}

#ifdef VEYLO_INSTALLER_LIFECYCLE_TEST
struct FixtureScope { std::wstring programDataRoot, mutexName; };
#endif

class InstallGuard {
 public:
  InstallGuard() = default;
  InstallGuard(const InstallGuard&) = delete;
  InstallGuard& operator=(const InstallGuard&) = delete;
  ~InstallGuard() { End(); }
#ifdef VEYLO_INSTALLER_LIFECYCLE_TEST
  explicit InstallGuard(const FixtureScope& fixture) : root_(fixture.programDataRoot), name_(fixture.mutexName), fixtureSid_(detail::TestUserSid()) {
    fixtureValid_ = root_.find(L"veylo-native-lifecycle-test-") != std::wstring::npos
      && name_.rfind(L"Local\\Veylo.InstallFixture.", 0) == 0 && !fixtureSid_.empty();
  }
#endif
  std::wstring Begin() {
    std::lock_guard<std::mutex> lock(lock_);
    if (mutex_.value) return L"ok";
#ifdef VEYLO_INSTALLER_LIFECYCLE_TEST
    if (!fixtureValid_) return L"error";
#endif
    const auto root = root_.empty() ? detail::ProgramData() : root_;
    if (!detail::PlainAbsoluteDirectory(root)) return L"error";
    detail::Descriptor mutexSecurity;
    if (!mutexSecurity.Parse(detail::SecurityText(false, true, fixtureSid_))) return L"error";
    SECURITY_ATTRIBUTES attributes{sizeof(attributes), mutexSecurity.value, FALSE};
    SetLastError(ERROR_SUCCESS);
    mutex_.Reset(CreateMutexW(&attributes, FALSE, name_.c_str()));
    const DWORD created = GetLastError();
    if (!mutex_.value) return L"error";
    if (created == ERROR_ALREADY_EXISTS) { Reset(); return L"busy"; }
    base_.Reset(detail::OpenDirectory(root));
    if (!base_.value || !SecureDirectory(root + L"\\Veylo", vendor_) || !SecureDirectory(root + L"\\Veylo\\adb-workbench", application_)) {
      Reset(); return L"error";
    }
    if (!CreateMarker(root + L"\\Veylo\\adb-workbench\\install-active.json")) { Reset(); return L"error"; }
    return L"ok";
  }
  void End() { std::lock_guard<std::mutex> lock(lock_); Reset(); }

 private:
  std::mutex lock_;
  detail::Handle mutex_, base_, vendor_, application_, marker_;
  std::wstring root_, name_ = kInstallMutex, fixtureSid_;
  bool deleteMarker_ = false;
#ifdef VEYLO_INSTALLER_LIFECYCLE_TEST
  bool fixtureValid_ = false;
#endif
  bool SecureDirectory(const std::wstring& path, detail::Handle& handle) {
    detail::Descriptor security;
    if (!security.Parse(detail::SecurityText(true, false, fixtureSid_))) return false;
    SECURITY_ATTRIBUTES attributes{sizeof(attributes), security.value, FALSE};
    if (!CreateDirectoryW(path.c_str(), &attributes) && GetLastError() != ERROR_ALREADY_EXISTS) return false;
    handle.Reset(detail::OpenDirectory(path));
    return handle.value && detail::SafeSecurity(handle.value, fixtureSid_, true);
  }
  bool CreateMarker(const std::wstring& path) {
    detail::Descriptor security;
    if (!security.Parse(detail::SecurityText(false, false, fixtureSid_))) return false;
    SECURITY_ATTRIBUTES attributes{sizeof(attributes), security.value, FALSE};
    marker_.Reset(CreateFileW(path.c_str(), GENERIC_WRITE | DELETE | READ_CONTROL, FILE_SHARE_READ,
      &attributes, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!marker_.value) return false;
    BY_HANDLE_FILE_INFORMATION information{};
    if (GetFileType(marker_.value) != FILE_TYPE_DISK || !GetFileInformationByHandle(marker_.value, &information)
        || (information.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))
        || information.nNumberOfLinks != 1 || !detail::SafeSecurity(marker_.value, fixtureSid_, false)) return false;
    deleteMarker_ = true;
    LARGE_INTEGER start{};
    DWORD written = 0;
    return SetFilePointerEx(marker_.value, start, nullptr, FILE_BEGIN) && SetEndOfFile(marker_.value)
      && WriteFile(marker_.value, kInstallMarker, sizeof(kInstallMarker) - 1, &written, nullptr)
      && written == sizeof(kInstallMarker) - 1 && FlushFileBuffers(marker_.value);
  }
  void Reset() {
    if (marker_.value && deleteMarker_) {
      FILE_DISPOSITION_INFO deletion{TRUE};
      SetFileInformationByHandle(marker_.value, FileDispositionInfo, &deletion, sizeof(deletion));
    }
    marker_.Reset(); deleteMarker_ = false;
    application_.Reset(); vendor_.Reset(); base_.Reset(); mutex_.Reset();
  }
};
}
