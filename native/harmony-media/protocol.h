#pragma once
#include <cstddef>
#include <cstdint>

// Wire header: AWBM, protocol=1, kind, flags, reserved=0, payload length BE32,
// timestamp in microseconds BE64. No native structs are serialized.
constexpr size_t HEADER_SIZE = 20;
constexpr size_t MAX_FRAME = 8 * 1024 * 1024;
constexpr uint8_t KIND_STATE = 1;
constexpr uint8_t KIND_VIDEO = 2;
constexpr uint8_t KIND_ERROR = 3;
constexpr uint8_t FLAG_KEY = 1;
constexpr uint8_t FLAG_CONFIG = 2;

inline void Put32(uint8_t *out, uint32_t value)
{
    for (int i = 3; i >= 0; --i) { out[i] = static_cast<uint8_t>(value); value >>= 8; }
}
inline void Put64(uint8_t *out, uint64_t value)
{
    for (int i = 7; i >= 0; --i) { out[i] = static_cast<uint8_t>(value); value >>= 8; }
}
