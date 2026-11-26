const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLogIncidentRequest, readLogIncidentContext } = require('../electron/lib/log-incident-context.cjs');
const captureHarness = require('./helpers/log-capture-harness.cjs');

const timestamp = 1_700_000_000_000;
const request = { deviceId: 'device-A', timestamp };
const row = (id, receivedAt, extra = {}) => ({ id, source: 'realtime', deviceId: 'device-A', receivedAt, raw: String(id), ...extra });

test('incident requests accept only a bounded, explicit device and host time', () => {
  assert.deepEqual(normalizeLogIncidentRequest(request), request);
  for (const args of [null, {}, { ...request, windowMs: 60_000 }, { ...request, timestamp: Infinity }, { ...request, timestamp: -1 },
    { ...request, deviceId: '' }, { ...request, deviceId: 'x'.repeat(257) }, { ...request, deviceId: 'x\nA' }]) {
    assert.equal(normalizeLogIncidentRequest(args), null);
  }
});

test('incident query uses device ID plus the host receive clock, without source fallbacks', () => {
  const entries = [
    row('other device', timestamp, { deviceId: 'device-B' }),
    row('imported', timestamp, { source: 'file' }),
    row('source clock only', undefined, { ts: timestamp }),
    row('late', timestamp + 30_001, { ts: timestamp }),
    row('inside', timestamp + 30_000, { ts: timestamp * 2 }),
    row('before', timestamp - 3_000),
  ];
  const original = structuredClone(entries);
  const result = readLogIncidentContext(request, { deviceId: 'device-A', entries });
  assert.equal(result.status, 'found');
  assert.deepEqual(result.rows.map(entry => entry.id), ['before', 'inside']);
  assert.deepEqual(readLogIncidentContext(request, { deviceId: 'device-B', entries }).rows, []);
  assert.equal(readLogIncidentContext(request, { deviceId: 'device-B', entries }).status, 'no-source');
  assert.deepEqual(entries, original);
});

test('incident rows bound nearest readings and trim previews without splitting a Unicode pair', () => {
  const entries = Array.from({ length: 60 }, (_, index) => row(index, timestamp + 59 - index));
  entries[59] = row(59, timestamp, { raw: 'x'.repeat(2047) + '😀tail', tag: 'x'.repeat(500), level: 'E' });
  const result = readLogIncidentContext(request, { deviceId: 'device-A', entries });
  assert.equal(result.rows.length, 40);
  assert.equal(result.rows[0].id, 59);
  assert.equal(result.rows.at(-1).id, 20);
  assert.equal(result.rows[0].raw, 'x'.repeat(2047));
  assert.equal(result.rows[0].tag.length, 100);
  assert.equal(result.rows[0].previewTruncated, true);
  assert.equal(result.truncated, true);
});

test('main incident IPC rejects subframes and late cross-device requests without touching capture state', () => {
  const fixture = captureHarness();
  const main = fixture.context.getMainWindow();
  const event = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
  const handler = fixture.handlers.get('log:incidentContext');
  fixture.api.setCurrentLogSource('realtime', 'device-A');
  fixture.api.getLogStore().realtime = [row('correct', timestamp), row('incorrect', timestamp, { deviceId: 'device-B' })];
  assert.equal(handler(fixture.event, request).ok, false);
  assert.equal(handler({ ...event, senderFrame: {} }, request).ok, false);
  assert.equal(handler(event, { ...request, limit: 200 }).ok, false);
  assert.deepEqual(handler(event, request).rows.map(entry => entry.raw), ['correct']);
  fixture.api.setCurrentLogSource('realtime', 'device-B');
  assert.equal(handler(event, request).status, 'no-source');
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.children.length, 0);
});
