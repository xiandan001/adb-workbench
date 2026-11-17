import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { normalizeActivityDismissals, ACTIVITY_DISMISSALS_KEY } from '../src/shared/activityDismissals.js';
import { collectMigrationPreferences, applyMigrationPreferences } from '../src/shared/dataMigrationStorage.js';
const require = createRequire(import.meta.url), policy = require('../electron/lib/activity-dismissal-policy.cjs');
const memory = () => { const values = new Map(); return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };

test('activity removal metadata has exact frontend/main parity and round-trips backup without content or actions', () => {
  const value = { version: 1, entries: [{ key: 'a'.repeat(64), through: 12345 }] };
  assert.deepEqual(policy.normalizeActivityDismissals(value), normalizeActivityDismissals(value));
  const source = memory(); source.setItem(ACTIVITY_DISMISSALS_KEY, JSON.stringify(value));
  const main = require('../electron/lib/data-migration-policy.cjs'), restored = memory();
  applyMigrationPreferences(main.normalizePreferences(collectMigrationPreferences(source)), restored);
  assert.deepEqual(JSON.parse(restored.getItem(ACTIVITY_DISMISSALS_KEY)), value);
  for (const changed of [{ ...value, raw: 'secret' }, { version: 1, entries: [{ ...value.entries[0], path: 'private' }] },
    { version: 1, entries: [{ key: 'a'.repeat(64), through: -1 }] }, { version: 1, entries: [value.entries[0], value.entries[0]] }]) {
    assert.throws(() => normalizeActivityDismissals(changed)); assert.throws(() => policy.normalizeActivityDismissals(changed));
    assert.throws(() => applyMigrationPreferences({ [ACTIVITY_DISMISSALS_KEY]: JSON.stringify(changed) }, restored));
    assert.deepEqual(JSON.parse(restored.getItem(ACTIVITY_DISMISSALS_KEY)), value);
  }
});
