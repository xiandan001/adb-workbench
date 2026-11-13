#pragma once
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <wincrypt.h>
#include <string>
#include <vector>
#include <cwctype>

namespace veylo::waiter {
constexpr wchar_t kInstallMutex[] = L"Global\\Veylo.adb-workbench.Install.v1";
constexpr const wchar_t* kLocales[] = {L"zh-CN", L"zh-TW", L"en-US", L"ja-JP", L"ko-KR"};
enum class Installation { Active, Inactive, Unknown };
struct Arguments { int locale = -1; std::wstring target; };

inline std::wstring ModulePath() {
  std::vector<wchar_t> buffer(32768);
  const DWORD length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
  return length && length < buffer.size() ? std::wstring(buffer.data(), length) : L"";
}
inline bool DecodeTarget(const std::wstring& encoded, std::wstring& target) {
  if (encoded.empty() || encoded.size() > 131072) return false;
  DWORD size = 0;
  if (!CryptStringToBinaryW(encoded.c_str(), static_cast<DWORD>(encoded.size()), CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT, nullptr, &size, nullptr, nullptr) || !size || size > 98304) return false;
  std::vector<BYTE> bytes(size);
  if (!CryptStringToBinaryW(encoded.c_str(), static_cast<DWORD>(encoded.size()), CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT, bytes.data(), &size, nullptr, nullptr)) return false;
  DWORD canonicalSize = 0;
  if (!CryptBinaryToStringW(bytes.data(), size, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &canonicalSize)) return false;
  std::vector<wchar_t> canonical(canonicalSize);
  if (!CryptBinaryToStringW(bytes.data(), size, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, canonical.data(), &canonicalSize) || encoded != canonical.data()) return false;
  const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, reinterpret_cast<const char*>(bytes.data()), static_cast<int>(size), nullptr, 0);
  if (!count || count > 32767) return false;
  target.resize(count);
  if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, reinterpret_cast<const char*>(bytes.data()), static_cast<int>(size), target.data(), count)) return false;
  const bool drive = target.size() >= 3 && iswalpha(target[0]) && target[1] == L':' && (target[2] == L'\\' || target[2] == L'/');
  const bool unc = target.size() > 5 && target.rfind(L"\\\\", 0) == 0 && target[2] != L'?' && target[2] != L'.';
  if ((!drive && !unc) || target.size() < 4 || _wcsicmp(target.c_str() + target.size() - 4, L".exe")) return false;
  for (size_t i = 0; i < target.size(); ++i)
    if (target[i] < 32 || target[i] == 127 || wcschr(L"\"<>|*?", target[i]) || (target[i] == L':' && !(drive && i == 1))) return false;
  std::vector<wchar_t> full(32768);
  const DWORD length = GetFullPathNameW(target.c_str(), static_cast<DWORD>(full.size()), full.data(), nullptr);
  if (!length || length >= full.size()) return false;
  target.assign(full.data(), length); return true;
}
inline bool ParseArguments(int argc, wchar_t** argv, Arguments& result) {
  if (argc != 3) return false;
  Arguments parsed; bool localeSeen = false, targetSeen = false;
  for (int i = 1; i < argc; ++i) {
    const std::wstring value = argv[i];
    if (value.rfind(L"--locale=", 0) == 0 && !localeSeen) {
      localeSeen = true;
      for (int j = 0; j < 5; ++j) if (value.substr(9) == kLocales[j]) parsed.locale = j;
    } else if (value.rfind(L"--target=", 0) == 0 && !targetSeen) {
      targetSeen = true; if (!DecodeTarget(value.substr(9), parsed.target)) return false;
    } else return false;
  }
  if (!localeSeen || !targetSeen || parsed.locale < 0) return false;
  result = std::move(parsed); return true;
}
inline Installation ProbeInstallation(const wchar_t* name = kInstallMutex) {
  const HANDLE mutex = OpenMutexW(SYNCHRONIZE, FALSE, name);
  if (mutex) { CloseHandle(mutex); return Installation::Active; }
  return GetLastError() == ERROR_FILE_NOT_FOUND ? Installation::Inactive : Installation::Unknown;
}
inline bool ValidateTarget(const std::wstring& target) {
  const HANDLE file = CreateFileW(target.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  BY_HANDLE_FILE_INFORMATION info{}; BYTE signature[2]{}; DWORD read = 0;
  bool valid = GetFileType(file) == FILE_TYPE_DISK && GetFileInformationByHandle(file, &info)
    && !(info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))
    && ReadFile(file, signature, 2, &read, nullptr) && read == 2 && signature[0] == 'M' && signature[1] == 'Z';
  const auto selfPath = ModulePath();
  const HANDLE self = selfPath.empty() ? INVALID_HANDLE_VALUE : CreateFileW(selfPath.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  BY_HANDLE_FILE_INFORMATION own{};
  if (self == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(self, &own)) valid = false;
  else if (info.dwVolumeSerialNumber == own.dwVolumeSerialNumber && info.nFileIndexHigh == own.nFileIndexHigh && info.nFileIndexLow == own.nFileIndexLow) valid = false;
  if (self != INVALID_HANDLE_VALUE) CloseHandle(self);
  CloseHandle(file); return valid;
}
inline bool LaunchTarget(const std::wstring& target) {
  if (!ValidateTarget(target)) return false;
  std::wstring command = L"\"" + target + L"\"";
  const auto directory = target.substr(0, target.find_last_of(L"\\/"));
  STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION child{};
  if (!CreateProcessW(target.c_str(), command.data(), nullptr, nullptr, FALSE, 0, nullptr, directory.c_str(), &startup, &child)) return false;
  CloseHandle(child.hThread); CloseHandle(child.hProcess); return true;
}
}
