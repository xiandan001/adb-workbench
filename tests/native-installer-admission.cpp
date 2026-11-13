#include "../build/installer-ui/installer-skin.h"
#include <cstdio>
#include <stdexcept>
#include <string>

#ifndef VEYLO_INSTALLER_LIFECYCLE_TEST
#error This admission fixture must never acquire the production installation guard.
#endif

SKIN_EXPORT(ConfigureUpdate);
SKIN_EXPORT(BeginInstall);

namespace {
constexpr int capacity = 1024;
void Push(NsisStack** stack, const std::wstring& value) {
  auto* entry = static_cast<NsisStack*>(GlobalAlloc(GPTR, sizeof(NsisStack) + capacity * sizeof(wchar_t)));
  if (!entry) throw std::runtime_error("owned stack allocation failed");
  wcscpy_s(entry->text, capacity, value.c_str());
  entry->next = *stack; *stack = entry;
}
std::wstring Pop(NsisStack** stack) {
  if (!*stack) throw std::runtime_error("missing fixture return value");
  auto* entry = *stack;
  const std::wstring value(entry->text);
  *stack = entry->next; GlobalFree(entry);
  return value;
}
std::wstring Begin(const wchar_t* mode) {
  NsisStack* stack = nullptr;
  Push(&stack, mode);
  SkinBeginInstall(nullptr, capacity, nullptr, &stack, nullptr);
  const auto result = Pop(&stack);
  if (stack) throw std::runtime_error("unbalanced fixture stack");
  return result;
}
}

int wmain(int argc, wchar_t**) {
  try {
    NsisStack* stack = nullptr;
    SkinConfigureUpdate(nullptr, capacity, nullptr, &stack, nullptr);
    if (Pop(&stack) != L"ok" || stack) throw std::runtime_error("valid fixture arguments were rejected");
    if (Begin(L"interactive") != L"ready") throw std::runtime_error("interactive deployment bypassed ready");
    if (Begin(L"unknown") != L"ready") throw std::runtime_error("unknown deployment mode was admitted");
    const bool tokenProvided = argc > 1;
    // A test-build default guard returns error BEFORE any Global object/ProgramData access.
    // Therefore error proves the legacy silent path reached guard validation, not a ready bypass failure.
    if (Begin(L"silent") != (tokenProvided ? L"ready" : L"error")) throw std::runtime_error("silent admission contract failed");
    std::puts(tokenProvided ? "PASS token handoff cannot bypass GUI readiness via silent mode" :
      "PASS legacy silent mode reaches the isolated guard without GUI readiness");
    std::puts("PASS interactive and unknown modes reject deployment before acknowledgement");
    return 0;
  } catch (const std::exception& error) { std::fprintf(stderr, "FAIL %s\n", error.what()); return 1; }
}
