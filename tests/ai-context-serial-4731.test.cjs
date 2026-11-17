const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createSerialBuffer } = require('../electron/lib/serial-buffer.cjs');
const { createHandoffBroker } = require('../electron/lib/ai-analysis-handoff.cjs');
const { computeWorkspaceJob } = require('../electron/lib/ai-workspace-compute.cjs');

function sourceReader(state) {
  const filename = path.resolve(__dirname, '../electron/lib/ai-analysis-handoff.cjs');
  const localRequire = require('node:module').createRequire(filename);
  const customRequire = value => value === './serial.cjs' ? { snapshots: () => ({ rs232: state }) } : localRequire(value);
  const context = { require: customRequire, module: { exports: {} }, Buffer, console };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.__readReference = readReference;', context, { filename });
  return context.module.exports.__readReference;
}

test('actual four small binary frames survive actual serial reference and freeze without changing their original bytes', async () => {
  const buffer = createSerialBuffer({ mergeReceive: false, now: () => Date.UTC(2026, 10, 17) });
  const frames = ['FE08584248434D440001CF', 'FE09584248434D44000100CF', 'FE08584248434D440002CF', 'FE09584248434D44000201CF'];
  frames.forEach((hex, index) => buffer.append({ bytes: Buffer.from(hex, 'hex'), direction: index % 2 ? 'RX' : 'TX', sessionId: 'fixture-session', path: 'COM-FIXTURE', config: {} }));
  const entries = buffer.entriesAfter();
  assert.deepEqual(entries.map(row => row.bytes), [11, 12, 11, 12]);
  const original = structuredClone(entries), state = { sessionId: 'fixture-session', path: 'COM-FIXTURE', entries };
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const broker = createHandoffBroker({ getOwner: () => owner, readReference: sourceReader(state), publish() {}, freeze: args => computeWorkspaceJob('freeze', args) });
  const { handoffId } = await broker.createFromRenderer({ reference: { kind: 'serial', workspace: 'rs232', sessionId: state.sessionId } });
  const frozen = await broker.resolveForWorkspace(handoffId);
  for (const hex of frames) assert.ok(frozen.entries[0].text.includes(hex.match(/../g).join(' ')), hex);
  assert.match(frozen.entries[0].text, /11 bytes/);
  assert.match(frozen.entries[0].text, /12 bytes/);
  assert.match(frozen.entries[0].text, /\\x00/);
  assert.doesNotMatch(frozen.entries[0].text, /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/);
  assert.deepEqual(entries, original);
  await assert.rejects(broker.createFromRenderer({ reference: { kind: 'serial', workspace: 'rs232', sessionId: 'stale' } }));
  await assert.rejects(broker.createFromRenderer({ view: { origin: 'serial-selection', title: 'bad\x00identity', text: 'safe' } }));
  const stale = sourceReader(state)({ kind: 'serial', workspace: 'rs232', sessionId: state.sessionId });
  state.sessionId = 'changed-while-formatting';
  await assert.rejects(stale);
  broker.cleanup();
});

test('serial source windows omit whole frames rather than clipping HEX or escaped bytes', () => {
  const { captureSerialEvidenceRows } = require('../electron/lib/serial-ai-evidence.cjs');
  const rows = [{ time: '2026-11-17T00:00:00.000Z', direction: 'RX', bytes: 12, hex: 'FE09584248434D44000100CF', text: 'unsafe\0' }];
  const full = captureSerialEvidenceRows(rows);
  assert.equal(full.truncated, false);
  const tooSmall = captureSerialEvidenceRows(rows, { maxBytes: Buffer.byteLength(full.text) - 1 });
  assert.equal(tooSmall.text, '');
  assert.equal(tooSmall.truncated, true);
});
