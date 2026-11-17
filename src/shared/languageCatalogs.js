export const languageCatalogs = {
  'en-US': () => import('../locales/en-catalog.js').then(module => module.default),
  'zh-TW': () => import('../locales/tw-catalog.js').then(module => module.default),
  'ja-JP': () => import('../locales/ja-catalog.js').then(module => module.default),
  'ko-KR': () => import('../locales/ko-catalog.js').then(module => module.default),
};
