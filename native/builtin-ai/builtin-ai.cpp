#include <node_api.h>

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <new>
#include <random>

#include "credentials.generated.h"

namespace {
using veylo_builtin_ai::EncodedCredential;
using veylo_builtin_ai::kCredentialCount;
using veylo_builtin_ai::kCredentials;

constexpr char kUrl[] = "https://apihub.agnes-ai.com/v1/chat/completions";
constexpr char kHost[] = "apihub.agnes-ai.com";
constexpr char kPath[] = "/v1/chat/completions";
constexpr char kModel[] = "agnes-3.0-flash";
constexpr char kBearer[] = "Bearer ";
constexpr std::size_t kMaxCredentialBytes = 4096;
constexpr std::uint32_t kMaxBodyBytes = 1280 * 1024;
constexpr std::uint32_t kMaxTimeoutMs = 120000;
constexpr napi_type_tag kRequestTag = {0x978319f9043ad2a9ULL, 0x15aed4310d5b8f31ULL};
constexpr napi_type_tag kResponseTag = {0x452b3d72f594c6a1ULL, 0x80c8829b17f9214dULL};
static_assert(kCredentialCount <= 256, "credential slots must be bounded");

#if defined(_MSC_VER)
#define VEYLO_NOINLINE __declspec(noinline)
#else
#define VEYLO_NOINLINE __attribute__((noinline))
#endif

enum class Kind { Request, Response };
enum class Action { On, Once, End, Timeout, Destroy, Resume, Complete };
enum class BridgeEvent { Empty, Data, Error, Response };
struct State;

struct Method {
  State* state;
  Kind kind;
  Action action;
  const char* target;
};

struct State {
  std::uint32_t slot = 0;
  std::uint32_t initial_slot = 0;
  napi_ref https = nullptr;
  napi_ref request = nullptr;
  napi_ref underlying = nullptr;
  napi_ref map_get = nullptr;
  napi_ref map_set = nullptr;
  std::array<Method, 10> methods{{
      {this, Kind::Request, Action::On, "on"},
      {this, Kind::Request, Action::Once, "once"},
      {this, Kind::Request, Action::End, "end"},
      {this, Kind::Request, Action::Timeout, "setTimeout"},
      {this, Kind::Request, Action::Destroy, "destroy"},
      {this, Kind::Response, Action::On, "on"},
      {this, Kind::Response, Action::Once, "once"},
      {this, Kind::Response, Action::Resume, "resume"},
      {this, Kind::Response, Action::Destroy, "destroy"},
      {this, Kind::Response, Action::Complete, "complete"},
  }};
};

bool Is(napi_env env, napi_value value, napi_valuetype expected) {
  napi_valuetype type;
  return napi_typeof(env, value, &type) == napi_ok && type == expected;
}

napi_value String(napi_env env, const char* value) {
  napi_value result = nullptr;
  napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result);
  return result;
}

napi_value Fail(napi_env env, const char* code, const char* message) {
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (!pending) napi_throw_error(env, code, message);
  return nullptr;
}

napi_value TransportFailure(napi_env env) {
  return Fail(env, "AI_BUILTIN_TRANSPORT", "Built-in AI transport is unavailable.");
}

napi_value Invalid(napi_env env) {
  return Fail(env, "AI_BUILTIN_INVALID", "Invalid built-in AI transport arguments.");
}

bool Equal(napi_env env, napi_value value, const char* expected) {
  char buffer[128];
  std::size_t length = 0;
  return Is(env, value, napi_string) &&
         napi_get_value_string_utf8(env, value, nullptr, 0, &length) == napi_ok &&
         length < sizeof(buffer) && length == std::strlen(expected) &&
         napi_get_value_string_utf8(env, value, buffer, sizeof(buffer), &length) == napi_ok &&
         std::memcmp(buffer, expected, length) == 0;
}

