const test = require('node:test');
const assert = require('node:assert/strict');
const { compareSessions, exportContents } = require('../electron/lib/log-session-operations.cjs');
const fixture = id => ({ id, name: id, source: 'realtime', deviceId: 'A', entries: [{ id: 'one', raw: '11-16 E HiLog domain: failure 123', message: 'failure 123', tag: 'Ui', level: 'E', clockBasis: 'unknown' }], markers: [], aiTurns: [] });
test('local compare reports real repeated counts and never invents timestamps or rates', () => {
  const before = fixture('before'), after = fixture('after'); after.entries.push({ ...after.entries[0], id: 'two' });
  const result = compareSessions(before, after);
  assert.equal(result.comparable, true); assert.equal(result.groups[0].beforeCount, 1); assert.equal(result.groups[0].afterCount, 2);
  assert.equal(result.groups[0].afterFirst, null); assert.equal(Object.hasOwn(result.groups[0], 'rate'), false);
  after.entries[1] = { ...after.entries[1], clockBasis: 'received', receivedAt: 123 };
  assert.equal(compareSessions(before, after).groups[0].afterFirst, null, 'One known timestamp cannot stand in for the first timestamp of an incompletely timed group');
  after.deviceId = 'B'; assert.equal(compareSessions(before, after).comparable, false);
});
test('exports preserve exact raw lines and redaction never mutates source records or AI history', () => {
  const source = fixture('raw'); source.entries[0].raw = 'HiLog DOMAIN 0d001 secret token=secret-value';
  const before = structuredClone(source);
  assert.equal(exportContents(source, { scope: 'loaded', format: 'raw', redact: false }).raw, source.entries[0].raw + '\n');
  const shared = exportContents(source, { scope: 'issue', format: 'bundle', redact: true, includeAi: false });
  assert.doesNotMatch(shared.raw, /secret-value/); assert.deepEqual(source, before);
});
test('different error codes, addresses and long message tails never cancel into a false zero delta', () => {
  for (const [beforeText, afterText] of [['HTTP 401 failure', 'HTTP 403 failure'], ['bad address 0x123 failure', 'bad address 0x456 failure'],
    ['error ' + 'a'.repeat(300) + 'cause-one', 'error ' + 'a'.repeat(300) + 'cause-two']]) {
    const before = fixture('before'), after = fixture('after'); before.entries[0].message = beforeText; after.entries[0].message = afterText;
    const result = compareSessions(before, after); assert.equal(result.groupCount, 2); assert.deepEqual(result.groups.map(group => group.delta).sort(), [-1, 1]);
    assert.notEqual(result.groups[0].id, result.groups[1].id);
  }
});
