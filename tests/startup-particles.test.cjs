const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = file => readFileSync(path.join(__dirname, '../electron/startup', file), 'utf8');

function harness({ native = true, missingContext = false, emptyMask = false, throwDrawing = false, ratio = 1 } = {}) {
  const frames = new Map(); const events = new Map(); const draws = []; const strokes = []; const colors = []; const labels = [];
  let sequence = 0; let play; let ready = 0; let finished = 0; let creations = 0;
  function makeCanvas(name) {
    const stack = []; let segments = [];
    const context = { globalAlpha: 1, scale() {}, beginPath() { segments = []; }, roundRect() {},
      stroke() { if (name === 'host') strokes.push({ alpha: this.globalAlpha, segments: [...segments] }); },
      moveTo(x, y) { segments.push(['move', x, y]); }, lineTo(x, y) { segments.push(['line', x, y]); }, arc() {}, fill() {},
      fillText(text) { labels.push(text); }, fillRect() {}, createRadialGradient: () => ({ addColorStop: (offset, color) => colors.push([offset, color]) }),
      save() { stack.push(this.globalAlpha); }, restore() { this.globalAlpha = stack.pop() ?? 1; }, clearRect() {},
      drawImage(image, x, y, width, height) { if (throwDrawing) throw new Error('lost context'); draws.push({ name: image.name, alpha: this.globalAlpha, x, y, width, height }); },
      getImageData: (_x, _y, width, height) => { const data = new Uint8ClampedArray(width * height * 4); if (!emptyMask) for (let i = 3; i < data.length; i += 4) data[i] = 255; return { data }; },
    };
    return { name, getContext: () => name === 'host' && missingContext ? null : context };
  }
  const host = makeCanvas('host');
  const window = { addEventListener: (name, callback) => events.set(name, callback), removeEventListener: name => events.delete(name) };
  if (native) window.startupOverlay = { onPlay(callback) { play = callback; return () => {}; }, ready() { ready++; }, finished() { finished++; } };
  vm.runInNewContext(source('particles.js'), { window, document: { getElementById: () => host, createElement: () => makeCanvas(++creations === 1 ? 'mask' : 'sprite') },
    innerWidth: 1920, innerHeight: 1080, devicePixelRatio: ratio,
    requestAnimationFrame: callback => { frames.set(++sequence, callback); return sequence; }, cancelAnimationFrame: id => frames.delete(id) });
  return { host, draws, strokes, colors, labels, frames, events, play: value => play(value), ready: () => ready, finished: () => finished,
    frame(time) { const next = frames.entries().next().value; assert.ok(next, 'a frame should be scheduled'); frames.delete(next[0]); draws.length = 0; strokes.length = 0; next[1](time); return { draws: [...draws], strokes: [...strokes] }; } };
}

test('native scene waits for play, preserves the 1000ms logo hold and finishes once exactly at 4400ms', () => {
  const h = harness(); assert.equal(h.ready(), 1); assert.equal(h.frames.size, 0); assert.equal(h.finished(), 0);
  h.play(); h.play(); assert.equal(h.frames.size, 1);
  assert.deepEqual(h.frame(0).draws.map(item => item.name), ['mask']); assert.deepEqual(h.frame(999).draws.map(item => item.name), ['mask']);
  assert.ok(h.frame(1100).draws.filter(item => item.name === 'sprite').length > 100);
  h.frame(4399); assert.equal(h.finished(), 0); h.frame(4400); assert.equal(h.finished(), 1); assert.equal(h.frames.size, 0);
  h.play(); assert.equal(h.frames.size, 0); assert.equal(h.finished(), 1);
});

test('scene morphs to the exact DIP target and retains a dim final wireframe until native handoff', () => {
  const h = harness({ ratio: 2 }); h.play({ target: { x: -80, y: 45, width: 1600, height: 900 } }); h.frame(0);
  assert.equal(h.host.width, 2880); assert.equal(h.host.height, 1620);
  assert.deepEqual(h.frame(4180).strokes[0].segments.slice(0, 2), [['move', -80, 45], ['line', 1520, 45]]);
  assert.ok(Math.abs(h.strokes[0].alpha - .32) < 1e-9);
  const fade = h.frame(4290); assert.ok(Math.abs(fade.strokes[0].alpha - .16) < 1e-9);
  const done = h.frame(4400); assert.ok(Math.abs(done.strokes[0].alpha - .096) < 1e-9); assert.equal(h.finished(), 1);
  assert.ok(done.draws.some(draw => draw.name === 'sprite' && draw.alpha > 0)); assert.equal(h.frames.size, 0);
  assert.ok(h.labels.includes('卓控台'));
  assert.deepEqual(h.colors, [[0, '#e6fff9'], [.15, '#62f5d6'], [.4, '#20cbaa80'], [1, '#10b7d000']]);
});

