const { randomUUID } = require('node:crypto');
const { tr } = require('./localization.cjs');
const { runHdc } = require('./hdc-runtime.cjs');
const { shellQuote, unsupportedDeviceOperation } = require('./device-platform.cjs');

const MAX_LAYOUT_BYTES = 4 * 1024 * 1024;
const MAX_NODES = 5000;
const fail = message => Object.assign(new Error(message), { code: 'HARMONY_TASK_INPUT', safe: true });
const number = value => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;

function normalizeHarmonyCoordinate(value) {
  if (value === '' || value === null || value === undefined) return null;
  const coordinate = number(value);
  if (coordinate === null || !Number.isInteger(coordinate) || coordinate < 0 || coordinate > 1000000) throw fail(tr('鸿蒙操作需要有效的目标控件或屏幕坐标。'));
  return coordinate;
}

function normalizeHarmonyDuration(step) {
  if (step.longPressMode === 'native' && step.durationMs == null) return null;
  if (step.durationMs === undefined || step.durationMs === null || step.durationMs === '') return 1000;
  const duration = number(step.durationMs);
  if (duration === null || duration <= 0 || duration > 600000) throw fail(tr('鸿蒙手势时长无效，未调整或忽略该参数。'));
  return duration;
}

function normalizeHarmonyPoints(value) {
  if (value === undefined || value === null || value === '') return [];
  let points = value;
  if (typeof points === 'string') {
    try { points = JSON.parse(points); } catch { throw fail(tr('鸿蒙手势路径不是有效 JSON，未忽略该参数。')); }
  }
  if (!Array.isArray(points) || points.length > 120) throw fail(tr('鸿蒙手势路径格式无效或超过上限。'));
  return points.map(point => {
    const x = normalizeHarmonyCoordinate(Array.isArray(point) ? point[0] : point?.x), y = normalizeHarmonyCoordinate(Array.isArray(point) ? point[1] : point?.y);
    if (x === null || y === null) throw fail(tr('鸿蒙手势路径缺少有效坐标。'));
    return { x, y };
  });
}

function layoutBounds(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch {
      const match = value.match(/^\s*\[(-?\d+),\s*(-?\d+)\]\[(-?\d+),\s*(-?\d+)\]\s*$/);
      if (!match) return null;
      value = { left: Number(match[1]), top: Number(match[2]), right: Number(match[3]), bottom: Number(match[4]) };
    }
  }
  if (!value || typeof value !== 'object') return null;
  const bounds = Object.fromEntries(['left', 'top', 'right', 'bottom'].map(key => [key, number(value[key])]));
  if (Object.values(bounds).some(value => value === null || Math.abs(value) > 1000000) || bounds.right <= bounds.left || bounds.bottom <= bounds.top) return null;
  return bounds;
}

function parseHarmonyLayout(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_LAYOUT_BYTES) throw fail(tr('鸿蒙界面树过大或格式无效，请缩小目标界面后重试。'));
  let tree;
  try { tree = JSON.parse(raw); } catch { throw fail(tr('鸿蒙界面树不是有效 JSON，未执行控件操作。')); }
  const nodes = [], stack = [{ value: tree, xpath: 'ROOT', bundle: '', depth: 0 }];
  let inspected = 0;
  while (stack.length) {
    const { value, xpath, bundle, depth } = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (++inspected > MAX_NODES * 3 || depth > 64) throw fail(tr('鸿蒙界面树过大或格式无效，请缩小目标界面后重试。'));
    if (Array.isArray(value)) { value.forEach((item, index) => stack.push({ value: item, xpath: `${xpath},${index}`, bundle, depth: depth + 1 })); continue; }
    const source = value.attributes && typeof value.attributes === 'object' ? value.attributes : value;
    const ownBundle = String(source.bundleName || source.bundle || source.packageName || bundle).slice(0, 500);
    const bounds = layoutBounds(source.bounds || source.Bounds);
    if (bounds) {
      if (nodes.length >= MAX_NODES) throw fail(tr('鸿蒙界面树过大或格式无效，请缩小目标界面后重试。'));
      const password = source.password === true || source.password === 'true' || source.isPassword === true || source.isPassword === 'true' || /password/i.test(String(source.inputType || ''));
      const attrs = { text: password ? '' : String(source.text || '').slice(0, 2000),
        'resource-id': String(source.id || source.resourceId || source.key || '').slice(0, 500),
        'content-desc': password ? '' : String(source.description || source.accessibilityText || source['content-desc'] || '').slice(0, 500),
        class: String(source.type || source.class || '').slice(0, 500), package: ownBundle, password: String(password),
        bounds: `[${bounds.left},${bounds.top}][${bounds.right},${bounds.bottom}]` };
      nodes.push({ attrs, bounds, xpath: String(source.hierarchy || xpath).slice(0, 2000) });
    }
    const children = value.children || value.childNodes;
    if (Array.isArray(children)) for (let index = children.length - 1; index >= 0; index--) stack.push({ value: children[index], xpath: `${xpath},${index}`, bundle: ownBundle, depth: depth + 1 });
    else if (!bounds) for (const [key, child] of Object.entries(value)) if (key !== 'attributes' && child && typeof child === 'object') stack.push({ value: child, xpath: `${xpath},${key}`, bundle: ownBundle, depth: depth + 1 });
  }
  return nodes;
}

