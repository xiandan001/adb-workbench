import themes from '../data/themes.js';

const ATTRIBUTE = 'data-workbench-theme', owners = new WeakMap();

export function applyThemeScope(theme, document = globalThis.document) {
  const root = document?.documentElement;
  if (!root) return () => {};
  const active = owners.get(root), previous = active ? active.previous : root.getAttribute(ATTRIBUTE);
  const scope = theme === themes.graphite ? 'graphite' : null, owner = { previous };
  owners.set(root, owner);
  if (scope) root.setAttribute(ATTRIBUTE, scope); else root.removeAttribute(ATTRIBUTE);
  return () => {
    if (owners.get(root) !== owner) return;
    owners.delete(root);
    if (root.getAttribute(ATTRIBUTE) !== scope) return;
    if (previous === null) root.removeAttribute(ATTRIBUTE); else root.setAttribute(ATTRIBUTE, previous);
  };
}
