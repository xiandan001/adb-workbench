#include "av_capture.h"
#include "protocol.h"
#include "uitest_extension_abi.h"
#include <arpa/inet.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>
#include <algorithm>
#include <chrono>
#include <cstring>
#include <deque>
#include <fstream>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

namespace {
struct Config {
    std::string id, token, directory, version;
    CaptureOptions video{};
};
Config config;
volatile sig_atomic_t interrupted = 0;
void Interrupt(int) { interrupted = 1; }
int64_t ClockMs()
{
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}
bool IsHex(const std::string &value, size_t length)
{
    return value.size() == length && std::all_of(value.begin(), value.end(), [](char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    });
}
bool IsId(const std::string &id)
{
    if (id.size() != 36) return false;
    std::string hex;
    for (size_t i = 0; i < id.size(); i++) {
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (id[i] != '-') return false; }
        else hex.push_back(id[i]);
    }
    return IsHex(hex, 32);
}
std::string JsonText(const std::string &input)
{
    std::string result;
    for (unsigned char c : input.substr(0, 500)) {
        if (c == '"' || c == '\\') result.push_back('\\');
        if (c >= 32 && c < 127) result.push_back(static_cast<char>(c));
    }
    return result;
}
bool ReadConfig(const char *filename)
{
    const std::string file(filename ? filename : "");
    const std::string prefix = "/data/local/tmp/awb-media-";
    if (file.rfind(prefix, 0) != 0 || file.size() != prefix.size() + 36 + 7
        || file.substr(file.size() - 7) != "/config") return false;
    const auto id = file.substr(prefix.size(), 36);
    if (!IsId(id)) return false;
    int fd = open(file.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return false;
    struct stat metadata{};
    if (fstat(fd, &metadata) != 0 || !S_ISREG(metadata.st_mode) || metadata.st_uid != geteuid()
        || (metadata.st_mode & 0077) != 0 || metadata.st_size <= 0 || metadata.st_size > 2048) { close(fd); return false; }
    char bytes[2049]{};
    const auto length = read(fd, bytes, 2048);
    close(fd);
    if (length != metadata.st_size) return false;
    std::istringstream input(std::string(bytes, static_cast<size_t>(length)));
    std::string magic, extra;
    if (!(input >> magic >> config.id >> config.token >> config.video.width >> config.video.height
        >> config.video.fps >> config.video.bitrate) || (input >> extra) || magic != "AWB_MEDIA_1"
        || config.id != id || !IsHex(config.token, 64)) return false;
    if (config.video.width < 16 || config.video.height < 16 || config.video.width > 1920 || config.video.height > 1920
        || config.video.width % 2 || config.video.height % 2 || config.video.fps < 5 || config.video.fps > 30
        || config.video.bitrate < 100000 || config.video.bitrate > 12000000) return false;
    config.directory = file.substr(0, file.size() - 7);
    return true;
}
bool ReadyFile(uint16_t port)
{
    const auto filename = config.directory + "/ready.json";
    int fd = open(filename.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) return false;
    const auto text = "{\"protocol\":1,\"sessionId\":\"" + config.id + "\",\"pid\":" + std::to_string(getpid())
        + ",\"port\":" + std::to_string(port) + ",\"uitestVersion\":\"" + JsonText(config.version) + "\"}\n";
    const bool success = write(fd, text.data(), text.size()) == static_cast<ssize_t>(text.size()) && fsync(fd) == 0;
    close(fd); return success;
}
int Listen(uint16_t &port)
{
    int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (fd < 0) return -1;
    sockaddr_in address{}; address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(fd, reinterpret_cast<sockaddr *>(&address), sizeof(address)) != 0 || listen(fd, 2) != 0) { close(fd); return -1; }
    socklen_t size = sizeof(address);
    if (getsockname(fd, reinterpret_cast<sockaddr *>(&address), &size) != 0) { close(fd); return -1; }
    port = ntohs(address.sin_port); return fd;
}
bool TokenMatches(const std::string &line)
{
    if (line.size() != 69 || line.compare(0, 5, "AUTH ") != 0) return false;
    unsigned char difference = 0;
    for (size_t index = 0; index < 64; index++) difference |= static_cast<unsigned char>(line[index + 5] ^ config.token[index]);
    return difference == 0;
}
bool ReadLines(int fd, std::string &pending, std::vector<std::string> &lines)
{
    char buffer[512];
    const auto count = recv(fd, buffer, sizeof(buffer), MSG_DONTWAIT);
    if (count == 0) return false;
    if (count < 0) return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR;
    pending.append(buffer, static_cast<size_t>(count));
    if (pending.size() > 512) return false;
    size_t end;
    while ((end = pending.find('\n')) != std::string::npos) {
        lines.push_back(pending.substr(0, end)); pending.erase(0, end + 1);
        if (lines.size() > 8) return false;
    }
    return true;
}
int Authenticate(int listener)
{
    const int64_t deadline = ClockMs() + 30000;
    while (!interrupted && ClockMs() < deadline) {
        pollfd listenerPoll{listener, POLLIN, 0};
        if (poll(&listenerPoll, 1, 250) <= 0) continue;
        int peer = accept4(listener, nullptr, nullptr, SOCK_CLOEXEC | SOCK_NONBLOCK);
        if (peer < 0) continue;
        const int64_t authDeadline = std::min(deadline, ClockMs() + 3000);
        std::string pending; bool accepted = false;
        while (!interrupted && ClockMs() < authDeadline) {
            pollfd peerPoll{peer, POLLIN, 0};
            if (poll(&peerPoll, 1, 250) <= 0) continue;
            std::vector<std::string> lines;
            if (!ReadLines(peer, pending, lines)) break;
            if (!lines.empty()) { accepted = lines.size() == 1 && pending.empty() && TokenMatches(lines[0]); break; }
        }
        if (accepted) return peer;
        close(peer);
    }
    return -1;
}
struct Packet { uint8_t kind, flags; int64_t timestamp; std::vector<uint8_t> bytes; };
class PacketQueue {
public:
    bool Push(Packet packet)
    {
        std::lock_guard<std::mutex> guard(mutex_);
        if (packet.bytes.size() > MAX_FRAME || bytes_ + packet.bytes.size() > 16 * 1024 * 1024 || packets_.size() >= 32) return false;
        bytes_ += packet.bytes.size(); packets_.push_back(std::move(packet)); return true;
    }
    bool Pop(Packet &packet)
    {
        std::lock_guard<std::mutex> guard(mutex_);
        if (packets_.empty()) return false;
        packet = std::move(packets_.front()); packets_.pop_front(); bytes_ -= packet.bytes.size(); return true;
    }
private:
    std::mutex mutex_;
    std::deque<Packet> packets_;
    size_t bytes_ = 0;
};
bool SendBytes(int fd, const uint8_t *bytes, size_t size)
{
    size_t offset = 0; const auto deadline = ClockMs() + 1500;
    while (!interrupted && offset < size && ClockMs() < deadline) {
        auto written = send(fd, bytes + offset, size - offset, MSG_NOSIGNAL | MSG_DONTWAIT);
        if (written > 0) offset += static_cast<size_t>(written);
        else if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) {
            pollfd wait{fd, POLLOUT, 0}; poll(&wait, 1, 100);
        } else return false;
    }
    return offset == size;
}
bool Flush(int peer, PacketQueue &queue)
{
    Packet packet{};
    while (queue.Pop(packet)) {
        uint8_t header[HEADER_SIZE]{'A', 'W', 'B', 'M', 1, packet.kind, packet.flags, 0};
        Put32(header + 8, static_cast<uint32_t>(packet.bytes.size()));
        Put64(header + 12, static_cast<uint64_t>(std::max<int64_t>(0, packet.timestamp)));
        if (!SendBytes(peer, header, sizeof(header)) || !SendBytes(peer, packet.bytes.data(), packet.bytes.size())) return false;
    }
    return true;
}
}

