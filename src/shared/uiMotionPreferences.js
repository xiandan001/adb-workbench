export const UI_MOTION_PREFS_KEY = 'adb-workbench.ui-motion.v1';
export const UI_MOTION_CHANGED = 'workbench:motion-preferences-changed';
export const defaultUiMotionPreferences = () => ({ version: 1, reducedMotion: false, startupAnimation: true });

export function normalizeUiMotionPreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).sort().join(',') !== 'reducedMotion,startupAnimation,version' || value.version !== 1
    || typeof value.reducedMotion !== 'boolean' || typeof value.startupAnimation !== 'boolean') throw new Error('启动与动效偏好格式无效');
  return { version: 1, reducedMotion: value.reducedMotion, startupAnimation: value.startupAnimation };
}

export function readUiMotionPreferences(storage = globalThis.localStorage) {
  try {
    const raw = storage.getItem(UI_MOTION_PREFS_KEY);
    if (raw === null || raw === undefined) return defaultUiMotionPreferences();
    if (typeof raw !== 'string' || raw.length > 256) throw new Error('Invalid preference');
    return normalizeUiMotionPreferences(JSON.parse(raw));
  } catch { throw new Error('启动与动效偏好读取失败，原数据未修改；可重新选择后保存'); }
}

export function saveUiMotionPreferences(value, storage = globalThis.localStorage) {
  const next = normalizeUiMotionPreferences(value);
  try { storage.setItem(UI_MOTION_PREFS_KEY, JSON.stringify(next)); }
  catch { throw new Error('启动与动效偏好保存失败，请重试'); }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(UI_MOTION_CHANGED));
  return next;
}

export function applyUiMotionPreferences(value, target = document.documentElement, systemReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const next = normalizeUiMotionPreferences(value);
  target.dataset.reducedMotion = String(next.reducedMotion || systemReduced);
  target.dataset.startupAnimation = String(next.startupAnimation);
}

export function preferredScrollBehavior() {
  return document.documentElement.dataset.reducedMotion === 'true' || window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}
