#include "av_capture.h"
#include "protocol.h"
#include <atomic>
#include <cstring>
#include <dlfcn.h>
#include <stdexcept>
#include <utility>
#include <multimedia/player_framework/native_avscreen_capture.h>
#include <multimedia/player_framework/native_avcodec_videoencoder.h>
#include <multimedia/player_framework/native_avbuffer.h>
#include <multimedia/player_framework/native_avformat.h>
#include <native_window/external_window.h>

namespace {
template<typename T> T Symbol(void *library, const char *name)
{
    auto value = dlsym(library, name);
    if (!value) throw std::runtime_error(std::string("missing-api:") + name);
    return reinterpret_cast<T>(value);
}
void *Library(const char *name)
{
    void *value = dlopen(name, RTLD_NOW | RTLD_LOCAL);
    if (!value) throw std::runtime_error(std::string("missing-library:") + name);
    return value;
}
}

struct AvCapture::Impl {
    Video video;
    State state;
    std::atomic<bool> finished{false};
    std::atomic<bool> accepting{false};
    bool encoderStarted = false;
    OH_AVScreenCapture *capture = nullptr;
    OH_AVCodec *encoder = nullptr;
    OHNativeWindow *surface = nullptr;
    std::vector<void *> libraries;
#define API(name) decltype(&name) p_##name = nullptr
    API(OH_AVScreenCapture_Create); API(OH_AVScreenCapture_Init);
    API(OH_AVScreenCapture_SetStateCallback); API(OH_AVScreenCapture_SetErrorCallback);
    API(OH_AVScreenCapture_SetMicrophoneEnabled); API(OH_AVScreenCapture_StartScreenCaptureWithSurface);
    API(OH_AVScreenCapture_StopScreenCapture); API(OH_AVScreenCapture_Release);
    API(OH_VideoEncoder_CreateByMime); API(OH_VideoEncoder_RegisterCallback);
    API(OH_VideoEncoder_Configure); API(OH_VideoEncoder_GetSurface); API(OH_VideoEncoder_Prepare);
    API(OH_VideoEncoder_Start); API(OH_VideoEncoder_Stop); API(OH_VideoEncoder_Destroy);
    API(OH_VideoEncoder_FreeOutputBuffer);
    API(OH_AVFormat_Create); API(OH_AVFormat_Destroy); API(OH_AVFormat_SetIntValue);
    API(OH_AVFormat_SetLongValue); API(OH_AVFormat_SetDoubleValue);
    API(OH_AVBuffer_GetAddr); API(OH_AVBuffer_GetCapacity); API(OH_AVBuffer_GetBufferAttr);
    API(OH_NativeWindow_DestroyNativeWindow);
#undef API
    void *codecBase = nullptr;

