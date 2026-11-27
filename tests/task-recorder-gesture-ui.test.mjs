import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'rolldown/utils';
import { appendRecorderGesturePoint, classifyRecorderGesture, mergeRecordedStepPatch, recorderPreviewPoint } from '../src/shared/taskRecorderGesture.js';

const source = readFileSync(new URL('../src/components/TaskCenter.jsx', import.meta.url), 'utf8');
const model = source.slice(source.indexOf('function StressRecorder('), source.indexOf('function RecorderPreviewSurface(')) +
  source.slice(source.indexOf('function clearRecorderPointer('), source.indexOf('function formatSvgPoints('));
const code = transformSync('StressRecorder.jsx', model, { jsx: { runtime: 'classic', pragma: 'jsx', pragmaFrag: 'Fragment' } }).code;
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props.children].flat(Infinity).flatMap(nodes)];
const point = (x, y) => ({ x, y });
const snapshot = (id = 'USB1') => ({ deviceId: id, screenshotDataUrl: 'screenshot-1', screenshotWidth: 1000, screenshotHeight: 1000, nodes: [], longPress: {}, swipe: {} });

function mount({ recorder = snapshot(), tapOnly = false } = {}) {
  const calls = [], patches = [], slots = [], captures = new Set();
  let cursor = 0, clock = 0;
  const element = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 500 }),
    setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id), releasePointerCapture: id => captures.delete(id),
  };
  const icons = Object.fromEntries('CheckCircle2 ChevronDown Clock3 Loader2 Maximize2 NumberField RefreshCw Smartphone TaskAiTargets Terminal TextField Trash2'.split(' ').map(name => [name, 'icon']));
  const render = runInNewContext(`(function(){${code};return StressRecorder;})()`, {
    ...icons, RecorderPreviewSurface: 'preview', Fragment: 'fragment', tr: label => label, useLocale() {}, useEffect() {},
    appendRecorderGesturePoint, classifyRecorderGesture, recorderPreviewPoint,
    taskPlatformForDevice: id => id.startsWith('hdc:') ? 'harmony' : 'android',
    findNodeAtPoint: () => null, performance: { now: () => clock },
    jsx: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useRef: value => (slots[cursor++] ??= { current: value }),
    useState(value) { const slot = slots[cursor++] ??= { value }; return [slot.value, next => { slot.value = next; }]; },
  });
  function surface() {
    cursor = 0;
    const view = render({ recorder, tapOnly, focusedMode: true, onlineDevices: [{ id: recorder.deviceId }],
      onChange: patch => patches.push(structuredClone(patch)), onRecord: (...call) => calls.push(structuredClone(call)) });
    const preview = nodes(view).find(node => node.type === 'preview');
    preview.props.previewRef.current = element;
    return preview.props;
  }
  function event(kind, x, y, { id = 1, button = 0, primary = true } = {}) {
    surface()[`onPointer${kind}`]({ clientX: x, clientY: y, currentTarget: element, pointerId: id, button, isPrimary: primary });
  }
  return { event, calls, patches, captures, time: value => { clock = value; }, patch: value => { recorder = { ...recorder, ...value }; } };
}

test('the focused recorder captures one action on pointer-up, distinguishing click, long press, straight and closed curve', () => {
  const ui = mount();
  ui.event('Down', 50, 50);
  assert.deepEqual(ui.calls, []);
  ui.event('Up', 50, 50);
  ui.event('Down', 60, 60); ui.time(700); ui.event('Up', 61, 60);
  ui.event('Down', 50, 50); ui.event('Move', 100, 50); ui.event('Move', 150, 51); ui.time(950); ui.event('Up', 200, 50);
  ui.event('Down', 50, 50); ui.event('Move', 100, 100); ui.event('Move', 160, 50); ui.time(1175); ui.event('Up', 50, 50);
  assert.deepEqual(ui.calls.map(call => call[0]), ['tap', 'longPress', 'swipe', 'swipe']);
  assert.equal(ui.calls[1][1].durationMs, 700);
  assert.deepEqual(ui.calls[2][1].points, [point(100, 100), point(400, 100)]);
  assert.equal(ui.calls[2][1].curve, false);
  assert.deepEqual(ui.calls[3][1].points, [point(100, 100), point(200, 200), point(320, 100), point(100, 100)]);
  assert.equal(ui.calls[3][1].curve, true);
  assert.equal(ui.captures.size, 0);
});

