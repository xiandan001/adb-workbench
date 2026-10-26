#pragma once
#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>

namespace skin {
enum class InstallPhase { None, Deploying, Configuring, Completed };
struct PhaseEntry { InstallPhase phase = InstallPhase::None; uint64_t elapsedSeconds = 0; };
struct InstallationProgress {
  static constexpr uint64_t kStaleMilliseconds = 2000;
  bool started = false, sampleValid = false;
  uint64_t startedAt = 0, changedAt = 0;
  int minimum = 0, maximum = 0, position = 0;
  InstallPhase phase = InstallPhase::None;
  std::array<PhaseEntry, 3> history{};
  std::size_t historyCount = 0;

  uint64_t Elapsed(uint64_t now) const { return started && now >= startedAt ? (now - startedAt) / 1000 : 0; }
  void SetPhase(InstallPhase next, uint64_t now) {
    if (next <= phase || next > InstallPhase::Completed) return;
    if (!started) { started = true; startedAt = changedAt = now; }
    phase = next;
    if (historyCount < history.size()) history[historyCount++] = {next, Elapsed(now)};
  }
  void Start(uint64_t now) { *this = InstallationProgress{}; SetPhase(InstallPhase::Deploying, now); }
  bool Observe(bool valid, int low, int high, int value, uint64_t now) {
    valid = valid && high > low;
    const bool changed = valid != sampleValid || (valid && (low != minimum || high != maximum || value != position));
    if (valid && changed) changedAt = now;
    sampleValid = valid;
    if (valid) { minimum = low; maximum = high; position = value; }
    return changed;
  }
  bool Determinate(uint64_t now) const {
    return sampleValid && position < maximum && now >= changedAt && now - changedAt < kStaleMilliseconds;
  }
  double Fraction() const {
    return sampleValid ? std::clamp((static_cast<double>(position) - minimum) / (static_cast<double>(maximum) - minimum), 0.0, 1.0) : 0;
  }
  int Percent() const { return static_cast<int>(Fraction() * 100); }
};
}
