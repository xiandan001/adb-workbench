import { tr } from './i18n.js';

export const AI_DRAFT_KEY = 'adb-workbench.ai-selection-draft.v1';
export const AI_DRAFT_CHECKS = ['device_info', 'logcat_snapshot', 'performance_snapshot', 'app_package', 'app_process', 'app_memory', 'app_activity'];
const modes = ['diagnose', 'analysis', 'task'];
const PACKAGE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
export const validAiDiagnosticPackage = value => typeof value === 'string' && value.length <= 200 && (!value || PACKAGE.test(value));
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const invalid = () => { throw new Error(tr('AI 选择草稿无效，原内容已保留。')); };
export function normalizeAiSelectionDraft(value) {
  if (!exact(value, ['version', 'mode', 'cases']) || value.version !== 1 || !modes.includes(value.mode) || !exact(value.cases, modes)) invalid();
  const cases = Object.fromEntries(modes.map(mode => {
    const item = value.cases[mode];
    if (!exact(item, ['deviceId', 'checks', 'diagnostic']) || typeof item.deviceId !== 'string' || item.deviceId.length > 300
      || /\s/u.test(item.deviceId) || Array.from(item.deviceId).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || !Array.isArray(item.checks) || item.checks.length > 7
      || new Set(item.checks).size !== item.checks.length || item.checks.some(id => !AI_DRAFT_CHECKS.includes(id))
      || !exact(item.diagnostic, ['packageName', 'symptom']) || !validAiDiagnosticPackage(item.diagnostic.packageName)
      || !['', 'crash', 'launch', 'slow'].includes(item.diagnostic.symptom)) invalid();
    return [mode, { deviceId: item.deviceId, checks: [...item.checks], diagnostic: { ...item.diagnostic } }];
  }));
  return { version: 1, mode: value.mode, cases };
}
export function aiSelectionDraft(mode, cases) {
  return normalizeAiSelectionDraft({ version: 1, mode, cases: Object.fromEntries(modes.map(key => {
    const current = cases[key];
    return [key, { deviceId: current.deviceId, checks: [...current.checks], diagnostic: { ...current.diagnostic } }];
  })) });
}
export function readAiSelectionDraft(storage = globalThis.localStorage) {
  const raw = storage?.getItem(AI_DRAFT_KEY);
  if (raw === null || raw === undefined) return null;
  try { if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 16384) invalid(); return normalizeAiSelectionDraft(JSON.parse(raw)); }
  catch { invalid(); }
}
export function saveAiSelectionDraft(value, storage = globalThis.localStorage) {
  const next = normalizeAiSelectionDraft(value); readAiSelectionDraft(storage);
  const raw = JSON.stringify(next);
  if (storage.getItem(AI_DRAFT_KEY) !== raw) storage.setItem(AI_DRAFT_KEY, raw);
  return next;
}
export function restoreAiSelectionDraft(saved, create) {
  if (!saved) return null;
  const valid = normalizeAiSelectionDraft(saved);
  return { mode: valid.mode, cases: Object.fromEntries(modes.map(mode => {
    const metadata = valid.cases[mode], current = create(mode, metadata.deviceId);
    const meaningful = metadata.deviceId || metadata.diagnostic.packageName || metadata.diagnostic.symptom || JSON.stringify(metadata.checks) !== JSON.stringify(current.checks);
    return [mode, { ...current, ...metadata, ...(mode === 'task' ? { requirements: { ...current.requirements, application: metadata.diagnostic.packageName } } : {}), pristine: !meaningful, restoredSelection: Boolean(meaningful) }];
  })) };
}
