import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { createMaterialBudgetQueue } from '../src/shared/aiMaterialBudget.js';

test('the actual budget worker entry measures a 20 MiB material off-thread and returns only bounded metadata', async t => {
  const entry = new URL('../src/workers/ai-material-budget-worker.js', import.meta.url).href;
  const worker = new Worker(`const {parentPort}=require('node:worker_threads'); globalThis.self={postMessage:data=>parentPort.postMessage(data)}; import(${JSON.stringify(entry)}).then(()=>{parentPort.on('message',data=>self.onmessage({data}));parentPort.postMessage({ready:true});});`, { eval: true });
  t.after(() => worker.terminate());
  await new Promise((resolve, reject) => { worker.once('message', value => value.ready ? resolve() : reject(Error('Missing worker ready'))); worker.once('error', reject); });
  const text = 'x'.repeat(20 * 1024 * 1024); let ticks = 0, gap = 0, previous = performance.now();
  const timer = setInterval(() => { const current = performance.now(); ticks++; gap = Math.max(gap, current - previous); previous = current; }, 5);
  t.after(() => clearInterval(timer));
  const start = performance.now();
  const result = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(Error('Budget worker deadline')), 15000);
    worker.once('message', value => { clearTimeout(deadline); resolve(value); }); worker.once('error', reject);
    worker.postMessage({ requestId: 1, caseId: 'case', revision: 1, text, question: 'Test', unknownSources: 2 });
  });
  clearInterval(timer); assert.equal(result.status, 'over-limit'); assert.equal(result.complete, false); assert.ok(result.minimumBytes > text.length);
  assert.ok(JSON.stringify(result).length < 512); assert.ok(ticks > 2); assert.ok(gap < 1000);
  t.diagnostic(`Native Node-hosted actual worker: ${Math.round(performance.now() - start)}ms, ${ticks} Main heartbeats, maximum gap ${Math.round(gap)}ms. Browser/final-ASAR validation is a separate gate.`);
});

test('actual worker messages after a slow question edit contain cached numeric bytes, not the retained 20 MiB source', async t => {
  const entry = new URL('../src/workers/ai-material-budget-worker.js', import.meta.url).href, nodes = new Set(), posted = [];
  let reply;
  const queue = createMaterialBudgetQueue({ delayMs: 0, onSummary: summary => reply?.(summary), createWorker() {
    const native = new Worker(`const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:data=>parentPort.postMessage(data)};import(${JSON.stringify(entry)}).then(()=>{parentPort.on('message',data=>self.onmessage({data}));parentPort.postMessage({ready:true});});`, { eval: true });
    nodes.add(native); const waiting = []; let ready = false;
    const adapter = { postMessage(value) { posted.push({ hasText: Object.hasOwn(value, 'text'), textUnits: value.text?.length || 0, knownTextBytes: value.knownTextBytes }); if (ready) native.postMessage(value); else waiting.push(value); },
      terminate() { void native.terminate(); nodes.delete(native); } };
    native.on('message', value => { if (value.ready) { ready = true; for (const value of waiting.splice(0)) native.postMessage(value); } else adapter.onmessage?.({ data: value }); });
    native.on('error', error => adapter.onerror?.(error)); return adapter;
  } });
  t.after(async () => { queue.dispose(); await Promise.all([...nodes].map(node => node.terminate())); });
  const text = 'x'.repeat(20 * 1024 * 1024);
  const run = revision => new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(Error('Real budget queue timeout')), 10000); reply = summary => { clearTimeout(timeout); resolve(summary); };
    queue.schedule({ caseId: 'case', revision, text, question: `Question ${revision}`, unknownSources: 1 }); });
  const first = await run(1), second = await run(2);
  assert.equal(first.status, 'over-limit'); assert.equal(second.minimumBytes, first.minimumBytes);
  assert.deepEqual(posted.map(value => value.hasText), [true, false]); assert.equal(posted[0].textUnits, 20971520); assert.equal(posted[1].knownTextBytes, first.textBytes);
});
