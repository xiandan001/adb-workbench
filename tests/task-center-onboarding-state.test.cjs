const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ONBOARDING_SCHEMA_VERSION,
  createOnboardingState,
  normalizeOnboardingState
} = require('../electron/lib/task-center-onboarding-state.cjs');

test('creates completed and skipped markers', () => {
  const now = new Date('2026-08-03T01:02:03.000Z');
  assert.deepEqual(createOnboardingState('completed', now), {
    schemaVersion: ONBOARDING_SCHEMA_VERSION,
    status: 'completed',
    updatedAt: '2026-08-03T01:02:03.000Z'
  });
  assert.equal(createOnboardingState('skipped', now).status, 'skipped');
});

test('rejects unknown status and malformed timestamps', () => {
  assert.equal(normalizeOnboardingState(null), null);
  assert.equal(normalizeOnboardingState({
    schemaVersion: 1,
    status: 'started',
    updatedAt: '2026-08-03T01:02:03.000Z'
  }), null);
  assert.equal(normalizeOnboardingState({
    schemaVersion: 1,
    status: 'completed',
    updatedAt: 'not-a-date'
  }), null);
  assert.equal(normalizeOnboardingState({
    schemaVersion: 1,
    status: 'completed',
    updatedAt: 0
  }), null);
  assert.throws(() => createOnboardingState('started'), /invalid_onboarding_status/);
});

test('normalizes a valid persisted marker', () => {
  assert.deepEqual(normalizeOnboardingState({
    schemaVersion: 1,
    status: 'skipped',
    updatedAt: '2026-08-03T01:02:03.000Z',
    ignored: true
  }), {
    schemaVersion: 1,
    status: 'skipped',
    updatedAt: '2026-08-03T01:02:03.000Z'
  });
});
