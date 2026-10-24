function parameters(message) {
  return [...message.matchAll(/\{(\d+)\}/g)].map(match => match[1]);
}

function pattern(message) {
  const pieces = message.split(/(\{\d+\})/);
  const positions = [], groups = new Map();
  const expression = pieces.map(piece => {
    const index = /^\{(\d+)\}$/.exec(piece)?.[1];
    if (index === undefined) return piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (groups.has(index)) return '\\' + groups.get(index);
    positions.push(index); groups.set(index, positions.length); return '([\\s\\S]*?)';
  }).join('');
  const needle = pieces.filter(piece => !/^\{\d+\}$/.test(piece)).sort((left, right) => right.length - left.length)[0] || '';
  return { regex: new RegExp('^' + expression + '$'), positions, needle };
}

// Retained application messages can be re-rendered after a language switch.
// This is never applied to arbitrary DOM nodes, logs, commands or user content.
export function createMessageTranslator(entries) {
  const catalog = new Map(entries);
  const reverse = new Map();
  const templates = [];
  const recent = new Map();
  for (const [source, english] of catalog) {
    if (!reverse.has(english)) reverse.set(english, source);
    if (parameters(source).length) {
      templates.push({ source, ...pattern(source) });
      if (english !== source) templates.push({ source, ...pattern(english) });
    }
  }
  function resolve(text) {
    if (catalog.has(text)) return { source: text, params: {} };
    if (recent.has(text)) return recent.get(text);
    if (reverse.has(text)) return { source: reverse.get(text), params: {} };
    // Avoid unbounded work for large external diagnostic messages.
    if (text.length > 8192) return null;
    for (const template of templates) {
      if (template.needle && !text.includes(template.needle)) continue;
      const match = template.regex.exec(text);
      if (match) return { source: template.source, params: Object.fromEntries(template.positions.map((index, position) => [index, match[position + 1]])) };
    }
    return null;
  }
  return (text, params = {}, locale = 'zh-CN') => {
    if (typeof text !== 'string') return text;
    const descriptor = catalog.has(text) ? { source: text, params } : resolve(text);
    if (!descriptor) return text;
    const source = descriptor.source;
    const message = locale === 'en-US' ? catalog.get(source) : source;
    const result = message.replace(/\{(\d+)\}/g, (token, index) => Object.prototype.hasOwnProperty.call(descriptor.params, index) ? String(descriptor.params[index] ?? '') : token);
    if (result !== source && result.length <= 8192 && parameters(source).length) {
      recent.set(result, descriptor);
      if (recent.size > 128) recent.delete(recent.keys().next().value);
    }
    return result;
  };
}
