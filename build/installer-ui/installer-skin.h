#pragma once
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

// Unicode NSIS plugin ABI. NSIS owns execution, elevation and installation.
struct NsisStack {
  NsisStack* next;
  wchar_t text[1];
};
struct NsisExtra;
#define SKIN_EXPORT(name) extern "C" void __cdecl Skin##name(HWND parent, int stringSize, wchar_t* variables, NsisStack** stack, NsisExtra* extra)
