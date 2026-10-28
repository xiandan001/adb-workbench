function getMainWindowBounds(workArea) {
  // The sidebar needs 920 content DIP; 960 outer DIP also accommodates the native frame.
  // Electron workArea is already DIP and excludes the taskbar. Do not apply scaleFactor again.
  // Leave 8 DIP per edge for native frame rounding at fractional display scales.
  const width = Math.min(1600, workArea.width - 16);
  const height = Math.min(960, workArea.height - 16);
  return {
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + Math.floor((workArea.height - height) / 2),
    width, height,
    minWidth: Math.min(900, width),
    minHeight: Math.min(600, height),
  };
}

module.exports = { getMainWindowBounds };
