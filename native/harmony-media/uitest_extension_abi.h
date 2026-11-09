#pragma once
#include <cstddef>
#include <cstdint>
#include <cstdarg>

// Public UITest extension ABI, independently declared for this narrow plug-in.
// Reference: OpenHarmony testfwk_arkxtest/uitest/addon/extension_c_api.h.
struct TestText { const char *data; size_t size; };
struct TestBuffer { uint8_t *data; size_t capacity; size_t *size; };
struct TestPort {
    int32_t (*version)(TestBuffer);
    int32_t (*log)(int32_t, TestText, TestText, va_list);
    int32_t (*lastError)(int32_t *, TestBuffer);
    int32_t (*lowLevel)(void *);
};
