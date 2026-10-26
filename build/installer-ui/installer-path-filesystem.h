#pragma once
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include "installer-path.h"

namespace skin {
inline bool MissingPathError(DWORD error) {
  return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND;
}

// Read-only, fail-closed guard. A new target may be absent or empty, never an
// existing user's folder. Reject junctions/symlinks in every existing component
// even for an explicitly trusted previous install, preventing out-of-tree writes.
inline bool SafeInstallDirectory(const std::wstring& path, bool trustedExisting) {
  if (path.size() < 4) return false;
  const UINT drive = GetDriveTypeW(path.substr(0, 3).c_str());
  if (drive == DRIVE_UNKNOWN || drive == DRIVE_NO_ROOT_DIR || drive == DRIVE_REMOTE) return false;
  size_t offset = 3;
  while (offset <= path.size()) {
    const auto separator = path.find(L'\\', offset);
    const auto prefix = path.substr(0, separator == std::wstring::npos ? path.size() : separator);
    const DWORD attributes = GetFileAttributesW(prefix.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) {
      if (!MissingPathError(GetLastError())) return false;
      // All previous components were readable plain directories. A missing
      // component makes the final new target absent; no files are inspected.
      return !trustedExisting;
    }
    if (!(attributes & FILE_ATTRIBUTE_DIRECTORY) || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) return false;
    if (separator == std::wstring::npos) break;
    offset = separator + 1;
  }
  if (trustedExisting) return true;
  WIN32_FIND_DATAW entry{};
  HANDLE search = FindFirstFileW((path + L"\\*").c_str(), &entry);
  if (search == INVALID_HANDLE_VALUE) return GetLastError() == ERROR_FILE_NOT_FOUND;
  bool empty = true, readable = true;
  do {
    if (wcscmp(entry.cFileName, L".") != 0 && wcscmp(entry.cFileName, L"..") != 0) { empty = false; break; }
    if (!FindNextFileW(search, &entry)) { readable = GetLastError() == ERROR_NO_MORE_FILES; break; }
  } while (true);
  FindClose(search);
  return empty && readable;
}
}
