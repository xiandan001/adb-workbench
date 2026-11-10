#include "../native/harmony-media/encoded_frame.h"
#include <cstdlib>
#include <iostream>
#include <vector>

using awb::AssemblyStatus;
using awb::EncodedFrameAssembler;
int checks = 0;
void Check(bool value, const char *message)
{
    checks++;
    if (!value) { std::cerr << message << '\n'; std::exit(1); }
}
int main()
{
    const uint8_t first[]{0, 0, 0, 1, 0x65}, last[]{0x88, 0x99};
    EncodedFrameAssembler split;
    auto pending = split.Push(first, sizeof(first), 50000, FLAG_KEY, true, false);
    Check(pending.status == AssemblyStatus::Pending && pending.frame.bytes.empty(), "partial frame must not be emitted");
    auto final = split.Push(last, sizeof(last), 50000, 0, false, false);
    Check(final.status == AssemblyStatus::Ready && final.frame.timestamp == 50000 && final.frame.flags == FLAG_KEY,
        "first-fragment KEY and timestamp must survive finalization");
    Check(final.frame.bytes == std::vector<uint8_t>({0, 0, 0, 1, 0x65, 0x88, 0x99}), "fragments must remain byte-exact");
    auto single = split.Push(last, sizeof(last), 100000, 0, false, false);
    Check(single.status == AssemblyStatus::Ready && single.frame.bytes.size() == sizeof(last), "next frame must start cleanly");

    EncodedFrameAssembler finalKey;
    finalKey.Push(first, sizeof(first), 1, 0, true, false);
    Check(finalKey.Push(last, sizeof(last), 1, FLAG_KEY, false, false).frame.flags == FLAG_KEY,
        "KEY present on final fragment must propagate");
    EncodedFrameAssembler config;
    config.Push(first, sizeof(first), 0, FLAG_CONFIG, true, false);
    Check(config.Push(last, sizeof(last), 0, FLAG_CONFIG, false, false).frame.flags == FLAG_CONFIG,
        "fragmented configuration must retain CONFIG");

    EncodedFrameAssembler timestamp;
    timestamp.Push(first, sizeof(first), 1, 0, true, false);
    Check(timestamp.Push(last, sizeof(last), 2, 0, false, false).status == AssemblyStatus::Error,
        "timestamp changes cannot join unrelated frames");
    Check(timestamp.Push(last, sizeof(last), 2, FLAG_KEY, false, false).status == AssemblyStatus::Error,
        "failed aggregation must not silently resume");
    EncodedFrameAssembler mixed;
    mixed.Push(first, sizeof(first), 0, FLAG_CONFIG, true, false);
    Check(mixed.Push(last, sizeof(last), 0, 0, false, false).status == AssemblyStatus::Error,
        "codec-data fragments must not mix with video data");

    std::vector<uint8_t> maximum(MAX_FRAME, 0x88);
    EncodedFrameAssembler exact;
    Check(exact.Push(maximum.data(), maximum.size(), 0, FLAG_KEY, false, false).status == AssemblyStatus::Ready,
        "an exactly 8MiB frame remains valid");
    EncodedFrameAssembler overflow;
    overflow.Push(maximum.data(), maximum.size(), 0, FLAG_KEY, true, false);
    Check(overflow.Push(last, 1, 0, 0, false, false).status == AssemblyStatus::Error, "aggregate size must not exceed 8MiB");
    EncodedFrameAssembler oversized;
    Check(oversized.Push(first, MAX_FRAME + 1, 0, 0, false, false).status == AssemblyStatus::Error,
        "oversized inputs must be rejected before reading memory");
    EncodedFrameAssembler allocationBound;
    allocationBound.Push(maximum.data(), 6 * 1024 * 1024, 0, FLAG_KEY, true, false);
    auto grown = allocationBound.Push(maximum.data(), 1024 * 1024, 0, FLAG_KEY, false, false);
    Check(grown.status == AssemblyStatus::Ready && grown.frame.bytes.capacity() <= MAX_FRAME,
        "vector growth must not reserve more than the 8MiB aggregation bound");
    EncodedFrameAssembler empty;
    Check(empty.Push(nullptr, 0, 0, 0, false, true).status == AssemblyStatus::Ignored, "empty EOS without pending data is valid");
    EncodedFrameAssembler unfinished;
    unfinished.Push(first, sizeof(first), 1, FLAG_KEY, true, false);
    Check(unfinished.Push(nullptr, 0, 1, 0, false, true).status == AssemblyStatus::Error,
        "EOS cannot turn incomplete data into a complete frame");
    EncodedFrameAssembler contradictory;
    Check(contradictory.Push(first, sizeof(first), 1, FLAG_KEY, true, true).status == AssemblyStatus::Error,
        "simultaneous incomplete and EOS must be rejected");
    EncodedFrameAssembler ended;
    Check(ended.Push(first, sizeof(first), 1, FLAG_KEY, false, true).status == AssemblyStatus::Ready,
        "complete last frame with EOS must still be emitted");
    EncodedFrameAssembler nullData;
    Check(nullData.Push(nullptr, 1, 0, 0, false, false).status == AssemblyStatus::Error, "nonempty null buffers are invalid");
    uint8_t borrowed[]{0, 0, 0, 1, 0x67, 0x42};
    auto initialization = awb::CopyCodecConfiguration(true, borrowed, sizeof(borrowed));
    borrowed[4] = 0;
    Check(initialization.status == AssemblyStatus::Ready && initialization.frame.flags == FLAG_CONFIG
        && initialization.frame.bytes[4] == 0x67 && initialization.frame.timestamp == 0,
        "format-owned codec data must be copied before its callback returns");
    Check(awb::CopyCodecConfiguration(false, nullptr, 999).status == AssemblyStatus::Ignored,
        "an absent public codec-config field cannot create synthetic initialization data");
    Check(awb::CopyCodecConfiguration(true, nullptr, 0).status == AssemblyStatus::Ignored,
        "empty optional codec configuration is ignored");
    Check(awb::CopyCodecConfiguration(true, borrowed, MAX_FRAME + 1).status == AssemblyStatus::Error,
        "oversized format configuration is rejected before touching borrowed memory");
    Check(awb::CopyCodecConfiguration(true, nullptr, 1).status == AssemblyStatus::Error,
        "nonempty format configuration needs a valid borrowed address");
    std::cout << "native fragment checks passed: " << checks << '\n';
}
