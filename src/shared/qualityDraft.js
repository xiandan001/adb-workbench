const KEY = 'quality-verification-drafts-v1';
const defaults = Object.freeze({ selectedBaselinePath: '', baselineName: '', reportName: '', includePerformance: true,
  suiteId: 'smoke', apkPath: '', packageName: '', baselineImagePath: '', rounds: 5, launchWaitMs: 5000, threshold: 98,
  guardIntervalMs: 15000, qualityTab: 'regression', lastTaskId: '' });
export function normalizeQualityDraft(value = {}) {
  const output = { ...defaults };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
  for (const key of ['selectedBaselinePath', 'baselineName', 'reportName', 'suiteId', 'apkPath', 'packageName', 'baselineImagePath', 'lastTaskId']) {
    const limit = key.endsWith('Path') ? 4096 : 240;
    if (typeof value[key] === 'string' && value[key].length <= limit && !Array.from(value[key]).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) output[key] = value[key];
  }
  if (typeof value.includePerformance === 'boolean') output.includePerformance = value.includePerformance;
  if (['regression', 'acceptance', 'guard'].includes(value.qualityTab)) output.qualityTab = value.qualityTab;
  for (const [key, min, max] of [['rounds', 1, 1000], ['launchWaitMs', 1000, 60000], ['threshold', 0, 100], ['guardIntervalMs', 5000, 300000]]) {
    if (Number.isFinite(value[key]) && value[key] >= min && value[key] <= max) output[key] = value[key];
  }
  return output;
}
function readAll(storage) {
  try {
    const source = storage.getItem(KEY);
    if (!source) return { drafts: [], blocked: false };
    if (source.length > 192 * 1024) return { drafts: [], blocked: true };
    const value = JSON.parse(source);
    if (value.version !== 1 || !Array.isArray(value.drafts) || value.drafts.length > 10
      || value.drafts.some(item => !item || typeof item.deviceId !== 'string' || item.deviceId.length > 512 || !Number.isFinite(item.updatedAt)
        || !item.form || typeof item.form !== 'object' || Array.isArray(item.form))
      || new Set(value.drafts.map(item => item.deviceId)).size !== value.drafts.length) return { drafts: [], blocked: true };
    return { drafts: value.drafts, blocked: false };
  } catch { return { drafts: [], blocked: true }; }
}
export function readQualityDraft(storage, deviceId) {
  return normalizeQualityDraft(readAll(storage).drafts.find(item => item.deviceId === deviceId)?.form);
}
export function writeQualityDraft(storage, deviceId, form, now = Date.now()) {
  if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 512) return false;
  const previous = readAll(storage);
  if (previous.blocked) return false;
  const drafts = [{ deviceId, updatedAt: now, form: normalizeQualityDraft(form) }, ...previous.drafts.filter(item => item.deviceId !== deviceId)].slice(0, 10);
  try { storage.setItem(KEY, JSON.stringify({ version: 1, drafts })); return true; } catch { return false; }
}