async function captureHarmonyLayout(deviceId, options = {}, run = runHdc) {
  const remotePath = `/data/local/tmp/awb-layout-${randomUUID()}.json`;
  try {
    const dumped = await run(deviceId, ['shell', 'uitest', 'dumpLayout', '-p', remotePath], options);
    if (!dumped.ok) throw fail(dumped.error || tr('鸿蒙控件树采集失败。'));
    const read = await run(deviceId, ['shell', 'cat', remotePath], { ...options, maxBuffer: MAX_LAYOUT_BYTES });
    if (!read.ok) throw fail(read.error || tr('鸿蒙控件树读取失败。'));
    const raw = String(read.stdout || '');
    return { nodes: parseHarmonyLayout(raw), rawLength: raw.length };
  } finally {
    await run(deviceId, ['shell', `rm -f ${shellQuote(remotePath)}`], { ...options, signal: undefined, isCancelled: undefined, timeoutMs: 3000 }).catch(() => {});
  }
}

function harmonyKey(value) {
  const key = String(value || '').trim();
  const logical = { HOME: 'Home', BACK: 'Back', POWER: 'Power' }[key.toUpperCase()];
  if (logical) return logical;
  const native = /^native:(\d{1,5})$/.exec(key);
  if (native) return native[1];
  throw fail(tr('鸿蒙按键请使用 Home、Back、Power 或 native:键码；不能直接使用 Android 数字键码。'));
}

function requiredPoint(point) {
  const x = number(point?.x), y = number(point?.y);
  if (x === null || y === null || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 1000000 || y > 1000000) throw fail(tr('鸿蒙操作需要有效的目标控件或屏幕坐标。'));
  return [String(x), String(y)];
}

function buildHarmonyInput(step, point, capabilities) {
  const prefix = ['shell', 'uitest', 'uiInput'];
  if (step.type === 'keyevent') return [...prefix, 'keyEvent', harmonyKey(step.keyCode)];
  if (step.type === 'tap') return [...prefix, 'click', ...requiredPoint(point)];
  if (step.type === 'longPress') {
    if (step.longPressMode !== 'native' || step.durationMs !== null && step.durationMs !== undefined) throw fail(tr('UITest 长按不支持指定毫秒时长；请改用明确的“设备原生长按”步骤。'));
    return [...prefix, 'longClick', ...requiredPoint(point)];
  }
  if (step.type === 'swipe') {
    if ((step.points || []).length > 2) throw fail(tr('鸿蒙 UITest 不能保持曲线手势，请改用直线滑动步骤。'));
    const start = requiredPoint(point), end = requiredPoint({ x: step.endX, y: step.endY });
    if (step.points?.length && (step.points.length !== 2 || Number(start[0]) !== step.points[0].x || Number(start[1]) !== step.points[0].y
      || Number(end[0]) !== step.points[1].x || Number(end[1]) !== step.points[1].y)) throw fail(tr('鸿蒙滑动路径与起止坐标不一致，未忽略路径参数。'));
    const duration = number(step.durationMs), distance = Math.hypot(Number(end[0]) - Number(start[0]), Number(end[1]) - Number(start[1]));
    const velocity = duration > 0 ? Math.round(distance * 1000 / duration) : 0;
    if (!distance || velocity < 200 || velocity > 40000) throw fail(tr('该滑动时长无法转换为 UITest 支持的 200–40000 px/s，请调整距离或时长。'));
    return [...prefix, 'swipe', ...start, ...end, String(velocity)];
  }
  if (step.type === 'input') {
    const text = String(step.text || '');
    if (!text || text.includes('\0')) throw fail(tr('请输入有效文本。'));
    if (point) return [...prefix, 'inputText', ...requiredPoint(point), text];
    if (!(capabilities.apiVersion >= 18 && capabilities.focusText)) throw fail(tr('当前焦点输入需要 API 18 及以上且 UITest 支持 text；请选中输入控件或填写坐标。'));
    return [...prefix, 'text', text];
  }
  throw unsupportedDeviceOperation(step.type);
}

async function probeHarmonyUi(deviceId, options = {}, run = runHdc) {
  const help = await run(deviceId, ['shell', 'uitest', 'uiInput', 'help'], { ...options, maxBuffer: 64 * 1024 });
  if (help.cancelled) throw Object.assign(new Error(tr('用户取消')), { code: 'CANCELLED' });
  if (!help.ok) throw fail(help.error || tr('所选设备 UITest 不可用，未执行输入操作。'));
  const api = await run(deviceId, ['shell', 'param', 'get', 'const.ohos.apiversion'], { ...options, maxBuffer: 4096 });
  if (api.cancelled) throw Object.assign(new Error(tr('用户取消')), { code: 'CANCELLED' });
  const text = String(help.stdout || '');
  return { apiVersion: api.ok && /^\d+$/.test(String(api.stdout || '').trim()) ? Number(String(api.stdout).trim()) : null,
    focusText: /(?:^|[\n|<])\s*(?:uitest\s+uiInput\s+)?text(?=[\s|>]|$)/m.test(text),
    help: text };
}

async function performHarmonyInput(deviceId, step, point, options = {}, run = runHdc) {
  // Parameter errors fail before even querying a device; only focus input needs capabilities first.
  if (step.type !== 'input' || point) buildHarmonyInput(step, point, {});
  const capabilities = options.uitestCapabilities || await probeHarmonyUi(deviceId, options, run);
  const args = buildHarmonyInput(step, point, capabilities);
  if (!new RegExp(`\\b${args[3]}\\b`).test(capabilities.help)) throw fail(tr('所选设备 UITest 不支持此输入操作，未执行。'));
  const result = await run(deviceId, args, options);
  return { ...result, output: result.stdout || result.error || '' };
}

module.exports = { MAX_LAYOUT_BYTES, parseHarmonyLayout, captureHarmonyLayout, layoutBounds, harmonyKey, buildHarmonyInput, probeHarmonyUi, performHarmonyInput, normalizeHarmonyCoordinate, normalizeHarmonyDuration, normalizeHarmonyPoints };