test('approved morph reaches its exact midpoint at hold + 180ms transition + half of 2900ms', () => {
  const h = harness(); h.play(); h.frame(0);
  const sprites = h.frame(2630).draws.filter(item => item.name === 'sprite'); assert.equal(sprites.length, 820);
  const first = sprites[0];
  assert.ok(Math.abs(first.width - 5.4) < 1e-9);
  assert.ok(Math.abs(first.x + first.width / 2 - (.25 * 730 + .5 * 1060 + .25 * 180 + Math.sin(3) * 20)) < 1e-9);
  assert.ok(Math.abs(first.y + first.height / 2 - (.25 * 400 + .5 * 540 + .25 * 100 + Math.cos(3) * 20)) < 1e-9);
});

test('absent target retains the approved preview geometry and browser fallback has no native dependency', () => {
  const h = harness({ native: false }); assert.equal(h.frames.size, 1); h.frame(0);
  assert.deepEqual(h.frame(4180).strokes[0].segments.slice(0, 2), [['move', 180, 100], ['line', 1740, 100]]);
  h.frame(4400); assert.equal(h.frames.size, 0);
});

test('invalid targets and unavailable drawing fail open once after play without starting unbounded work', () => {
  for (const target of [null, {}, { x: 0, y: 0, width: 0, height: 900 }, { x: Infinity, y: 0, width: 1000, height: 800 }, { x: 100001, y: 0, width: 1000, height: 800 }, { x: 0, y: 0, width: 100001, height: 800 }]) {
    const h = harness(); h.play({ target }); assert.equal(h.finished(), 1); assert.equal(h.frames.size, 0); h.play({ target }); assert.equal(h.finished(), 1);
  }
  for (const option of ['missingContext', 'emptyMask']) { const h = harness({ [option]: true }); assert.equal(h.finished(), 0); h.play(); assert.equal(h.finished(), 1); assert.equal(h.frames.size, 0); }
  const h = harness({ throwDrawing: true }); h.play(); h.frame(0); assert.equal(h.finished(), 1); assert.equal(h.frames.size, 0);
});

test('disposing the page cancels pending frames without sending a false completion during quit', () => {
  const h = harness(); h.play(); h.frame(0); h.events.get('pagehide')(); assert.equal(h.frames.size, 0); assert.equal(h.finished(), 0);
});

test('standalone preload exposes only fixed-channel lifecycle functions and never leaks the native event', () => {
  const ipcRenderer = new EventEmitter(); const sent = []; let exposed;
  ipcRenderer.send = (...args) => sent.push(args);
  vm.runInNewContext(source('preload.cjs'), { require: name => { assert.equal(name, 'electron'); return { ipcRenderer, contextBridge: { exposeInMainWorld: (name, value) => { exposed = { name, value }; } } }; } });
  assert.equal(exposed.name, 'startupOverlay'); assert.deepEqual(Object.keys(exposed.value).sort(), ['finished', 'initialLanguage', 'onPlay', 'ready']);
  assert.equal(exposed.value.initialLanguage, 'zh-CN');
  exposed.value.ready(); exposed.value.finished(); assert.deepEqual(sent, [['startup-overlay:ready'], ['startup-overlay:finished']]);
  const values = []; const unsubscribe = exposed.value.onPlay((...args) => values.push(args)); const payload = { target: { x: 1, y: 2, width: 900, height: 600 } };
  ipcRenderer.emit('startup-overlay:play', { privateEvent: true }, payload); ipcRenderer.emit('startup-overlay:play', {}, payload);
  assert.deepEqual(values, [[payload]]); unsubscribe();
  const remove = exposed.value.onPlay(() => values.push('should not run')); remove(); ipcRenderer.emit('startup-overlay:play', {}, payload); assert.equal(values.length, 1);
  assert.throws(() => exposed.value.onPlay(null), /callback/i);
});

test('production scene ships only local transparent canvas assets without preview controls or application access', () => {
  const html = source('scene.html'); const particles = source('particles.js');
  assert.match(html, /default-src 'none'/); assert.match(html, /script-src 'self'/); assert.match(html, /background:transparent/); assert.match(html, /src="particles\.js"/);
  assert.doesNotMatch(html + particles + source('preload.cjs'), /startupPreview|particle-preview:|https?:\/\/|electronAPI|desktopCapturer|localStorage|fetch\(/);
});