    Impl(Video output, State event) : video(std::move(output)), state(std::move(event)) {}
    ~Impl() { Stop(); for (auto it = libraries.rbegin(); it != libraries.rend(); ++it) dlclose(*it); }
    void *Load(const char *name) { void *handle = Library(name); libraries.push_back(handle); return handle; }
    const char *Key(const char *name) { return *Symbol<const char **>(codecBase, name); }
    void LoadApis()
    {
        void *captureLib = Load("libnative_avscreen_capture.so");
        void *encoderLib = Load("libnative_media_venc.so");
        void *core = Load("libnative_media_core.so");
        void *window = Load("libnative_window.so");
        codecBase = Load("libnative_media_codecbase.so");
#define LOAD(lib, name) p_##name = Symbol<decltype(p_##name)>(lib, #name)
        LOAD(captureLib, OH_AVScreenCapture_Create); LOAD(captureLib, OH_AVScreenCapture_Init);
        LOAD(captureLib, OH_AVScreenCapture_SetStateCallback); LOAD(captureLib, OH_AVScreenCapture_SetErrorCallback);
        LOAD(captureLib, OH_AVScreenCapture_SetMicrophoneEnabled); LOAD(captureLib, OH_AVScreenCapture_StartScreenCaptureWithSurface);
        LOAD(captureLib, OH_AVScreenCapture_StopScreenCapture); LOAD(captureLib, OH_AVScreenCapture_Release);
        LOAD(encoderLib, OH_VideoEncoder_CreateByMime); LOAD(encoderLib, OH_VideoEncoder_RegisterCallback);
        LOAD(encoderLib, OH_VideoEncoder_Configure); LOAD(encoderLib, OH_VideoEncoder_GetSurface);
        LOAD(encoderLib, OH_VideoEncoder_Prepare); LOAD(encoderLib, OH_VideoEncoder_Start);
        LOAD(encoderLib, OH_VideoEncoder_Stop); LOAD(encoderLib, OH_VideoEncoder_Destroy);
        LOAD(encoderLib, OH_VideoEncoder_FreeOutputBuffer);
        LOAD(core, OH_AVFormat_Create); LOAD(core, OH_AVFormat_Destroy); LOAD(core, OH_AVFormat_SetIntValue);
        LOAD(core, OH_AVFormat_SetLongValue); LOAD(core, OH_AVFormat_SetDoubleValue);
        LOAD(core, OH_AVBuffer_GetAddr); LOAD(core, OH_AVBuffer_GetCapacity); LOAD(core, OH_AVBuffer_GetBufferAttr);
        LOAD(window, OH_NativeWindow_DestroyNativeWindow);
#undef LOAD
    }
    static void EncoderError(OH_AVCodec *, int32_t code, void *user)
    {
        auto self = static_cast<Impl *>(user);
        self->state("encoder-error", code); self->finished = true;
    }
    static void FormatChanged(OH_AVCodec *, OH_AVFormat *, void *) {}
    static void NeedInput(OH_AVCodec *, uint32_t, OH_AVBuffer *, void *) {}
    static void Encoded(OH_AVCodec *codec, uint32_t index, OH_AVBuffer *buffer, void *user)
    {
        auto self = static_cast<Impl *>(user);
        OH_AVCodecBufferAttr attr{};
        std::vector<uint8_t> bytes;
        uint8_t flags = 0;
        bool invalid = false;
        if (self->accepting && self->p_OH_AVBuffer_GetBufferAttr(buffer, &attr) == AV_ERR_OK) {
            auto address = self->p_OH_AVBuffer_GetAddr(buffer);
            auto capacity = self->p_OH_AVBuffer_GetCapacity(buffer);
            invalid = !address || attr.offset < 0 || attr.size < 0 || capacity < attr.offset
                || attr.size > capacity - attr.offset || static_cast<size_t>(attr.size) > MAX_FRAME;
            if (!invalid && attr.size) {
                bytes.assign(address + attr.offset, address + attr.offset + attr.size);
                if (attr.flags & AVCODEC_BUFFER_FLAGS_SYNC_FRAME) flags |= FLAG_KEY;
                if (attr.flags & AVCODEC_BUFFER_FLAGS_CODEC_DATA) flags |= FLAG_CONFIG;
            }
            if (attr.flags & AVCODEC_BUFFER_FLAGS_EOS) self->finished = true;
        }
        self->p_OH_VideoEncoder_FreeOutputBuffer(codec, index);
        if (invalid || (!bytes.empty() && !self->video(std::move(bytes), attr.pts, flags))) {
            self->state("stream-backpressure", 0); self->finished = true;
        }
    }
    static void CaptureState(OH_AVScreenCapture *, OH_AVScreenCaptureStateCode code, void *user)
    {
        auto self = static_cast<Impl *>(user);
        self->state(code == OH_SCREEN_CAPTURE_STATE_STARTED ? "started" : "capture-state", static_cast<int>(code));
        if (code == OH_SCREEN_CAPTURE_STATE_CANCELED || code == OH_SCREEN_CAPTURE_STATE_STOPPED_BY_USER
            || code == OH_SCREEN_CAPTURE_STATE_INTERRUPTED_BY_OTHER || code == OH_SCREEN_CAPTURE_STATE_STOPPED_BY_CALL) {
            self->finished = true;
        }
    }
    static void CaptureError(OH_AVScreenCapture *, int32_t code, void *user)
    {
        auto self = static_cast<Impl *>(user);
        self->state("capture-error", code); self->finished = true;
    }
    bool Start(const CaptureOptions &options, std::string &error)
    {
        try {
            LoadApis();
            encoder = p_OH_VideoEncoder_CreateByMime("video/avc");
            if (!encoder) throw std::runtime_error("h264-encoder-unavailable");
            OH_AVCodecCallback callbacks{EncoderError, FormatChanged, NeedInput, Encoded};
            if (p_OH_VideoEncoder_RegisterCallback(encoder, callbacks, this) != AV_ERR_OK) throw std::runtime_error("encoder-callback");
            OH_AVFormat *format = p_OH_AVFormat_Create();
            if (!format) throw std::runtime_error("encoder-format");
            bool configured = p_OH_AVFormat_SetIntValue(format, Key("OH_MD_KEY_WIDTH"), options.width)
                && p_OH_AVFormat_SetIntValue(format, Key("OH_MD_KEY_HEIGHT"), options.height)
                && p_OH_AVFormat_SetIntValue(format, Key("OH_MD_KEY_PIXEL_FORMAT"), AV_PIXEL_FORMAT_SURFACE_FORMAT)
                && p_OH_AVFormat_SetDoubleValue(format, Key("OH_MD_KEY_FRAME_RATE"), options.fps)
                && p_OH_AVFormat_SetLongValue(format, Key("OH_MD_KEY_BITRATE"), options.bitrate)
                && p_OH_AVFormat_SetIntValue(format, Key("OH_MD_KEY_I_FRAME_INTERVAL"), 1000);
            auto configureCode = configured ? p_OH_VideoEncoder_Configure(encoder, format) : AV_ERR_INVALID_VAL;
            p_OH_AVFormat_Destroy(format);
            if (configureCode != AV_ERR_OK) throw std::runtime_error("encoder-configuration:" + std::to_string(configureCode));
            if (p_OH_VideoEncoder_GetSurface(encoder, &surface) != AV_ERR_OK || !surface) throw std::runtime_error("encoder-surface");
            if (p_OH_VideoEncoder_Prepare(encoder) != AV_ERR_OK) throw std::runtime_error("encoder-prepare");
            accepting = true;
            if (p_OH_VideoEncoder_Start(encoder) != AV_ERR_OK) throw std::runtime_error("encoder-start");
            encoderStarted = true;
            capture = p_OH_AVScreenCapture_Create();
            if (!capture) throw std::runtime_error("capture-unavailable");
            OH_AVScreenCaptureConfig config{};
            config.captureMode = OH_CAPTURE_HOME_SCREEN;
            config.dataType = OH_ORIGINAL_STREAM;
            config.videoInfo.videoCapInfo.videoFrameWidth = options.width;
            config.videoInfo.videoCapInfo.videoFrameHeight = options.height;
            config.videoInfo.videoCapInfo.videoSource = OH_VIDEO_SOURCE_SURFACE_RGBA;
            if (p_OH_AVScreenCapture_Init(capture, config) != AV_SCREEN_CAPTURE_ERR_OK) throw std::runtime_error("capture-init");
            // Registering the normal state callback enables the platform's privacy-consent flow.
            // Never request exemption, root, custom recording permission or privacy-window bypass.
            if (p_OH_AVScreenCapture_SetStateCallback(capture, CaptureState, this) != AV_SCREEN_CAPTURE_ERR_OK
                || p_OH_AVScreenCapture_SetErrorCallback(capture, CaptureError, this) != AV_SCREEN_CAPTURE_ERR_OK
                || p_OH_AVScreenCapture_SetMicrophoneEnabled(capture, false) != AV_SCREEN_CAPTURE_ERR_OK) throw std::runtime_error("capture-callback");
            state("awaiting-consent", 0);
            auto started = p_OH_AVScreenCapture_StartScreenCaptureWithSurface(capture, surface);
            if (started != AV_SCREEN_CAPTURE_ERR_OK) throw std::runtime_error("capture-start:" + std::to_string(started));
            return true;
        } catch (const std::exception &failure) {
            error = failure.what(); finished = true; Stop(); return false;
        }
    }
    void Stop()
    {
        accepting = false;
        if (capture) {
            p_OH_AVScreenCapture_StopScreenCapture(capture);
            p_OH_AVScreenCapture_Release(capture); capture = nullptr;
        }
        if (encoder) {
            if (encoderStarted) p_OH_VideoEncoder_Stop(encoder);
            encoderStarted = false;
            p_OH_VideoEncoder_Destroy(encoder); encoder = nullptr;
        }
        if (surface && p_OH_NativeWindow_DestroyNativeWindow) { p_OH_NativeWindow_DestroyNativeWindow(surface); surface = nullptr; }
    }
};

AvCapture::AvCapture(Video video, State state) : impl_(std::make_unique<Impl>(std::move(video), std::move(state))) {}
AvCapture::~AvCapture() = default;
bool AvCapture::Start(const CaptureOptions &options, std::string &error) { return impl_->Start(options, error); }
void AvCapture::Stop() { impl_->Stop(); }
bool AvCapture::Finished() const { return impl_->finished.load(); }