extern "C" __attribute__((visibility("default"))) int32_t UiTestExtension_OnInit(TestPort port, size_t argc, char **argv)
{
    if (argc != 2 || std::string(argv[0]) != "--config" || !ReadConfig(argv[1]) || !port.version) return -1;
    uint8_t version[256]{}; size_t size = 0;
    if (port.version(TestBuffer{version, sizeof(version), &size}) != 0 || size >= sizeof(version)) return -1;
    config.version.assign(reinterpret_cast<char *>(version), size);
    signal(SIGTERM, Interrupt); signal(SIGINT, Interrupt); signal(SIGPIPE, SIG_IGN);
    return 0;
}

extern "C" __attribute__((visibility("default"))) int32_t UiTestExtension_OnRun()
{
    uint16_t port = 0; const int listener = Listen(port);
    if (listener < 0 || !ReadyFile(port)) { if (listener >= 0) close(listener); return -1; }
    int peer = Authenticate(listener); close(listener);
    if (peer < 0) return -1;
    PacketQueue queue;
    auto state = [&queue](const std::string &name, int code) {
        const auto message = "{\"state\":\"" + JsonText(name) + "\",\"code\":" + std::to_string(code) + "}";
        queue.Push({name.find("error") != std::string::npos ? KIND_ERROR : KIND_STATE, 0, 0,
            std::vector<uint8_t>(message.begin(), message.end())});
    };
    AvCapture capture([&queue](std::vector<uint8_t> bytes, int64_t timestamp, uint8_t flags) {
        return queue.Push({KIND_VIDEO, flags, timestamp, std::move(bytes)});
    }, state);
    std::string error;
    if (!capture.Start(config.video, error)) {
        state(error, -1); Flush(peer, queue); close(peer); return -1;
    }
    std::string pending; auto lastActivity = ClockMs(); bool stopped = false;
    while (!interrupted && !stopped && !capture.Finished() && ClockMs() - lastActivity < 20000) {
        if (!Flush(peer, queue)) break;
        pollfd input{peer, POLLIN, 0};
        const int ready = poll(&input, 1, 20);
        if (ready > 0) {
            std::vector<std::string> lines;
            if (!ReadLines(peer, pending, lines)) break;
            for (const auto &line : lines) {
                if (line == "PING") lastActivity = ClockMs();
                else if (line == "STOP") { stopped = true; break; }
                else { stopped = true; break; }
            }
        }
    }
    capture.Stop();
    state(stopped ? "stopped" : "ended", 0);
    Flush(peer, queue);
    shutdown(peer, SHUT_RDWR); close(peer);
    std::fill(config.token.begin(), config.token.end(), '0');
    return 0;
}
