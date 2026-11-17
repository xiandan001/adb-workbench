const { tr } = require('./localization.cjs');
const { ACTIVITY_DISMISSALS_KEY, ACTIVITY_DISMISSALS_BYTES, normalizeActivityDismissals } = require('./activity-dismissal-policy.cjs');
const { RS232_MEMORY_KEY, RS232_MEMORY_BYTES, normalizeRs232Memory } = require('./rs232-memory-policy.cjs');

const APPLICATION_CONTEXT_KEY = 'adb-workbench.application-context.v1';
const APPLICATION_RECENTS_KEY = 'adb-workbench.application-recents.v1';
const AI_DRAFT_KEY = 'adb-workbench.ai-selection-draft.v1';
const ARTIFACT_VIEW_KEY = 'adb-workbench.artifact-view.v1';
const SERIAL_SCHEME_SELECTION_KEY = 'adb-workbench.serial-scheme-selection.v1';
const UX_METADATA_KEYS = Object.freeze([APPLICATION_CONTEXT_KEY, APPLICATION_RECENTS_KEY, AI_DRAFT_KEY, ARTIFACT_VIEW_KEY, SERIAL_SCHEME_SELECTION_KEY, ACTIVITY_DISMISSALS_KEY, RS232_MEMORY_KEY]);
const MODES = ['diagnose', 'analysis', 'task'];
const CHECKS = ['device_info', 'logcat_snapshot', 'performance_snapshot', 'app_package', 'app_process', 'app_memory', 'app_activity'];
const TYPES = ['all', 'troubleshooting', 'inspection', 'regression', 'deviceGuard', 'performance', 'task', 'reproduction'];
const ORDERS = ['newest', 'oldest', 'size'];
const fail = () => { throw new Error(tr('本地偏好数据无效')); };
const shape = (value, keys, allowNull = true) => value && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || allowNull && Object.getPrototypeOf(value) === null)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const clean = (value, max) => typeof value === 'string' && value.length <= max
  && !Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const device = (value, allowEmpty = false) => clean(value, 300) && (allowEmpty || Boolean(value)) && !/\s/u.test(value);
const packageName = value => clean(value, 256) && Boolean(value) && /^[A-Za-z0-9_.-]+$/.test(value);

