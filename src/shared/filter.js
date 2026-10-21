import { levelOrder } from './logTypes.js';

function compileFilter(filter) {
  const pkg = filter.pkg?.toLowerCase();
  const tag = filter.tag?.toLowerCase();
  const text = filter.text?.toLowerCase();
  const excludeText = filter.excludeText?.toLowerCase();
  let regex;
  if (filter.regex) {
    try {
      regex = new RegExp(filter.regex, filter.regexFlags ?? 'i');
    } catch {
      return () => false;
    }
  }

  return (entry) => {
    if (filter.minLevel && entry.level && levelOrder[entry.level] < levelOrder[filter.minLevel]) return false;
    if (typeof filter.pid === 'number' && entry.pid !== filter.pid) return false;
    if (pkg && !(entry.pkg ?? '').toLowerCase().includes(pkg)) return false;
    if (tag && !(entry.tag ?? '').toLowerCase().includes(tag)) return false;
    if (text || excludeText) {
      const hay = (entry.raw ?? '').toLowerCase();
      if (text && !hay.includes(text)) return false;
      if (excludeText && hay.includes(excludeText)) return false;
    }
    if (regex) {
      // A reused g/y expression must still match each log independently.
      regex.lastIndex = 0;
      if (!regex.test(entry.raw)) return false;
    }
    return true;
  };
}

export function matchFilter(entry, filter) {
  return compileFilter(filter)(entry);
}

export function filterEntries(entries, filter) {
  if (!filter || (!filter.minLevel && !filter.text && !filter.excludeText && !filter.tag && typeof filter.pid !== 'number' && !filter.pkg && !filter.regex)) {
    return entries;
  }
  return entries.filter(compileFilter(filter));
}

export function countByLevel(entries) {
  return entries.reduce(
    (acc, e) => {
      if (e.level) acc[e.level] = (acc[e.level] ?? 0) + 1;
      return acc;
    },
    { V: 0, D: 0, I: 0, W: 0, E: 0, F: 0, A: 0 }
  );
}
