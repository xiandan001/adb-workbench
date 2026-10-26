async function main() {
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');
const root = path.resolve(__dirname, '..');
// Explicit benchmark only: synthetic records, no device/serial/network access.
// Current mode needs no Git tag; baseline mode compares v4.7.6 algorithms with
// their limits raised only in this VM. Timing targets are local evidence, not a
// hardware-independent CI assertion. Run: node tests/log-capacity-benchmark.cjs current
const stage = process.argv[2] || 'current';
if (!['baseline', 'current'].includes(stage)) throw Error('Invalid benchmark stage');
const serialPath = path.join(root, 'electron/lib/serial-buffer.cjs');
const loadSource = file => stage === 'baseline' ? require('node:child_process').execFileSync('git', ['show', 'v4.7.6:' + file], { cwd: root, encoding: 'utf8', windowsHide: true }) : fs.readFileSync(path.join(root, file), 'utf8');
let serialSource = loadSource('electron/lib/serial-buffer.cjs');
if (stage === 'baseline') serialSource = serialSource.replace('const MAX_ENTRIES = 5000;', 'const MAX_ENTRIES = 10000;').replace('const MAX_BYTES = 4 * 1024 * 1024;', 'const MAX_BYTES = 64 * 1024 * 1024;');
const moduleValue = { exports: {} };
vm.runInThisContext(`(function(require,module,exports){${serialSource}\n})`)(createRequire(serialPath), moduleValue, moduleValue.exports);
let reducerSource = loadSource('src/shared/serialWorkspace.js');
reducerSource = reducerSource.replace(/^import[^\n]+\n/gm, '').replace(/\bexport /g, '').replace('const MAX_ROWS = 5000;', 'const MAX_ROWS = 10000;');
const model = vm.runInThisContext(`(function(tr,LOG_VIEW_LIMIT){${reducerSource}\nreturn {applySerialSnapshot,applySerialDelta,emptySerialSnapshot}})`)(value => value, 10000);
const { createSerialBuffer } = moduleValue.exports;
const config = { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' };
const buffer = createSerialBuffer({ mergeReceive: false });
const packet = Buffer.alloc(500, 0x61); packet[499] = 10;
const context = { sessionId: 'benchmark-only', path: 'synthetic-port', config, direction: 'RX', bytes: packet };
const beforeMemory = process.memoryUsage();
const initialAt = performance.now();
for (let index = 0; index < 10000; index++) buffer.append(context);
let revision = 1;
let state = model.applySerialSnapshot(model.emptySerialSnapshot(), { revision, ...buffer.metadata(), entries: buffer.drainChanges(true) });
if (state.entries.length !== 10000 || state.needsSnapshot) throw Error('10k baseline preparation failed');
const initialMs = performance.now() - initialAt;
const appendTimes = [], drainTimes = [], mergeTimes = [], totalTimes = [];
for (let sample = 0; sample < 60; sample++) {
  await new Promise(resolve => setTimeout(resolve, 100));
  const start = performance.now();
  for (let index = 0; index < 1000; index++) buffer.append(context);
  const appended = performance.now();
  const entries = buffer.drainChanges(); const drained = performance.now();
  state = model.applySerialDelta(state, { baseRevision: revision, revision: ++revision, ...buffer.metadata(), entries });
  const merged = performance.now();
  if (state.entries.length !== 10000 || state.needsSnapshot) throw Error('delta continuity failed');
  appendTimes.push(appended - start); drainTimes.push(drained - appended); mergeTimes.push(merged - drained); totalTimes.push(merged - start);
}
const summary = values => {
  const sorted = values.slice().sort((a, b) => a - b);
  return { p50Ms: sorted[Math.floor(sorted.length * 0.5)], p95Ms: sorted[Math.floor(sorted.length * 0.95)], maxMs: sorted.at(-1) };
};
const sourceSha256 = Object.fromEntries(['electron/lib/serial-buffer.cjs', 'src/shared/serialWorkspace.js'].map(file => [file, require('node:crypto').createHash('sha256').update(loadSource(file)).digest('hex')]));
const report = { sourceSha256, intervalMs: 100, baselineRef: 'v4.7.6 (limits raised only in benchmark)', stage, measuredAt: new Date().toISOString(), node: process.version, rowsRetained: state.entries.length, bytesPerRow: 500,
  samples: 60, rowsPerBatch: 1000, initialMs, append: summary(appendTimes), drain: summary(drainTimes), rendererMerge: summary(mergeTimes), total: summary(totalTimes),
  metadata: buffer.metadata(), beforeMemory, afterMemory: process.memoryUsage(),
  note: stage === 'baseline' ? 'Old algorithms with limits raised only inside this benchmark, never product source.' : 'Current product algorithms; synthetic records, no device/serial/AI calls.' };
fs.mkdirSync(path.join(root, '.superpowers'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, '.superpowers/log-capacity-benchmark-'));
report.output = output;
fs.writeFileSync(path.join(output, stage + '.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));

}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
