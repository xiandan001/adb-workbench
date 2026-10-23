import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';

const script = () => readFileSync(new URL('../public/startup.js', import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
function harness({ reduced = false, startupAnimation = true, reducedPreference = false, native = false, bridgeThrows = false } = {}) {
  const timers = new Map(); const listeners = new Map(); const marks = []; const notifications = []; let nextTimer = 0; let reloads = 0;
  const nodes = Object.fromEntries(['app-startup', 'root', 'startup-status', 'startup-detail', 'startup-retry'].map(id => [id, {
    id, dataset: { state: 'loading' }, hidden: id === 'startup-retry', textContent: '', attributes: new Map(id === 'root' ? [['inert', ''], ['aria-busy', 'true']] : []),
    setAttribute(key, value) { this.attributes.set(key, value); }, removeAttribute(key) { this.attributes.delete(key); },
    addEventListener(name, fn) { this[name] = fn; }, removeEventListener(name) { delete this[name]; },
    remove() { this.removed = true; }, focus() { this.focused = true; },
  }]));
  const window = { matchMedia: () => ({ matches: reduced }), location: { reload: () => { reloads++; } },
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  if (native) window.electronAPI = Object.fromEntries(['Ready', 'Failed'].map(kind => [`startupPresentation${kind}`, (...args) => { notifications.push({ kind, args }); if (bridgeThrows) throw new Error('bridge unavailable'); }]));
  runInNewContext(script(), { window, document: { getElementById: id => nodes[id], documentElement: { dataset: { startupAnimation: String(startupAnimation), reducedMotion: String(reducedPreference), nativeDesktop: String(native) } } },
    performance: { mark: name => marks.push(name) },
    setTimeout: (fn, ms) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; }, clearTimeout: id => timers.delete(id) });
  return { window, nodes, timers, listeners, marks, notifications, reloads: () => reloads,
    tick(ms) { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } } };
}

test('startup completes immediately on actual ready with only a short nonblocking fade, never a minimum wait', () => {
  const h = harness(); h.window.__workbenchStartup.complete();
  assert.equal(h.nodes['app-startup'].dataset.state, 'leaving');
  assert.equal(h.nodes.root.attributes.has('inert'), false);
  assert.equal(h.nodes.root.attributes.get('aria-busy'), 'false');
  assert.equal(h.nodes['app-startup'].attributes.has('inert'), true);
  assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].ms, 180);
  h.window.__workbenchStartup.complete(); h.tick(180);
  assert.equal(h.nodes['app-startup'].removed, true); assert.equal(h.timers.size, 0); assert.equal(h.listeners.size, 0);
  assert.equal(h.marks.filter(mark => mark === 'workbench-startup-ready').length, 1);
});

test('native desktop reports actual readiness once and removes legacy surface immediately without a duplicate fade', () => {
  const h = harness({ native: true });
  assert.equal(h.nodes.root.attributes.has('inert'), true); assert.deepEqual(h.notifications, []);
  h.window.__workbenchStartup.complete(); h.window.__workbenchStartup.complete();
  assert.equal(h.nodes['app-startup'].removed, true); assert.equal(h.timers.size, 0);
  assert.equal(h.nodes.root.attributes.has('inert'), false); assert.equal(h.nodes.root.attributes.get('aria-busy'), 'false');
  assert.deepEqual(h.notifications, [{ kind: 'Ready', args: [] }]);
});

test('native slow and failed bootstrap reveal main through a payload-free failure signal without a false ready', () => {
  const slow = harness({ native: true }); slow.tick(6000);
  assert.equal(slow.nodes['app-startup'].dataset.state, 'slow'); assert.equal(slow.nodes.root.attributes.has('inert'), true);
  assert.deepEqual(slow.notifications, [{ kind: 'Failed', args: [] }]);
  slow.window.__workbenchStartup.fail('安全说明'); slow.window.__workbenchStartup.complete();
  assert.deepEqual(slow.notifications, [{ kind: 'Failed', args: [] }]); assert.notEqual(slow.nodes['app-startup'].removed, true);
  const lateReady = harness({ native: true }); lateReady.tick(6000); lateReady.window.__workbenchStartup.complete();
  assert.deepEqual(lateReady.notifications, [{ kind: 'Failed', args: [] }, { kind: 'Ready', args: [] }]); assert.equal(lateReady.nodes['app-startup'].removed, true);
});