bool Integer(napi_env env, napi_value value, std::uint32_t minimum, std::uint32_t maximum, std::uint32_t* result) {
  double number;
  if (napi_get_value_double(env, value, &number) != napi_ok || !std::isfinite(number) ||
      number < minimum || number > maximum || std::floor(number) != number) return false;
  *result = static_cast<std::uint32_t>(number);
  return true;
}

bool Own(napi_env env, napi_value object, const char* name, napi_value value, napi_property_attributes attributes = napi_enumerable) {
  if (!value) return false;
  const napi_property_descriptor descriptor = {name, nullptr, nullptr, nullptr, nullptr, value, attributes, nullptr};
  return napi_define_properties(env, object, 1, &descriptor) == napi_ok;
}

bool RefValue(napi_env env, napi_ref reference, napi_value* value) {
  return napi_get_reference_value(env, reference, value) == napi_ok && *value != nullptr;
}

bool Property(napi_env env, napi_value object, const char* name, napi_value* value) {
  return napi_get_named_property(env, object, name, value) == napi_ok;
}

bool Header(napi_env env, napi_value headers, const char* name, const char* lowercase, napi_value* value) {
  napi_value alias;
  if (!Property(env, headers, name, value) || !Property(env, headers, lowercase, &alias)) return false;
  if (Is(env, *value, napi_undefined)) { *value = alias; return true; }
  return Is(env, alias, napi_undefined);
}

void FreeState(void* data) {
  // The environment itself releases these isolate-local references.
  delete static_cast<State*>(data);
}

bool CaptureBuiltins(napi_env env, State* state) {
  napi_value global, process, getter, module, request, ctor, map, get, set;
  napi_value specifier = String(env, "node:https");
  return specifier && napi_get_global(env, &global) == napi_ok &&
         Property(env, global, "process", &process) && Property(env, process, "getBuiltinModule", &getter) &&
         Is(env, getter, napi_function) && napi_call_function(env, process, getter, 1, &specifier, &module) == napi_ok &&
         Is(env, module, napi_object) && Property(env, module, "request", &request) && Is(env, request, napi_function) &&
         Property(env, global, "WeakMap", &ctor) && Is(env, ctor, napi_function) &&
         napi_new_instance(env, ctor, 0, nullptr, &map) == napi_ok &&
         Property(env, map, "get", &get) && Property(env, map, "set", &set) &&
         napi_create_reference(env, module, 1, &state->https) == napi_ok &&
         napi_create_reference(env, request, 1, &state->request) == napi_ok &&
         napi_create_reference(env, map, 1, &state->underlying) == napi_ok &&
         napi_create_reference(env, get, 1, &state->map_get) == napi_ok &&
         napi_create_reference(env, set, 1, &state->map_set) == napi_ok;
}

bool WeakMapCall(napi_env env, State* state, napi_ref method, std::size_t argc, napi_value* args, napi_value* result) {
  napi_value map, fn;
  return RefValue(env, state->underlying, &map) && RefValue(env, method, &fn) &&
         napi_call_function(env, map, fn, argc, args, result) == napi_ok;
}