function normalizeApplicationContext(value) {
  if (!shape(value, ['version', 'entries']) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 20) fail();
  const seen = new Set();
  const entries = Array.from(value.entries, item => {
    if (!shape(item, ['deviceId', 'packageName']) || !device(item.deviceId) || seen.has(item.deviceId) || !packageName(item.packageName)) fail();
    seen.add(item.deviceId); return { deviceId: item.deviceId, packageName: item.packageName };
  });
  return { version: 1, entries };
}
function normalizeApplicationRecents(value) {
  if (!shape(value, ['version', 'items'], false) || value.version !== 1 || !Array.isArray(value.items) || value.items.length > 20) fail();
  const seen = new Set();
  return { version: 1, items: value.items.map(item => {
    if (!shape(item, ['deviceId', 'packages'], false) || !device(item.deviceId) || seen.has(item.deviceId) || !Array.isArray(item.packages)
      || item.packages.length > 6 || new Set(item.packages).size !== item.packages.length || item.packages.some(name => !packageName(name))) fail();
    seen.add(item.deviceId); return { deviceId: item.deviceId, packages: [...item.packages] };
  }) };
}
function normalizeAiSelectionDraft(value) {
  if (!shape(value, ['version', 'mode', 'cases'], false) || value.version !== 1 || !MODES.includes(value.mode) || !shape(value.cases, MODES, false)) fail();
  const cases = Object.fromEntries(MODES.map(mode => {
    const item = value.cases[mode];
    if (!shape(item, ['deviceId', 'checks', 'diagnostic'], false) || !device(item.deviceId, true) || !Array.isArray(item.checks)
      || item.checks.length > 7 || new Set(item.checks).size !== item.checks.length || item.checks.some(id => !CHECKS.includes(id))
      || !shape(item.diagnostic, ['packageName', 'symptom'], false) || typeof item.diagnostic.packageName !== 'string' || item.diagnostic.packageName.length > 200
      || item.diagnostic.packageName && !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(item.diagnostic.packageName)
      || !['', 'crash', 'launch', 'slow'].includes(item.diagnostic.symptom)) fail();
    return [mode, { deviceId: item.deviceId, checks: [...item.checks], diagnostic: { ...item.diagnostic } }];
  }));
  return { version: 1, mode: value.mode, cases };
}
function normalizeArtifactViewState(value) {
  if (!shape(value, ['version', 'entries']) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 20) fail();
  const seen = new Set();
  const entries = value.entries.map(item => {
    if (!shape(item, ['deviceId', 'query', 'typeFilter', 'sortOrder', 'visibleCount']) || !clean(item.deviceId, 300) || seen.has(item.deviceId)
      || !clean(item.query, 300) || !TYPES.includes(item.typeFilter) || !ORDERS.includes(item.sortOrder) || !Number.isSafeInteger(item.visibleCount)
      || item.visibleCount < 30 || item.visibleCount > 3000 || item.visibleCount % 30) fail();
    seen.add(item.deviceId); return { deviceId: item.deviceId, query: item.query, typeFilter: item.typeFilter, sortOrder: item.sortOrder, visibleCount: item.visibleCount };
  });
  const result = { version: 1, entries };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 128 * 1024) fail();
  return result;
}
function normalizeSerialSchemeSelection(value) {
  const folds = ['rs232Expanded', 'terminalExpanded'];
  if (!value || !shape(value, ['version', 'rs232', 'terminal', ...folds.filter(key => Object.hasOwn(value, key))]) || value.version !== 1
    || folds.some(key => Object.hasOwn(value, key) && typeof value[key] !== 'boolean')
    || ['rs232', 'terminal'].some(key => !clean(value[key], 200) || value[key] && !value[key].trim())) fail();
  return { version: 1, rs232: value.rs232, terminal: value.terminal, rs232Expanded: value.rs232Expanded ?? false, terminalExpanded: value.terminalExpanded ?? false };
}

const RULES = new Map([
  [APPLICATION_CONTEXT_KEY, { limit: 32768, normalize: normalizeApplicationContext }],
  [APPLICATION_RECENTS_KEY, { limit: 65536, normalize: normalizeApplicationRecents }],
  [AI_DRAFT_KEY, { limit: 16384, normalize: normalizeAiSelectionDraft }],
  [ARTIFACT_VIEW_KEY, { limit: 131072, normalize: normalizeArtifactViewState }],
  [SERIAL_SCHEME_SELECTION_KEY, { limit: 2048, characters: true, normalize: normalizeSerialSchemeSelection }],
  [ACTIVITY_DISMISSALS_KEY, { limit: ACTIVITY_DISMISSALS_BYTES, normalize: normalizeActivityDismissals }],
  [RS232_MEMORY_KEY, { limit: RS232_MEMORY_BYTES, normalize: normalizeRs232Memory }]
]);
function normalizeUxMetadataPreference(key, raw) {
  const rule = RULES.get(key);
  if (!rule || typeof raw !== 'string' || (rule.characters ? raw.length : Buffer.byteLength(raw, 'utf8')) > rule.limit) fail();
  let value;
  try { value = JSON.parse(raw); } catch { fail(); }
  return JSON.stringify(rule.normalize(value));
}
module.exports = { APPLICATION_CONTEXT_KEY, APPLICATION_RECENTS_KEY, AI_DRAFT_KEY, ARTIFACT_VIEW_KEY, SERIAL_SCHEME_SELECTION_KEY,
  UX_METADATA_KEYS, normalizeApplicationContext, normalizeApplicationRecents, normalizeAiSelectionDraft, normalizeArtifactViewState,
  normalizeSerialSchemeSelection, normalizeUxMetadataPreference };
