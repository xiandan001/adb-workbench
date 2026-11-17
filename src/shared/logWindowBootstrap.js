export function startLogWindow({ render, initializeLanguage, onFailure = () => {} }) {
  render();
  try { return Promise.resolve(initializeLanguage()).catch(() => { onFailure('language-unavailable'); }); }
  catch { onFailure('language-unavailable'); return Promise.resolve(); }
}
