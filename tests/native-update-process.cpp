#include <windows.h>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

int wmain(int argc, wchar_t** argv) {
  if (argc == 3 && std::wstring(argv[1]) == L"--short-path") {
    const DWORD size = GetShortPathNameW(argv[2], nullptr, 0);
    if (!size) return 2;
    std::vector<wchar_t> shortPath(size);
    const DWORD length = GetShortPathNameW(argv[2], shortPath.data(), size);
    if (!length || length >= size) return 2;
    const int bytes = WideCharToMultiByte(CP_UTF8, 0, shortPath.data(), length, nullptr, 0, nullptr, nullptr);
    std::string output(bytes, '\0');
    WideCharToMultiByte(CP_UTF8, 0, shortPath.data(), length, output.data(), bytes, nullptr, nullptr);
    std::cout << output << std::endl;
    return 0;
  }
  if (argc != 3) return 2;
  const std::wstring mode(argv[1]);
  if (mode != L"--wait-ms" && mode != L"--gate") return 2;
  std::cout << GetCurrentProcessId() << std::endl;
  if (mode == L"--wait-ms") {
    const unsigned long duration = wcstoul(argv[2], nullptr, 10);
    if (duration > 60000) return 2;
    Sleep(duration);
    return 0;
  }
  const ULONGLONG deadline = GetTickCount64() + 60000;
  while (GetFileAttributesW(argv[2]) == INVALID_FILE_ATTRIBUTES) {
    if (GetTickCount64() >= deadline) return 3;
    Sleep(20);
  }
  return 0;
}
