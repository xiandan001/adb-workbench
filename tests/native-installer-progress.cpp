#include "../build/installer-ui/installer-progress.h"
#include <cstdio>
#include <stdexcept>

void Check(bool condition, const char* name) {
  if (!condition) throw std::runtime_error(name);
  std::printf("PASS %s\n", name);
}
int main() {
  try {
    using skin::InstallPhase;
    skin::InstallationProgress progress;
    Check(!progress.Determinate(0), "no invented progress before an engine sample");
    progress.Start(1000);
    Check(progress.phase == InstallPhase::Deploying && progress.historyCount == 1, "start records only the observed deployment stage");
    Check(progress.Elapsed(900) == 0 && progress.Elapsed(4000) == 3, "elapsed time is monotonic and based on start");
    Check(progress.Observe(true, 0, 1000, 410, 1100), "first actual 41 percent sample recorded");
    Check(progress.Percent() == 41 && progress.Determinate(3099), "actual percentage remains determinate before two seconds");
    Check(!progress.Determinate(3100), "exact two-second stall switches to activity");
    Check(!progress.Observe(true, 0, 1000, 410, 60000), "unchanged polls do not reset stall time");
    Check(progress.Percent() == 41 && !progress.Determinate(60000), "a long wait never manufactures percentage movement");
    Check(progress.Observe(true, 0, 1000, 411, 60100) && progress.Determinate(60100), "raw progress movement resumes determinate even below one percent");
    Check(progress.Observe(true, 0, 100, 7, 60200) && progress.Percent() == 7, "new genuine range is honored without forced monotonic fake progress");
    Check(progress.Observe(false, 0, 0, 0, 60300) && !progress.Determinate(60300), "missing engine data is activity immediately");
    Check(!progress.Observe(true, 2, 2, 2, 60400) && !progress.sampleValid, "zero range rejected");
    progress.SetPhase(InstallPhase::Configuring, 61000);
    Check(progress.historyCount == 2 && progress.history[1].elapsedSeconds == 60, "configuration stage keeps real elapsed history");
    progress.SetPhase(InstallPhase::Configuring, 62000);
    progress.SetPhase(InstallPhase::Deploying, 63000);
    Check(progress.historyCount == 2 && progress.phase == InstallPhase::Configuring, "duplicate or stale phase messages cannot rewrite history");
    progress.SetPhase(InstallPhase::Completed, 65000);
    Check(progress.historyCount == 3 && progress.history[2].elapsedSeconds == 64, "completion is recorded only on the completion event");
    Check(!progress.sampleValid, "completion never writes a simulated PBM value");
    progress.Start(90000);
    Check(progress.historyCount == 1 && progress.Elapsed(90000) == 0 && !progress.sampleValid, "a new run resets the prior observation state");
    skin::InstallationProgress boundary;
    boundary.Start(0);
    boundary.Observe(true, 0, 1000, 1000, 100);
    Check(!boundary.Determinate(100), "engine phase maximum immediately uses activity instead of overall 100 percent");
    Check(boundary.position == 1000 && boundary.maximum == 1000 && boundary.Percent() == 100, "phase maximum remains unchanged in the raw engine snapshot");
    Check(boundary.phase == InstallPhase::Deploying && boundary.historyCount == 1, "engine phase maximum does not announce installation completion");
    boundary.Observe(true, 0, 1000, 560, 200);
    Check(boundary.Determinate(200) && boundary.Percent() == 56, "later genuine 56 percent resumes without fake monotonic progress");
    boundary.Observe(true, 0, 1000, 1001, 300);
    Check(!boundary.Determinate(300) && boundary.position == 1001, "an over-range engine sample also stays activity without rewriting the sample");
    std::puts("Native progress model checks passed.");
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "FAIL %s\n", error.what());
    return 1;
  }
}