test('native disabled/reduced preferences do not skip safety or add renderer delay; bridge failure cannot strand the root', () => {
  for (const preferences of [{ startupAnimation: false }, { reducedPreference: true }, { reduced: true }, { bridgeThrows: true }]) {
    const h = harness({ native: true, ...preferences }); h.window.__workbenchStartup.complete();
    assert.equal(h.nodes['app-startup'].removed, true); assert.equal(h.nodes.root.attributes.has('inert'), false); assert.equal(h.timers.size, 0);
    assert.deepEqual(h.notifications, [{ kind: 'Ready', args: [] }]);
  }
  const h = harness({ native: true, startupAnimation: false }); h.window.__workbenchStartup.fail('安全说明');
  assert.equal(h.nodes['app-startup'].hidden, false); assert.equal(h.nodes['startup-retry'].hidden, false);
  assert.deepEqual(h.notifications, [{ kind: 'Failed', args: [] }]);
});

test('native desktop fallback stays static while browser fallback retains its local presentation', () => {
  const css = readFileSync(new URL('../public/startup.css', import.meta.url), 'utf8');
  assert.match(css, /data-native-desktop="true"[^{}]*\.startup-stage\s*\{[^}]*transition:\s*none/);
  assert.match(css, /data-native-desktop="true"[^{}]*\.startup-visual\s*\*\s*\{[^}]*animation:\s*none/);
  assert.match(css, /data-native-desktop="true"[^{}]*\.startup-scan\s*\{[^}]*display:\s*none/);
  const browser = harness(); browser.window.__workbenchStartup.complete(); assert.equal(browser.timers.size, 1); browser.tick(180);
  assert.equal(browser.nodes['app-startup'].removed, true); assert.deepEqual(browser.notifications, []);
});

test('reduced-motion users get no exit delay', () => {
  const h = harness({ reduced: true }); h.window.__workbenchStartup.complete();
  assert.equal(h.nodes['app-startup'].removed, true); assert.equal(h.timers.size, 0);
});

test('saved animation-off preference skips the surface and fade but never skips startup safety', () => {
  const h = harness({ startupAnimation: false }); assert.equal(h.nodes['app-startup'].hidden, true);
  assert.equal(h.nodes.root.attributes.has('inert'), true);
  h.window.__workbenchStartup.complete(); assert.equal(h.nodes['app-startup'].removed, true); assert.equal(h.timers.size, 0);
  const failed = harness({ startupAnimation: false }); failed.window.__workbenchStartup.fail('启动失败');
  assert.equal(failed.nodes['app-startup'].hidden, false); assert.equal(failed.nodes['startup-retry'].hidden, false);
  const slow = harness({ startupAnimation: false }); slow.tick(6000); assert.equal(slow.nodes['app-startup'].hidden, false);
  const reduced = harness({ reducedPreference: true }); reduced.window.__workbenchStartup.complete(); assert.equal(reduced.nodes['app-startup'].removed, true);
});

test('slow loading never pretends ready and permits retry or later real completion', () => {
  const h = harness(); h.tick(6000);
  assert.equal(h.nodes['app-startup'].dataset.state, 'slow'); assert.equal(h.nodes.root.attributes.has('inert'), true);
  assert.equal(h.nodes['startup-retry'].hidden, false); h.nodes['startup-retry'].click(); assert.equal(h.reloads(), 1);
  h.window.__workbenchStartup.complete(); h.tick(180); assert.equal(h.nodes['app-startup'].removed, true);
});

test('failed startup is readable, never removed by a late ready callback, and does not repeat timers', () => {
  const h = harness(); h.window.__workbenchStartup.fail('数据恢复未完成，请保留恢复备份。');
  assert.equal(h.nodes['app-startup'].dataset.state, 'error'); assert.equal(h.nodes['app-startup'].attributes.get('role'), 'alert');
  assert.equal(h.nodes['startup-detail'].textContent, '数据恢复未完成，请保留恢复备份。');
  assert.equal(h.nodes['startup-retry'].focused, true); assert.equal(h.timers.size, 0);
  h.window.__workbenchStartup.complete(); assert.notEqual(h.nodes['app-startup'].removed, true);
});

test('uncaught bootstrap errors are safely described without exposing error payloads', () => {
  const h = harness(); h.listeners.get('error')({ message: 'PRIVATE_BOOT_DATA' });
  assert.equal(h.nodes['app-startup'].dataset.state, 'error');
  assert.ok(!h.nodes['startup-detail'].textContent.includes('PRIVATE_BOOT_DATA'));
});

