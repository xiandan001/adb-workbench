const ONBOARDING_SCHEMA_VERSION = 1;
const VALID_STATUSES = new Set(['completed', 'skipped']);

function normalizeOnboardingState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.schemaVersion !== ONBOARDING_SCHEMA_VERSION) return null;
  if (!VALID_STATUSES.has(value.status)) return null;
  if (typeof value.updatedAt !== 'string') return null;
  const timestamp = Date.parse(value.updatedAt);
  if (!Number.isFinite(timestamp)) return null;
  return {
    schemaVersion: ONBOARDING_SCHEMA_VERSION,
    status: value.status,
    updatedAt: new Date(timestamp).toISOString()
  };
}

function createOnboardingState(status, now = new Date()) {
  if (!VALID_STATUSES.has(status)) throw new Error('invalid_onboarding_status');
  const updatedAt = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(updatedAt.getTime())) throw new Error('invalid_onboarding_timestamp');
  return {
    schemaVersion: ONBOARDING_SCHEMA_VERSION,
    status,
    updatedAt: updatedAt.toISOString()
  };
}

module.exports = {
  ONBOARDING_SCHEMA_VERSION,
  createOnboardingState,
  normalizeOnboardingState
};
