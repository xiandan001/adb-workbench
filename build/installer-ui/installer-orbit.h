#pragma once
#include <cmath>

namespace skin {
constexpr double kOrbitRotationDegrees = -16.0;
constexpr double kOrbitRadians = kOrbitRotationDegrees * 3.14159265358979323846 / 180.0;
constexpr double kOuterOrbitWidth = 160.0, kOuterOrbitHeight = 136.0;
constexpr double kInnerOrbitWidth = 132.0, kInnerOrbitHeight = 108.0;
struct OrbitPoint { double x, y; };

// Position and painted ellipse share the same radii and rotation. Angular
// progression never approximates the ellipse with a circular CSS-style orbit.
inline OrbitPoint EllipsePoint(double width, double height, double angle) {
  const double x = width * 0.5 * std::cos(angle), y = height * 0.5 * std::sin(angle);
  return {x * std::cos(kOrbitRadians) - y * std::sin(kOrbitRadians),
          x * std::sin(kOrbitRadians) + y * std::cos(kOrbitRadians)};
}
}
