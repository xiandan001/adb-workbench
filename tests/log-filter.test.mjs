import test from 'node:test';
import assert from 'node:assert/strict';
import { filterEntries, matchFilter, countByLevel } from '../src/shared/filter.js';

const entries = [
  { id: '1', raw: 'Crash Alpha', pkg: 'COM.Demo.One', tag: 'MainTag', pid: 12, level: 'E' },
  { id: '2', raw: 'Crash Alpha ignored', pkg: 'com.demo.two', tag: 'MainTag', pid: 13, level: 'W' },
  { id: '3', raw: 'normal output', pkg: 'com.other', tag: 'Worker', pid: 12, level: 'I' },
  { id: '4', raw: 'CRASH Alpha' }
];

test('compiled filters retain existing combinations, missing fields and level semantics', () => {
  assert.equal(filterEntries(entries, {}), entries);
  assert.equal(filterEntries(entries, null), entries);
  const cases = [
    [{ text: 'crash', excludeText: 'IGNORED' }, ['1', '4']],
    [{ pkg: 'DEMO', tag: 'main', pid: 12, minLevel: 'W', text: 'alpha' }, ['1']],
    [{ minLevel: 'W' }, ['1', '2', '4']],
    [{ pid: 12 }, ['1', '3']],
    [{ regex: '^Crash', regexFlags: '' }, ['1', '2']],
    [{ regex: '[' }, []],
    [{ regex: 'Crash', regexFlags: 'invalid' }, []]
  ];
  for (const [filter, expected] of cases) {
    assert.deepEqual(filterEntries(entries, filter).map(entry => entry.id), expected);
    assert.deepEqual(entries.filter(entry => matchFilter(entry, filter)).map(entry => entry.id), expected);
  }
  assert.deepEqual(countByLevel(entries), { V: 0, D: 0, I: 1, W: 1, E: 1, F: 0, A: 0 });
});

test('global and sticky regexes start independently for every log entry', () => {
  for (const regexFlags of ['g', 'y', 'gi', 'yi']) {
    assert.deepEqual(filterEntries(entries.slice(0, 2), { regex: 'Crash', regexFlags }).map(entry => entry.id), ['1', '2']);
  }
});

test('metadata-only filtering does not read or lowercase raw log messages', () => {
  const entry = { pkg: 'com.demo', tag: 'main', pid: 42, level: 'E', get raw() { throw new Error('raw must not be read'); } };
  assert.deepEqual(filterEntries([entry], { pkg: 'demo', tag: 'MAIN', pid: 42, minLevel: 'W' }), [entry]);
});

test('a filter pass constructs its regex once rather than once per line', () => {
  const OriginalRegExp = globalThis.RegExp;
  let constructed = 0;
  globalThis.RegExp = function (...args) { constructed++; return new OriginalRegExp(...args); };
  try {
    assert.equal(filterEntries(Array(1000).fill(entries[0]), { regex: 'crash' }).length, 1000);
    assert.equal(constructed, 1);
  } finally {
    globalThis.RegExp = OriginalRegExp;
  }
});
