#pragma once
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

struct CaptureOptions { int width; int height; int fps; int bitrate; };
class AvCapture {
public:
    using Video = std::function<bool(std::vector<uint8_t>, int64_t, uint8_t)>;
    using State = std::function<void(const std::string &, int)>;
    AvCapture(Video video, State state);
    ~AvCapture();
    bool Start(const CaptureOptions &options, std::string &error);
    void Stop();
    bool Finished() const;
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
