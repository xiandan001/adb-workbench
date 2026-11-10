#pragma once
#include "protocol.h"
#include <algorithm>
#include <utility>
#include <vector>

namespace awb {
enum class AssemblyStatus { Ignored, Pending, Ready, Error };
struct EncodedFrame { std::vector<uint8_t> bytes; int64_t timestamp = 0; uint8_t flags = 0; };
struct AssemblyResult {
    AssemblyStatus status = AssemblyStatus::Ignored;
    EncodedFrame frame;
    const char *error = nullptr;
};

inline AssemblyResult CopyCodecConfiguration(bool present, const uint8_t *data, size_t size) noexcept
{
    if (!present || !size) return {};
    if (!data || size > MAX_FRAME) return { AssemblyStatus::Error, {}, "encoder-config-size" };
    try { return { AssemblyStatus::Ready, { std::vector<uint8_t>(data, data + size), 0, FLAG_CONFIG }, nullptr }; }
    catch (...) { return { AssemblyStatus::Error, {}, "encoder-config-allocation" }; }
}

// One encoder access unit may span multiple output buffers. Never expose a
// partial access unit as a complete wire frame, or join data across PTS/type.
class EncodedFrameAssembler {
public:
    AssemblyResult Push(const uint8_t *data, size_t size, int64_t timestamp, uint8_t flags,
        bool incomplete, bool eos) noexcept
    {
        if (failed_) return Error("encoder-fragment-failed");
        if (size > MAX_FRAME || size > MAX_FRAME - pending_.bytes.size()) return Error("encoder-fragment-size");
        if ((size && !data) || (flags & ~(FLAG_KEY | FLAG_CONFIG))) return Error("encoder-fragment-invalid");
        if (incomplete && eos) return Error("encoder-fragment-eos");
        if (!size) {
            if (active_ || incomplete) return Error("encoder-fragment-empty");
            return {};
        }
        if (active_ && (timestamp != pending_.timestamp || (flags & FLAG_CONFIG) != (pending_.flags & FLAG_CONFIG))) {
            return Error("encoder-fragment-mismatch");
        }
        try {
            if (!active_) { pending_.timestamp = timestamp; pending_.flags = flags; }
            else pending_.flags |= flags;
            const size_t required = pending_.bytes.size() + size;
            if (required > pending_.bytes.capacity()) {
                pending_.bytes.reserve(std::min(MAX_FRAME, std::max(required, pending_.bytes.capacity() * 2)));
            }
            pending_.bytes.insert(pending_.bytes.end(), data, data + size);
            if (incomplete) { active_ = true; return { AssemblyStatus::Pending, {}, nullptr }; }
            AssemblyResult result{AssemblyStatus::Ready, std::move(pending_), nullptr};
            pending_ = {}; active_ = false;
            return result;
        } catch (...) { return Error("encoder-fragment-allocation"); }
    }
private:
    AssemblyResult Error(const char *message) noexcept
    {
        pending_ = {}; active_ = false; failed_ = true;
        return { AssemblyStatus::Error, {}, message };
    }
    EncodedFrame pending_;
    bool active_ = false;
    bool failed_ = false;
};
}
