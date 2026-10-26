#pragma once
#include <algorithm>
#include <cwctype>
#include <string>
#include <vector>

namespace skin {
inline std::wstring TrimPath(std::wstring value) {
  const auto first = value.find_first_not_of(L" \t\r\n");
  if (first == std::wstring::npos) return {};
  value = value.substr(first, value.find_last_not_of(L" \t\r\n") - first + 1);
  std::replace(value.begin(), value.end(), L'/', L'\\');
  while (value.size() > 3 && value.back() == L'\\') value.pop_back();
  return value;
}

inline bool SamePath(const std::wstring& left, const std::wstring& right) {
  return _wcsicmp(TrimPath(left).c_str(), TrimPath(right).c_str()) == 0;
}

// Existing registry-selected paths stay unchanged. New paths must be absolute,
// local directories; root/system locations and ambiguous Win32 components fail.
inline bool ValidInstallPath(const std::wstring& path, const std::wstring& initial,
                             const std::wstring& windowsDirectory) {
  if (path.empty() || path.size() > 220 || path.find_first_of(L"\r\n\t\"<>|?*") != std::wstring::npos) return false;
  if (path.size() < 4 || !iswalpha(path[0]) || path[1] != L':' || path[2] != L'\\') return false;
  if (path.find(L':', 2) != std::wstring::npos) return false;
  size_t offset = 3;
  while (offset < path.size()) {
    const auto end = path.find(L'\\', offset);
    const auto part = path.substr(offset, end == std::wstring::npos ? end : end - offset);
    if (part.empty() || part == L"." || part == L".." || part.back() == L'.' || part.back() == L' ') return false;
    std::wstring stem = part.substr(0, part.find(L'.'));
    std::transform(stem.begin(), stem.end(), stem.begin(), towupper);
    if (stem == L"CON" || stem == L"PRN" || stem == L"AUX" || stem == L"NUL" ||
        (stem.size() == 4 && (stem.substr(0, 3) == L"COM" || stem.substr(0, 3) == L"LPT") && stem[3] >= L'1' && stem[3] <= L'9')) return false;
    if (end == std::wstring::npos) break;
    offset = end + 1;
  }
  // Even a registered old location must pass the same lexical/system checks.
  (void)initial;
  const auto windows = TrimPath(windowsDirectory);
  if (!windows.empty() && (_wcsicmp(path.c_str(), windows.c_str()) == 0 ||
      (path.size() > windows.size() && path[windows.size()] == L'\\' && _wcsnicmp(path.c_str(), windows.c_str(), windows.size()) == 0))) return false;
  const auto relative = path.substr(3);
  return _wcsicmp(relative.c_str(), L"Program Files") != 0 &&
    _wcsicmp(relative.c_str(), L"Program Files (x86)") != 0 &&
    _wcsicmp(relative.c_str(), L"ProgramData") != 0 &&
    _wcsicmp(relative.c_str(), L"Users") != 0;
}

inline std::wstring AppendApplicationFolder(const std::wstring& selected,
                                          const std::wstring& initial,
                                          const std::wstring& folderName) {
  const auto path = TrimPath(selected);
  if (path.empty() || SamePath(path, initial) || folderName.empty()) return path;
  const auto last = path.find_last_of(L'\\');
  if (_wcsicmp(path.substr(last == std::wstring::npos ? 0 : last + 1).c_str(), folderName.c_str()) == 0) return path;
  return path + (path.back() == L'\\' ? L"" : L"\\") + folderName;
}
}