napi_value SafeError(napi_env env, napi_value raw) {
  napi_value raw_name, raw_code;
  bool aborted = false;
  char code[65] = "AI_BUILTIN_TRANSPORT";
  if (Is(env, raw, napi_object)) {
    aborted = Property(env, raw, "name", &raw_name) && Equal(env, raw_name, "AbortError");
    char candidate[65];
    std::size_t length = 0;
    if (Property(env, raw, "code", &raw_code) && Is(env, raw_code, napi_string) &&
        napi_get_value_string_utf8(env, raw_code, nullptr, 0, &length) == napi_ok && length && length < sizeof(candidate) &&
        napi_get_value_string_utf8(env, raw_code, candidate, sizeof(candidate), &length) == napi_ok) {
      bool safe = true;
      for (std::size_t i = 0; i < length; ++i) {
        const char c = candidate[i];
        if (!((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-')) { safe = false; break; }
      }
      if (safe) std::memcpy(code, candidate, length + 1);
    }
  }
  aborted = aborted || std::strcmp(code, "ABORT_ERR") == 0 || std::strcmp(code, "AI_SEND_CANCELLED") == 0;
  napi_value error;
  const napi_value name = aborted ? String(env, "AbortError") : nullptr;
  const napi_value message = String(env, aborted ? "Built-in AI request cancelled." : "Built-in AI transport failed.");
  const napi_value error_code = String(env, code);
  if (!message || !error_code || napi_create_error(env, error_code, message, &error) != napi_ok ||
      (aborted && !Own(env, error, "name", name))) return nullptr;
  return error;
}

napi_value Facade(napi_env env, State* state, napi_value target, Kind kind);

struct Bridge {
  State* state;
  napi_ref callback;
  BridgeEvent event;
};

void FreeBridge(napi_env env, void* data, void*) {
  auto* bridge = static_cast<Bridge*>(data);
  if (bridge->callback) napi_delete_reference(env, bridge->callback);
  delete bridge;
}

napi_value Forward(napi_env env, napi_callback_info info) {
  std::size_t argc = 1;
  napi_value args[1], listener, receiver, result;
  void* data = nullptr;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, &data) != napi_ok) return TransportFailure(env);
  const auto* bridge = static_cast<Bridge*>(data);
  if (!bridge || !RefValue(env, bridge->callback, &listener) || napi_get_undefined(env, &receiver) != napi_ok) return nullptr;
  std::size_t count = 0;
  if (bridge->event == BridgeEvent::Data) {
    bool buffer = false;
    if (!argc || napi_is_buffer(env, args[0], &buffer) != napi_ok || !buffer) return receiver;
    count = 1;
  } else if (bridge->event == BridgeEvent::Error || bridge->event == BridgeEvent::Response) {
    if (!argc) return receiver;
    args[0] = bridge->event == BridgeEvent::Error ? SafeError(env, args[0]) : Facade(env, bridge->state, args[0], Kind::Response);
    if (!args[0]) return TransportFailure(env);
    count = 1;
  }
  return napi_call_function(env, receiver, listener, count, args, &result) == napi_ok ? result : TransportFailure(env);
}

bool MakeBridge(napi_env env, State* state, napi_value callback, BridgeEvent event, napi_value* function) {
  auto* bridge = new (std::nothrow) Bridge{state, nullptr, event};
  if (!bridge) return false;
  // A JS-visible edge on this private function keeps the callback alive without
  // rooting a cycle from the HTTP emitter back to the request facade in C++.
  if (napi_create_reference(env, callback, 0, &bridge->callback) != napi_ok ||
      napi_create_function(env, nullptr, 0, Forward, bridge, function) != napi_ok ||
      !Own(env, *function, "listener", callback, napi_default) ||
      napi_add_finalizer(env, *function, bridge, FreeBridge, nullptr, nullptr) != napi_ok) {
    FreeBridge(env, bridge, nullptr);
    return false;
  }
  return true;
}

bool EventKind(napi_env env, napi_value value, Kind kind, BridgeEvent* event) {
  if (Equal(env, value, "error")) { *event = BridgeEvent::Error; return true; }
  if (kind == Kind::Response && Equal(env, value, "data")) { *event = BridgeEvent::Data; return true; }
  *event = BridgeEvent::Empty;
  if (Equal(env, value, "close")) return true;
  return kind == Kind::Request ? Equal(env, value, "timeout")
       : Equal(env, value, "end") || Equal(env, value, "aborted");
}

napi_value InvokeMethod(napi_env env, napi_callback_info info) {
  std::size_t argc = 3;
  napi_value args[3], self, raw, result;
  void* data = nullptr;
  if (napi_get_cb_info(env, info, &argc, args, &self, &data) != napi_ok) return TransportFailure(env);
  const auto* method = static_cast<Method*>(data);
  bool correct_type = false;
  if (napi_check_object_type_tag(env, self, method->kind == Kind::Request ? &kRequestTag : &kResponseTag, &correct_type) != napi_ok ||
      !correct_type || !WeakMapCall(env, method->state, method->state->map_get, 1, &self, &raw) || !Is(env, raw, napi_object)) return Invalid(env);
  if (method->action == Action::Complete) {
    bool complete = false;
    if (Property(env, raw, "complete", &result)) napi_get_value_bool(env, result, &complete);
    return napi_get_boolean(env, complete, &result) == napi_ok ? result : TransportFailure(env);
  }
  if (method->action == Action::On || method->action == Action::Once) {
    BridgeEvent event;
    if (argc != 2 || !Is(env, args[1], napi_function) || !EventKind(env, args[0], method->kind, &event)) return Invalid(env);
    if (!MakeBridge(env, method->state, args[1], event, &args[1])) return TransportFailure(env);
  } else if (method->action == Action::End) {
    if (argc != 1 || !Is(env, args[0], napi_string)) return Invalid(env);
  } else if (method->action == Action::Timeout) {
    std::uint32_t ignored;
    if (argc != 1 || !Integer(env, args[0], 0, kMaxTimeoutMs, &ignored)) return Invalid(env);
  } else if (method->action == Action::Destroy) {
    if (argc > 1 || (argc == 1 && !Is(env, args[0], napi_object) && !Is(env, args[0], napi_undefined))) return Invalid(env);
  } else if (argc != 0) return Invalid(env);
  napi_value target_method;
  if (!Property(env, raw, method->target, &target_method) || napi_call_function(env, raw, target_method, argc, args, &result) != napi_ok)
    return TransportFailure(env);
  return self;
}

napi_value Facade(napi_env env, State* state, napi_value target, Kind kind) {
  napi_value view, stored;
  if (!Is(env, target, napi_object) || napi_create_object(env, &view) != napi_ok ||
      napi_type_tag_object(env, view, kind == Kind::Request ? &kRequestTag : &kResponseTag) != napi_ok) return nullptr;
  napi_value pair[] = {view, target};
  if (!WeakMapCall(env, state, state->map_set, 2, pair, &stored)) return nullptr;
  const std::size_t first = kind == Kind::Request ? 0 : 5;
  for (std::size_t i = first; i < first + 5; ++i) {
    auto* method = &state->methods[i];
    const bool complete = method->action == Action::Complete;
    const napi_property_descriptor descriptor = {
        method->target, nullptr, complete ? nullptr : InvokeMethod, complete ? InvokeMethod : nullptr,
        nullptr, nullptr, napi_enumerable, method};
    if (napi_define_properties(env, view, 1, &descriptor) != napi_ok) return nullptr;
  }
  if (kind == Kind::Response) {
    napi_value status, raw_headers, headers;
    std::uint32_t status_number;
    if (!Property(env, target, "statusCode", &status) || !Integer(env, status, 100, 599, &status_number) ||
        !Property(env, target, "headers", &raw_headers) || !Is(env, raw_headers, napi_object) ||
        napi_create_object(env, &headers) != napi_ok) return nullptr;
    for (const char* name : {"content-type", "content-length"}) {
      napi_value value;
      if (!Property(env, raw_headers, name, &value) || (Is(env, value, napi_string) && !Own(env, headers, name, value))) return nullptr;
    }
    if (!Own(env, view, "statusCode", status) || !Own(env, view, "headers", headers)) return nullptr;
  }
  return view;
}

bool RequestOptions(napi_env env, napi_value input, napi_value* options, napi_value* headers) {
  napi_value protocol, host, path, method, input_port, input_headers, type, length, accept, signal, timeout, port, tls;
  std::uint32_t number;
  if (!Is(env, input, napi_object) || !Property(env, input, "protocol", &protocol) ||
      (!Is(env, protocol, napi_undefined) && !Equal(env, protocol, "https:")) ||
      !Property(env, input, "hostname", &host) || !Equal(env, host, kHost) ||
      !Property(env, input, "path", &path) || !Equal(env, path, kPath) ||
      !Property(env, input, "method", &method) || !Equal(env, method, "POST") ||
      !Property(env, input, "port", &input_port) ||
      !(Is(env, input_port, napi_undefined) || Integer(env, input_port, 443, 443, &number) || Equal(env, input_port, "443")) ||
      !Property(env, input, "headers", &input_headers) || !Is(env, input_headers, napi_object) ||
      !Header(env, input_headers, "Content-Type", "content-type", &type) || !Equal(env, type, "application/json") ||
      !Header(env, input_headers, "Content-Length", "content-length", &length) || !Integer(env, length, 1, kMaxBodyBytes, &number) ||
      !Header(env, input_headers, "Accept", "accept", &accept) ||
      !(Is(env, accept, napi_undefined) || Equal(env, accept, "application/json") || Equal(env, accept, "text/event-stream")) ||
      !Property(env, input, "signal", &signal) || !(Is(env, signal, napi_undefined) || Is(env, signal, napi_object)) ||
      !Property(env, input, "timeout", &timeout) ||
      !(Is(env, timeout, napi_undefined) || Integer(env, timeout, 1, kMaxTimeoutMs, &number))) return false;
  return napi_create_object(env, options) == napi_ok && napi_create_object(env, headers) == napi_ok &&
         napi_create_uint32(env, 443, &port) == napi_ok && napi_get_boolean(env, true, &tls) == napi_ok &&
         Own(env, *headers, "Content-Type", type) && Own(env, *headers, "Content-Length", length) &&
         (Is(env, accept, napi_undefined) || Own(env, *headers, "Accept", accept)) &&
         Own(env, *options, "protocol", String(env, "https:")) && Own(env, *options, "hostname", host) &&
         Own(env, *options, "path", path) && Own(env, *options, "method", method) &&
         Own(env, *options, "port", port) && Own(env, *options, "rejectUnauthorized", tls) &&
         Own(env, *options, "headers", *headers) &&
         (Is(env, timeout, napi_undefined) || Own(env, *options, "timeout", timeout)) &&
         (Is(env, signal, napi_undefined) || Own(env, *options, "signal", signal));
}

struct AuthBuffer {
  std::array<char, kMaxCredentialBytes + sizeof(kBearer)> bytes{};
  ~AuthBuffer() {
    volatile char* data = bytes.data();
    for (std::size_t i = 0; i < bytes.size(); ++i) data[i] = 0;
  }
};

VEYLO_NOINLINE bool Decode(const EncodedCredential& data, char* output) {
  const volatile unsigned char* encrypted = data.encrypted;
  const volatile unsigned char* mask = data.mask;
  for (std::size_t i = 0; i < data.length; ++i) {
    const unsigned char byte = encrypted[i] ^ mask[i];
    if (byte <= 0x20 || byte >= 0x7f) return false;
    output[i] = static_cast<char>(byte);
  }
  return true;
}

bool Authorization(napi_env env, napi_value headers, const EncodedCredential& data) {
  if (!data.encrypted || !data.mask || !data.length || data.length > kMaxCredentialBytes) return false;
  constexpr std::size_t prefix_length = sizeof(kBearer) - 1;
  napi_value auth;
  {
    AuthBuffer secret;
    std::memcpy(secret.bytes.data(), kBearer, prefix_length);
    if (!Decode(data, secret.bytes.data() + prefix_length) ||
        napi_create_string_utf8(env, secret.bytes.data(), prefix_length + data.length, &auth) != napi_ok) return false;
  }
  return Own(env, headers, "Authorization", auth);
}

napi_value Dispatch(napi_env env, napi_callback_info info) {
  std::size_t argc = 4;
  napi_value args[4], options, headers, module, request, callback, raw;
  void* data = nullptr;
  std::uint32_t slot;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, &data) != napi_ok || argc != 3 || !Is(env, args[2], napi_function)) return Invalid(env);
  if (!kCredentialCount) return Fail(env, "AI_BUILTIN_UNAVAILABLE", "Built-in AI is not configured.");
  if (!Integer(env, args[0], 0, static_cast<std::uint32_t>(kCredentialCount), &slot) || slot >= kCredentialCount ||
      !RequestOptions(env, args[1], &options, &headers)) return Invalid(env);
  auto* state = static_cast<State*>(data);
  if (!RefValue(env, state->https, &module) || !RefValue(env, state->request, &request) ||
      !MakeBridge(env, state, args[2], BridgeEvent::Response, &callback) || !Authorization(env, headers, kCredentials[slot])) return TransportFailure(env);
  napi_value approved[] = {options, callback};
  if (napi_call_function(env, module, request, 2, approved, &raw) != napi_ok) return TransportFailure(env);
  const napi_value facade = Facade(env, state, raw, Kind::Request);
  if (facade) return facade;
  // If wrapping fails, do not leave a live request that the gate cannot cancel.
  napi_value destroy, ignored;
  if (Property(env, raw, "destroy", &destroy)) napi_call_function(env, raw, destroy, 0, nullptr, &ignored);
  return TransportFailure(env);
}