test('invalid, cancelled and stale/screenshot-changed gestures release capture and never record', () => {
  const ui = mount();
  ui.event('Down', 50, 50, { button: 2 }); ui.event('Up', 50, 50);
  ui.event('Down', -5, 40); ui.event('Up', 50, 50);
  ui.event('Down', 40, 40); ui.event('Up', 50, 50, { id: 2 });
  assert.equal(ui.captures.has(1), true);
  ui.event('Cancel', 40, 40); ui.event('Up', 40, 40);
  ui.event('Down', 40, 40); ui.event('Up', Number.NaN, 40);
  ui.event('Down', 40, 40); ui.patch({ screenshotDataUrl: 'new-view' }); ui.event('Up', 40, 40);
  assert.deepEqual(ui.calls, []);
  assert.equal(ui.captures.size, 0);
});

test('guided recording only accepts taps; Harmony records native long press and straight swipe but never curves', () => {
  const guided = mount({ tapOnly: true });
  guided.event('Down', 50, 50); guided.event('Move', 100, 100); guided.event('Up', 150, 50);
  guided.event('Down', 60, 60); guided.event('Up', 60, 60);
  assert.deepEqual(guided.calls.map(call => call[0]), ['tap']);
  const harmony = mount({ recorder: snapshot('hdc:1') });
  harmony.event('Down', 60, 60); harmony.time(700); harmony.event('Up', 60, 60);
  harmony.event('Down', 50, 50); harmony.time(900); harmony.event('Up', 100, 50);
  harmony.event('Down', 50, 50); harmony.event('Move', 100, 100); harmony.event('Up', 150, 50);
  assert.deepEqual(harmony.calls.map(call => call[0]), ['longPress', 'swipe']);
  assert.equal(harmony.calls[0][1].longPressMode, 'native');
  assert.equal(harmony.calls[0][1].durationMs, null);
  assert.match(harmony.patches.at(-1).error, /不能保持曲线手势/);
});

test('geometry excludes letterbox presses and long paths retain original endpoints', () => {
  const rect = { left: 10, top: 20, width: 1000, height: 460 };
  assert.equal(recorderPreviewPoint({ clientX: 20, clientY: 250 }, rect, 1920, 1080), null);
  assert.deepEqual(recorderPreviewPoint({ clientX: 510, clientY: 250 }, rect, 1920, 1080), point(960, 540));
  assert.deepEqual(recorderPreviewPoint({ clientX: 20, clientY: 250 }, rect, 1920, 1080, true), point(0, 540));
  const raw = Array.from({ length: 200 }, (_, index) => point(4 * index, 400 + Math.round(150 * Math.sin(index / 4))));
  const sampled = raw.reduce((points, next) => appendRecorderGesturePoint(points, next), []);
  const points = appendRecorderGesturePoint(sampled, raw.at(-1), true);
  const swipe = classifyRecorderGesture({ points, elapsedMs: 1800, width: 1000, height: 1000 });
  assert.ok(points.length <= 120 && swipe.args.points.length <= 48);
  assert.equal(swipe.args.curve, true);
  assert.deepEqual(swipe.args.points[0], raw[0]);
  assert.deepEqual(swipe.args.points.at(-1), raw.at(-1));
});

test('edited endpoints and recorded trajectory stay synchronized', () => {
  const step = { type: 'swipe', x: 1, y: 2, endX: 5, endY: 6, points: [point(1, 2), point(3, 4), point(5, 6)] };
  assert.deepEqual(mergeRecordedStepPatch(step, { x: 0, endY: 20 }).points, [point(0, 2), point(3, 4), point(5, 20)]);
  const curve = mergeRecordedStepPatch(step, { points: '[{"x":10,"y":20},{"x":30,"y":40}]' });
  assert.deepEqual([curve.x, curve.y, curve.endX, curve.endY], [10, 20, 30, 40]);
  assert.equal(mergeRecordedStepPatch(step, { x: '' }).points[0].x, '');
  assert.equal(step.points[0].x, 1);
});