test('noncritical asynchronous settings failures cannot block an already committed app', () => {
  const h = harness(); assert.equal(h.listeners.has('unhandledrejection'), false);
  h.window.__workbenchStartup.complete(); h.tick(180);
  assert.equal(h.nodes.root.attributes.has('inert'), false); assert.equal(h.nodes['app-startup'].removed, true);
});

test('unrelated image resources cannot strand a healthy app on the startup screen', () => {
  const h = harness(); h.listeners.get('error')({ target: { tagName: 'IMG' } });
  assert.equal(h.nodes['app-startup'].dataset.state, 'loading');
  h.window.__workbenchStartup.complete(); h.tick(180); assert.equal(h.nodes['app-startup'].removed, true);
  const failedScript = harness(); failedScript.listeners.get('error')({ target: { tagName: 'SCRIPT' } });
  assert.equal(failedScript.nodes['app-startup'].dataset.state, 'error');
});

test('static local markup precedes the app module and only App first-frame readiness dismisses it', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
  const ready = readFileSync(new URL('../src/components/StartupReady.jsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/startup.css', import.meta.url), 'utf8');
  assert.ok(html.indexOf('id="app-startup"') < html.indexOf('src="/src/main.jsx"'));
  assert.match(html, /id="root"[^>]*inert/); assert.match(html, /src="\/startup\.js"/);
  assert.match(ready, /requestAnimationFrame/); assert.match(ready, /cancelAnimationFrame/); assert.match(main, /<StartupReady\s*\/>/);
  assert.ok(main.indexOf('restoreStartupData().then') < main.indexOf('<App />'));
  assert.match(css, /prefers-reduced-motion/); assert.doesNotMatch(css, /infinite|https?:/);
  assert.match(css, /data-state="leaving"[\s\S]*?pointer-events:\s*none/);
});

test('React ready effect cancels abandoned first frames and survives strict-mode setup/cleanup', () => {
  const source = readFileSync(new URL('../src/components/StartupReady.jsx', import.meta.url), 'utf8');
  const ast = require('@babel/parser').parse(source, { sourceType: 'module', plugins: ['jsx'] }); let callback;
  require('@babel/traverse').default(ast, { CallExpression({ node }) { if (node.callee.name === 'useEffect') callback = node.arguments[0]; } });
  const frames = new Map(); let nextFrame = 0; let ready = 0;
  const effect = runInNewContext('(' + source.slice(callback.start, callback.end) + ')', {
    window: { __workbenchStartup: { complete: () => ready++ } },
    requestAnimationFrame: fn => { frames.set(++nextFrame, fn); return nextFrame; }, cancelAnimationFrame: id => frames.delete(id),
  });
  const firstCleanup = effect(); assert.equal(ready, 0); firstCleanup(); assert.equal(frames.size, 0);
  const betweenFrames = effect(); const firstFrame = nextFrame; frames.get(firstFrame)();
  assert.equal(ready, 0, 'first RAF runs before paint and must not announce readiness');
  betweenFrames(); assert.equal(frames.size, 0, 'StrictMode cleanup must cancel both scheduled frames');
  const finalCleanup = effect(); frames.get(nextFrame)(); assert.equal(ready, 0);
  frames.get(nextFrame)(); assert.equal(ready, 1); finalCleanup(); assert.equal(frames.size, 0);
});

test('startup retry permits only a reload of the current main document, never arbitrary navigation', () => {
  const source = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const ast = require('@babel/parser').parse(source, { sourceType: 'script' }); let callback;
  require('@babel/traverse').default(ast, { CallExpression({ node }) {
    if (node.callee.property?.name === 'on' && node.arguments[0]?.value === 'will-navigate') callback = node.arguments[1];
  } });
  let currentUrl = 'file:///C:/Workbench/dist/index.html';
  const navigate = runInNewContext('(' + source.slice(callback.start, callback.end) + ')', { mainWindow: { webContents: { getURL: () => currentUrl } } });
  const blocked = target => { let result = false; navigate({ preventDefault: () => { result = true; } }, target); return result; };
  assert.equal(blocked(currentUrl), false);
  for (const target of ['https://untrusted.invalid/', 'file:///C:/private.txt', currentUrl + '?different', 'javascript:void(0)', undefined]) assert.equal(blocked(target), true);
  currentUrl = ''; assert.equal(blocked(''), true);
  currentUrl = 'http://localhost:5173/'; assert.equal(blocked(currentUrl), false);
  assert.equal(blocked('http://localhost:5173/other'), true);
});
