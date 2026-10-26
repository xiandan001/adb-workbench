// Explicit local benchmark; only synthetic data and an owned .superpowers folder.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'electron/lib/serial-export.cjs');
const source = fs.readFileSync(sourcePath, 'utf8');
const stage = process.argv[2] || 'stream';
if (!['sync', 'stream'].includes(stage)) throw new Error('Use sync or stream');
const fixture = fs.mkdtempSync(path.join(root, '.superpowers/serial-export-benchmark-'));
const fixedTime = 1760000000000;
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [fixedTime])); } }
const moduleValue = { exports: {} };
vm.runInThisContext(`(function(require,module,exports,Date){${source}\n})`)(createRequire(sourcePath), moduleValue, moduleValue.exports, FixedDate);
const raw = Buffer.alloc(500, 0x61); raw[499] = 10;
const hex = raw.toString('hex'), text = raw.toString('utf8');
const config = { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' };
const snapshot = { workspace: 'terminal', rxBytes: 5000000, txBytes: 0, evicted: 0,
  entries: Array.from({ length: 10000 }, (_, id) => ({ id, time: fixedTime + id, endTime: fixedTime + id,
    path: 'synthetic-port', sessionId: 'export-performance-fixture', direction: 'RX', config, kind: 'raw', parts: 1, bytes: 500, hex, text })) };

async function run() {
  let previous = performance.now(), heartbeats = 0, maxGapMs = 0, peakRss = process.memoryUsage().rss;
  const beforeMemory = process.memoryUsage();
  const timer = setInterval(() => { const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - previous); previous = now;
    heartbeats++; peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 1);
  let output, outputPath; const start = performance.now();
  try {
    if (stage === 'sync') output = moduleValue.exports.formatSerialSnapshot(snapshot);
    else { outputPath = path.join(fixture, 'synthetic-capture.log'); await moduleValue.exports.writeSerialSnapshot(outputPath, snapshot); }
    const elapsedMs = performance.now() - start;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    await new Promise(resolve => setTimeout(resolve, 5)); clearInterval(timer);
    const hash = createHash('sha256'); let bytes = 0;
    if (stage === 'sync') { hash.update(output, 'utf8'); bytes = Buffer.byteLength(output); }
    else for await (const chunk of fs.createReadStream(outputPath)) { hash.update(chunk); bytes += chunk.length; }
    const report = { stage, measuredAt: new Date().toISOString(), rows: 10000, rawBytes: 5000000, elapsedMs,
      heartbeats, maxEventLoopGapMs: maxGapMs, peakRssBytes: peakRss, beforeMemory, afterMemory: process.memoryUsage(),
      outputUtf8Bytes: bytes, outputSha256: hash.digest('hex'), sourceSha256: createHash('sha256').update(source).digest('hex'),
      fixture, note: 'Synthetic data only. Stream uses actual owned temporary file, bounded async writes and atomic rename. No device/serial/AI access.' };
    fs.writeFileSync(path.join(fixture, stage + '.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally { clearInterval(timer); }
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; });
