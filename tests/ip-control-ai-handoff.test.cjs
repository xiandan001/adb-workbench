const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { createHandoffBroker } = require('../electron/lib/ai-analysis-handoff.cjs');
const { runWorkspaceJob, cleanupWorkspaceProcessor } = require('../electron/lib/ai-workspace-processor.cjs');
const { computeWorkspaceJob } = require('../electron/lib/ai-workspace-compute.cjs');
const { validateBasket } = require('../electron/lib/ai-evidence-basket-storage.cjs');
const { contentBytes } = require('../electron/lib/ai-context-limits.json');

function sourceReader(bridge) {
  const filename = path.resolve(__dirname, '../electron/lib/ai-analysis-handoff.cjs'), local = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.read = readReference;', {
    module, Buffer, require: name => name === './ip-control-ipc.cjs' ? bridge : local(name),
  }, { filename });
  return module.exports.read;
}
const snapshot = ({ hex = 'FE09584248434D44020801CF', mode = 'tcp-server' } = {}) => ({
  sessionId: randomUUID(), mode, host: '::1', port: 8192, localPort: 8192, lastId: 50001, dropped: 49000,
  entries: [{ id: 50001, at: 1763365800000, direction: 'RX', hex, peerHost: '2001:db8::1', peerPort: 38212 }],
});

test('network handoff uses only the pinned session; actual workers preserve HEX, metadata and a persistable distinct source', async t => {
  t.after(cleanupWorkspaceProcessor);
  const state = snapshot(), reference = { kind: 'ip-control', sessionId: state.sessionId }, owner = Object.assign(new EventEmitter(), {isDestroyed: () => false});
  let current = state.sessionId, item; const reads = [], publications = [];
  const readReference = sourceReader({
    readAnalysisSnapshot: id => { reads.push(id); return id === current ? structuredClone(state) : null; },
    isAnalysisSessionCurrent: id => id === current,
  });
  const broker = createHandoffBroker({ getOwner: () => owner, readReference, freeze: (args, options) => runWorkspaceJob('freeze', args, options),
    basket: { append(value) { item = validateBasket({ version: 1, revision: 1, items: [value] }).items[0]; return {revision:1}; } },
    publish: (_owner, payload) => publications.push(payload) });
  t.after(() => broker.cleanup());
  await assert.rejects(broker.createFromRenderer({ reference: { ...reference, text: 'forged' } }));
  await assert.rejects(broker.createFromRenderer({ view: { origin:'ip-control', text:'forged', title:'forged' } }));
  assert.equal(reads.length, 0);
  const { handoffId } = await broker.createFromRenderer({ reference });
  const result = await broker.resolveForWorkspace(handoffId), evidence = result.entries[0];
  assert.deepEqual(reads, [state.sessionId]); assert.deepEqual(publications, [{handoffId}]);
  assert.equal(result.origin, 'ip-control'); assert.equal(result.provenance.trust, 'server-snapshot'); assert.equal(result.deviceId, '');
  assert.equal(evidence.source, 'ip-control'); assert.equal(evidence.evidenceKind, 'ip-control'); assert.equal(evidence.targetKey, null);
  assert.match(evidence.text, /#50001 RX .*12 B \| HEX: FE 09 58 42 48 43 4D 44 02 08 01 CF$/);
  assert.match(evidence.label, /TCP Server.*8192/); assert.match(evidence.text, /38212/);
  assert.doesNotMatch(JSON.stringify(result), /2001:db8::1|::1|COM\d/);
  assert.equal(evidence.truncated, true); assert.deepEqual(evidence.windowInfo, { originalRecords: 50001, retainedRecords: 1, byteLimit: contentBytes });
  assert.equal(evidence.events[0].clockBasis, 'host-receive'); assert.ok(evidence.timeBasis.includes(state.sessionId)); assert.equal(item.entries[0].text,evidence.text);
  const downstream = await computeWorkspaceJob('bundle', {entries: [evidence]}); assert.equal(downstream.entries[0].text,evidence.text);
  const plan = await computeWorkspaceJob('request-plan', { prompt: 'Analyze the frozen network evidence.', payload: {evidence:downstream.entries}, locale:'en-US' });
  assert.equal(plan.requests.length,1); assert.ok(plan.requests[0].userContent.includes('FE 09 58 42'));
  await assert.rejects(broker.createFromRenderer({ reference:{...reference,sessionId:randomUUID()} }));
  const stale = broker.createFromRenderer({reference}); current = randomUUID(); await assert.rejects(stale); assert.equal(publications.length,1);
});

test('empty datagram remains an explicit zero byte record; complete 65507 byte datagram is one uncut line', async () => {
  for (const hex of ['', '00FF'.repeat(32753) + '80']) {
    const state = snapshot({hex,mode:'udp'}); state.lastId=1; state.dropped=0; state.entries[0].id=1;
    const result = await computeWorkspaceJob('ip-control-snapshot',state);
    assert.equal(result.truncated,false); assert.equal(result.text.split('\n').length,1);
    assert.equal(result.text.split(' | HEX: ')[1].replaceAll(' ',''),hex);
    assert.ok(result.text.includes((hex.length/2)+' B'));
  }
});

test('worker packaging includes the network evidence formatter; no socket creation, clipboard or model action is exposed in the formatter', () => {
  const conf = JSON.parse(fs.readFileSync(path.resolve(__dirname,'../electron-builder.json'),'utf8'));
  assert.ok(conf.asarUnpack.includes('electron/lib/ip-control-ai-evidence.cjs'));
  const registration = fs.readFileSync(path.resolve(__dirname,'../electron/lib/ai-analysis-handoff.cjs'),'utf8');
  assert.match(registration,/method === 'create' && args\?\.reference\?\.kind !== 'ip-control'/);
});
