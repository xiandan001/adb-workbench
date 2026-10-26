const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');

const output = path.resolve(process.argv[2]);
const native = path.resolve(process.argv[3]);
const relativeOutput = path.relative(path.resolve(__dirname, '../.superpowers'), output);
assert.ok(relativeOutput && !relativeOutput.startsWith('..') && !path.isAbsolute(relativeOutput));
assert.equal(path.basename(output).startsWith('window-restore-fixture-'), true);
assert.equal(path.dirname(native), output);
app.setPath('userData', path.join(output, 'profile'));
app.setPath('sessionData', path.join(output, 'session'));
app.setPath('logs', path.join(output, 'logs'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#f7f9fb;color:#20334b;font:24px sans-serif}aside{position:absolute;width:180px;height:100%;background:#202124;color:#00c18a;padding:20px;box-sizing:border-box}main{margin-left:205px;padding:25px}canvas{display:block;width:400px;height:130px}input{font-size:24px}</style><aside>Veylo fixture</aside><main><h1>Window continuity</h1><input id="session" value="session-kept"><canvas width="400" height="130"></canvas><p id="counter"></p></main><script>
window.metrics={frames:0,last:performance.now(),maxGap:0,visible:document.visibilityState,visibility:[],session:'fixture-'+Math.random(),firstAfterReset:null,frameTimes:[],longTasks:[]};
new PerformanceObserver(list=>{for(const entry of list.getEntries())metrics.longTasks.push({start:entry.startTime,duration:entry.duration})}).observe({entryTypes:['longtask']});
document.addEventListener('visibilitychange',()=>{metrics.visible=document.visibilityState;metrics.visibility.push({state:document.visibilityState,at:performance.now()})});
const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');function frame(now){metrics.maxGap=Math.max(metrics.maxGap,now-metrics.last);metrics.last=now;metrics.frames++;metrics.frameTimes.push(performance.timeOrigin+performance.now());if(metrics.frameTimes.length>360)metrics.frameTimes.shift();if(metrics.firstAfterReset===null)metrics.firstAfterReset=now;ctx.fillStyle='#00c18a';ctx.fillRect(0,0,400,130);ctx.fillStyle='#20334b';ctx.fillRect(metrics.frames%360,20,40,90);document.getElementById('counter').textContent='frame '+metrics.frames;requestAnimationFrame(frame)}requestAnimationFrame(frame);
window.snapshot=()=>({...metrics,now:performance.now(),sessionValue:document.getElementById('session').value});window.reset=()=>{metrics.maxGap=0;metrics.firstAfterReset=null;return snapshot()};
</script>`;
function style(window) {
  const handle = window.getNativeWindowHandle();
  const value = handle.length >= 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
  return JSON.parse(cp.execFileSync(native, ['--style', value], { encoding: 'utf8', windowsHide: true, timeout: 5000 }));
}
async function snapshot(window) { return window.webContents.executeJavaScript('snapshot()'); }
async function capture(window, name) {
  const image = await window.webContents.capturePage();
  fs.writeFileSync(path.join(output, name + '.png'), image.toPNG());
  const bitmap = image.toBitmap(); let dark = 0;
  for (let i = 0; i < bitmap.length; i += 4) if (bitmap[i] < 20 && bitmap[i + 1] < 20 && bitmap[i + 2] < 20) dark++;
  return { width: image.getSize().width, height: image.getSize().height, darkPixelFraction: dark / (bitmap.length / 4) };
}
const epoch = () => performance.timeOrigin + performance.now();
const firstFrameAfter = (snapshot, at) => snapshot.frameTimes.find(time => time >= at) - at;
function rendererCPU(window) { return app.getAppMetrics().find(metric => metric.pid === window.webContents.getOSProcessId())?.cpu || null; }
async function scenario(throttling, opacityHistory, continuity = false) {
  const name = `${continuity ? 'policy-' : ''}throttle-${throttling}-opacity-${opacityHistory}`;
  const main = new BrowserWindow({ x: 160, y: 140, width: 800, height: 520, show: false, skipTaskbar: true,
    backgroundColor: '#081417', webPreferences: { backgroundThrottling: throttling, nodeIntegration: false, contextIsolation: true, sandbox: true } });
  if (continuity) require('../electron/lib/window-render-continuity.cjs').attachWindowRenderContinuity(main);
  const cover = new BrowserWindow({ x: 150, y: 130, width: 850, height: 570, show: false, skipTaskbar: true, backgroundColor: '#222222',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  let gone = 0; let reloads = 0;
  main.webContents.on('render-process-gone', () => gone++); main.webContents.on('did-finish-load', () => reloads++);
  await main.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)); await cover.loadURL('data:text/html,<body style="background:#222;color:white">Fixture cover window</body>');
  const beforeOpacity = style(main);
  if (opacityHistory) { main.setOpacity(0); main.showInactive(); await sleep(200); main.setOpacity(0.5); await sleep(80); main.setOpacity(1); }
  main.show(); main.focus(); await sleep(800);
  const afterOpacity = style(main); const initial = await snapshot(main);
  const baseline = await capture(main, name + '-baseline');
  rendererCPU(main);
  await main.webContents.executeJavaScript('reset()'); cover.show(); cover.focus(); await sleep(1400);
  const covered = await snapshot(main); const coveredCPU = rendererCPU(main); const coveredThrottle = main.webContents.getBackgroundThrottling();
  const focusAt = epoch(); cover.hide(); main.focus(); await sleep(150);
  const focused = await snapshot(main); const afterFocus = await capture(main, name + '-focus');
  await main.webContents.executeJavaScript('reset()'); main.minimize(); await sleep(1000);
  const minimized = await snapshot(main); const minimizedCPU = rendererCPU(main); const minimizedThrottle = main.webContents.getBackgroundThrottling();
  const beforeRestore = epoch(); main.restore(); main.show(); main.focus();
  const restored0 = await snapshot(main); await sleep(150); const restored150 = await snapshot(main);
  const afterRestore = await capture(main, name + '-restore');
  assert.equal(restored150.session, initial.session); assert.equal(restored150.sessionValue, 'session-kept');
  const result = { name, throttling, opacityHistory, continuity, beforeOpacity, afterOpacity, baseline, covered, focused, afterFocus,
    focusAt, focusFirstFrameDelayMs: firstFrameAfter(focused, focusAt), coveredCPU, coveredThrottle,
    minimized, minimizedCPU, minimizedThrottle, restored0, restored150, afterRestore, restoreAt: beforeRestore,
    restoreFirstFrameDelayMs: firstFrameAfter(restored150, beforeRestore), restoredThrottle: main.webContents.getBackgroundThrottling(),
    gone, reloads, processId: main.webContents.getOSProcessId() };
  if (continuity) {
    assert.equal(coveredThrottle, false); assert.equal(minimizedThrottle, true); assert.equal(result.restoredThrottle, false);
    assert.equal(gone, 0); assert.equal(reloads, 1); assert.ok(result.focusFirstFrameDelayMs < 150 && result.restoreFirstFrameDelayMs < 150);
  }
  cover.destroy(); main.destroy(); return result;
}
app.whenReady().then(async () => {
  const report = { electron: process.versions.electron, chromium: process.versions.chrome, gpu: app.getGPUFeatureStatus(), scenarios: [],
    limitations: ['Private desktop and synthetic focus/minimize/restore, not a real user Alt-Tab reproduction.',
      'capturePage observes Chromium pixels and may request a paint; rAF/visibility sampled before capture.',
      'Private-desktop software GPU fallback cannot establish hardware-driver-specific black frames.',
      'No application, hardware sessions or real profile loaded.'] };
  try {
    for (const throttling of [true, false]) for (const opacity of [false, true]) {
      report.scenarios.push(await scenario(throttling, opacity));
      fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    }
    for (const opacity of [false, true]) {
      report.scenarios.push(await scenario(false, opacity, true));
      fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    }
    app.exit(0);
  } catch (error) { report.error = error.stack; fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n'); app.exit(1); }
});
app.on('window-all-closed', () => {});
