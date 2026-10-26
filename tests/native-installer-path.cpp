#include "../build/installer-ui/installer-path.h"
#include "../build/installer-ui/installer-orbit.h"
#include "../build/installer-ui/installer-path-filesystem.h"
#include <cassert>
#include <cstdio>

void CheckRealDirectories() {
  wchar_t temporary[MAX_PATH]{}, unique[MAX_PATH]{};
  assert(GetTempPathW(MAX_PATH, temporary));
  assert(GetTempFileNameW(temporary, L"vyp", 0, unique));
  assert(DeleteFileW(unique));
  assert(CreateDirectoryW(unique, nullptr));
  const std::wstring root = unique;
  const auto downloads = root + L"\\Downloads";
  const auto target = downloads + L"\\Veylo";
  const auto sentinel = downloads + L"\\personal-sentinel.txt";
  const auto appSentinel = target + L"\\existing-content.txt";
  assert(CreateDirectoryW(downloads.c_str(), nullptr));
  HANDLE file = CreateFileW(sentinel.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
  assert(file != INVALID_HANDLE_VALUE);
  const char value[] = "personal data must stay unchanged";
  DWORD written = 0;
  assert(WriteFile(file, value, sizeof(value), &written, nullptr));
  assert(written == sizeof(value)); CloseHandle(file);
  assert(!skin::SafeInstallDirectory(downloads, false));
  assert(skin::AppendApplicationFolder(downloads, root + L"\\default", L"Veylo") == target);
  assert(skin::SafeInstallDirectory(target, false));
  assert(!skin::SafeInstallDirectory(target, true));
  assert(CreateDirectoryW(target.c_str(), nullptr));
  assert(skin::SafeInstallDirectory(target, false));
  file = CreateFileW(appSentinel.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
  assert(file != INVALID_HANDLE_VALUE); CloseHandle(file);
  assert(!skin::SafeInstallDirectory(target, false));
  assert(skin::SafeInstallDirectory(target, true));
  assert(!skin::SafeInstallDirectory(sentinel, false));
  assert(!skin::SafeInstallDirectory(sentinel + L"\\Veylo", false));
  file = CreateFileW(sentinel.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  assert(file != INVALID_HANDLE_VALUE);
  char result[sizeof(value)]{}; DWORD read = 0;
  assert(ReadFile(file, result, sizeof(result), &read, nullptr)); CloseHandle(file);
  assert(read == sizeof(value) && memcmp(result, value, sizeof(value)) == 0);
  assert(DeleteFileW(appSentinel.c_str()));
  assert(RemoveDirectoryW(target.c_str()));
  assert(DeleteFileW(sentinel.c_str()));
  assert(RemoveDirectoryW(downloads.c_str()));
  assert(RemoveDirectoryW(root.c_str()));
}

int main() {
  using skin::AppendApplicationFolder;
  using skin::SamePath;
  using skin::TrimPath;
  using skin::ValidInstallPath;
  const std::wstring initial = L"D:\\AppStore\\卓控台";
  const std::wstring windows = L"C:\\Windows";
  assert(ValidInstallPath(initial, initial, windows));
  assert(ValidInstallPath(L"D:\\Other\\Veylo", initial, windows));
  assert(ValidInstallPath(L"C:\\Program Files\\卓控台", initial, windows));
  assert(ValidInstallPath(L"D:\\User's folder\\卓控台", initial, windows));
  assert(SamePath(L"D:/APPSTORE/卓控台/", initial));
  assert(TrimPath(L"  D:/Apps/Veylo/  ") == L"D:\\Apps\\Veylo");
  for (const std::wstring invalid : {L"", L"C:\\", L"C:\\Windows", L"c:\\windows\\Temp\\Veylo",
      L"C:\\Program Files", L"C:\\Users", L"C:\\ProgramData", L"..\\Veylo", L"\\\\server\\share\\Veylo",
      L"C:\\Apps\\..\\Windows", L"C:\\Apps\\.", L"C:\\Apps\\Veylo.", L"C:\\Apps\\CON",
      L"C:\\Apps\\lpt1.txt", L"C:\\Apps\\COM9", L"C:\\Apps\\bad:name", L"C:\\Apps\\bad\nname"})
    assert(!ValidInstallPath(invalid, initial, windows));
  assert(!ValidInstallPath(L"D:\\" + std::wstring(220, L'a'), initial, windows));
  assert(!ValidInstallPath(windows, windows, windows));
  assert(AppendApplicationFolder(L"", initial, L"卓控台").empty());
  assert(AppendApplicationFolder(L"D:\\", initial, L"卓控台") == L"D:\\卓控台");
  assert(AppendApplicationFolder(initial, initial, L"卓控台") == initial);
  assert(AppendApplicationFolder(L"D:\\Apps", initial, L"卓控台") == L"D:\\Apps\\卓控台");
  assert(AppendApplicationFolder(L"D:\\Apps\\veylo", initial, L"Veylo") == L"D:\\Apps\\veylo");
  for (const auto dimensions : {skin::OrbitPoint{160, 136}, skin::OrbitPoint{132, 108}}) {
    for (int sample = 0; sample < 720; ++sample) {
      const auto point = skin::EllipsePoint(dimensions.x, dimensions.y, sample * 3.14159265358979323846 / 360);
      const double x = point.x * std::cos(skin::kOrbitRadians) + point.y * std::sin(skin::kOrbitRadians);
      const double y = -point.x * std::sin(skin::kOrbitRadians) + point.y * std::cos(skin::kOrbitRadians);
      const double onEllipse = x * x / (dimensions.x * dimensions.x / 4) + y * y / (dimensions.y * dimensions.y / 4);
      assert(std::abs(onEllipse - 1.0) < 1e-12);
    }
  }
  CheckRealDirectories();
  std::puts("Native path, sentinel and ellipse checks passed.");
}
