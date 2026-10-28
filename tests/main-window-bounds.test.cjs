const test = require('node:test');
const assert = require('node:assert/strict');
const { getMainWindowBounds } = require('../electron/lib/main-window-bounds.cjs');

test('default outer height leaves room for the complete sidebar and native frame', () => {
  assert.deepEqual(getMainWindowBounds({ x: 0, y: 0, width: 1920, height: 1040 }), {
    x: 160, y: 40, width: 1600, height: 960, minWidth: 900, minHeight: 600,
  });
});

test('small logical work areas clamp both window and minimum size without hiding menu items', () => {
  for (const area of [
    { x: 0, y: 0, width: 1366, height: 728 },
    { x: 0, y: 40, width: 1280, height: 680 },
    { x: 48, y: 0, width: 752, height: 560 },
  ]) {
    const result = getMainWindowBounds(area);
    assert.equal(result.width, area.width - 16); assert.equal(result.height, area.height - 16);
    assert.equal(result.x, area.x + 8); assert.equal(result.y, area.y + 8);
    assert.equal(result.minWidth, Math.min(900, result.width));
    assert.equal(result.minHeight, Math.min(600, result.height));
  }
});

test('taskbar offsets and negative monitor origins are retained when centering', () => {
  assert.deepEqual(getMainWindowBounds({ x: -1920, y: -1040, width: 1920, height: 1040 }), {
    x: -1760, y: -1000, width: 1600, height: 960, minWidth: 900, minHeight: 600,
  });
  assert.deepEqual(getMainWindowBounds({ x: 80, y: 48, width: 1840, height: 1032 }), {
    x: 200, y: 84, width: 1600, height: 960, minWidth: 900, minHeight: 600,
  });
});

test('workArea already uses DIP and must not be multiplied by display scale', () => {
  const area = { x: 0, y: 0, width: 1536, height: 824 };
  for (const scaleFactor of [1, 1.25, 1.5, 2, 3]) {
    assert.deepEqual(getMainWindowBounds({ ...area, scaleFactor }), getMainWindowBounds(area));
  }
});

test('every supported geometry stays inside its work area with attainable minimums', () => {
  for (const x of [-2560, 0, 2560]) for (const width of [800, 900, 1366, 1600, 1920, 2560]) {
    for (const height of [560, 600, 728, 824, 960, 1040, 1400]) {
      const area = { x, y: 37, width, height }, result = getMainWindowBounds(area);
      assert.ok(Object.values(result).every(Number.isInteger));
      assert.ok(result.x >= area.x + 8 && result.y >= area.y + 8);
      assert.ok(result.x + result.width + 8 <= area.x + area.width);
      assert.ok(result.y + result.height + 8 <= area.y + area.height);
      assert.ok(result.minWidth <= result.width && result.minHeight <= result.height);
      assert.ok(result.width <= 1600 && result.height <= 960);
    }
  }
});
