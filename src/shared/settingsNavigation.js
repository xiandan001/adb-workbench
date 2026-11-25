import { tr } from './i18n.js';

const categoryIds = ['software', 'legal', 'version'];
export const softwareSettingsSections = Object.freeze([
  'settings-commands', 'settings-cast', 'settings-paths', 'settings-appearance',
  'settings-data', 'settings-support', 'settings-danger',
]);

export function settingsCategories() {
  return [
    { id: 'software', label: tr('软件') },
    { id: 'legal', label: tr('法律') },
    { id: 'version', label: tr('版本') },
  ];
}

export function settingsCategoryForSection(sectionId) {
  if (softwareSettingsSections.includes(sectionId)) return 'software';
  if (sectionId === 'settings-legal') return 'legal';
  if (sectionId === 'settings-update') return 'version';
  return null;
}

export function nextSettingsCategory(categoryId, key) {
  if (key === 'Home') return categoryIds[0];
  if (key === 'End') return categoryIds.at(-1);
  const index = categoryIds.indexOf(categoryId);
  const offset = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0;
  return index < 0 || !offset ? null : categoryIds[(index + offset + categoryIds.length) % categoryIds.length];
}