napi_value Slot(napi_env env, napi_callback_info info, bool advance, bool initial) {
  void* data = nullptr;
  napi_value result;
  std::size_t argc = 0;
  if (napi_get_cb_info(env, info, &argc, nullptr, nullptr, &data) != napi_ok) return TransportFailure(env);
  auto* state = static_cast<State*>(data);
  if constexpr (kCredentialCount > 0) {
    if (advance) state->slot = (state->slot + 1) % kCredentialCount;
  }
  const std::int32_t slot = !kCredentialCount ? -1 : static_cast<std::int32_t>(initial ? state->initial_slot : state->slot);
  return napi_create_int32(env, slot, &result) == napi_ok ? result : TransportFailure(env);
}

napi_value Current(napi_env env, napi_callback_info info) { return Slot(env, info, false, false); }
napi_value Next(napi_env env, napi_callback_info info) { return Slot(env, info, true, false); }
napi_value Initial(napi_env env, napi_callback_info info) { return Slot(env, info, false, true); }
}  // namespace

NAPI_MODULE_INIT() {
  auto* state = new (std::nothrow) State;
  if (!state) return TransportFailure(env);
  if constexpr (kCredentialCount > 1) {
    try {
      std::random_device random;
      state->slot = std::uniform_int_distribution<std::uint32_t>(0, static_cast<std::uint32_t>(kCredentialCount - 1))(random);
    } catch (...) { /* If OS randomness is unavailable, keep slot zero. */ }
  }
  state->initial_slot = state->slot;
  if (napi_add_env_cleanup_hook(env, FreeState, state) != napi_ok) {
    delete state;
    return TransportFailure(env);
  }
  napi_value count;
  if (!CaptureBuiltins(env, state) || napi_create_uint32(env, static_cast<std::uint32_t>(kCredentialCount), &count) != napi_ok ||
      !Own(env, exports, "url", String(env, kUrl)) || !Own(env, exports, "model", String(env, kModel)) ||
      !Own(env, exports, "keyCount", count)) return TransportFailure(env);
  const napi_property_descriptor methods[] = {
      {"currentSlot", nullptr, Current, nullptr, nullptr, nullptr, napi_enumerable, state},
      {"nextSlot", nullptr, Next, nullptr, nullptr, nullptr, napi_enumerable, state},
      {"initialSlot", nullptr, Initial, nullptr, nullptr, nullptr, napi_enumerable, state},
      {"dispatch", nullptr, Dispatch, nullptr, nullptr, nullptr, napi_enumerable, state},
  };
  return napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods) == napi_ok ? exports : TransportFailure(env);
}
