export const RECENT_APKS_KEY = 'adb-workbench.recent-apks.v1';
export const FAVORITE_PACKAGES_KEY = 'adb-workbench.favorite-packages.v1';
export const FAVORITE_PACKAGES_EVENT = 'adb-workbench:favorite-packages';

function readList(key, storage) {
  try {
    const value = JSON.parse(storage.getItem(key) || '[]');
    return Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string' && item.trim()))] : [];
  } catch {
    return [];
  }
}

export function readRecentApks(storage = globalThis.localStorage) {
  return readList(RECENT_APKS_KEY, storage).filter(item => /\.apk$/i.test(item)).slice(0, 5);
}

export function addRecentApk(paths, filePath) {
  if (typeof filePath !== 'string' || !/\.apk$/i.test(filePath)) return paths;
  const key = value => value.replaceAll('\\', '/').toLowerCase();
  return [filePath, ...paths.filter(item => key(item) !== key(filePath))].slice(0, 5);
}

export function readFavoritePackages(storage = globalThis.localStorage) {
  return readList(FAVORITE_PACKAGES_KEY, storage);
}

export function saveShortcutList(key, values, storage = globalThis.localStorage) {
  try {
    storage.setItem(key, JSON.stringify(values));
    return true;
  } catch {
    return false;
  }
}

export function filterPackages(packages, { query = '', showSystem = false, onlyFavorites = false, favorites = [] }) {
  const favoriteSet = new Set(favorites);
  const text = query.trim().toLowerCase();
  return packages
    .filter(item => onlyFavorites ? favoriteSet.has(item.packageName) : showSystem || !item.system)
    .filter(item => !text || `${item.packageName} ${item.apkName || ''}`.toLowerCase().includes(text))
    .sort((a, b) => Number(favoriteSet.has(b.packageName)) - Number(favoriteSet.has(a.packageName)));
}
