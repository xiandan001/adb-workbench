const JSON5 = require('json5');
const { fail } = require('./ai-tools-file-safety.cjs');
const { isDeepStrictEqual } = require('node:util');

// JSON5 validates semantics. This bounded reader only records source ranges; it never evaluates code.
function parseRanges(input) {
  const source = input.trim() ? input : '{}\n';
  let value;
  try { value = JSON5.parse(source); } catch { throw fail('AI_TOOLS_CONFIG_JSON5', 'JSON5 配置格式无效，未修改'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('AI_TOOLS_CONFIG_JSON5', 'JSON5 配置必须是对象');
  let position = 0; let count = 0;
  function skip() {
    while (position < source.length) {
      if (/\s/u.test(source[position])) { position += 1; continue; }
      if (source.startsWith('//', position)) { const end = source.indexOf('\n', position); position = end < 0 ? source.length : end + 1; continue; }
      if (source.startsWith('/*', position)) { const end = source.indexOf('*/', position + 2); if (end < 0) throw fail('AI_TOOLS_CONFIG_JSON5', 'JSON5 注释未闭合'); position = end + 2; continue; }
      break;
    }
  }
  function token() {
    const start = position;
    if (source[position] === '"' || source[position] === "'") {
      const quote = source[position++];
      while (position < source.length) {
        const c = source[position++];
        if (c === '\\') { if (source[position] === '\r' && source[position + 1] === '\n') position += 2; else position += 1; }
        else if (c === quote) return { start, end: position };
      }
    } else {
      while (position < source.length && !/[\s,:{}[\]]/u.test(source[position]) && !source.startsWith('//', position) && !source.startsWith('/*', position)) position += 1;
      if (position > start) return { start, end: position };
    }
    throw fail('AI_TOOLS_CONFIG_JSON5', 'JSON5 词法结构不能安全定位，未修改');
  }
  function node(depth = 0) {
    skip(); if (++count > 50000 || depth > 64) throw fail('AI_TOOLS_CONFIG_JSON5', 'JSON5 配置结构过深或过大');
    const start = position; const c = source[position];
    if (c !== '{' && c !== '[') return { type: 'scalar', ...token() };
    const object = c === '{'; const close = object ? '}' : ']'; position += 1;
    const children = []; const names = new Set(); skip();
    while (source[position] !== close) {
      let key = children.length;
      if (object) {
        const keyRange = token(); const raw = source.slice(keyRange.start, keyRange.end);
        try { key = Object.keys(JSON5.parse(`{${raw}:null}`))[0]; } catch { throw fail('AI_TOOLS_CONFIG_JSON5', 'JSON5 字段名不能安全解析'); }
        if (names.has(key)) throw fail('AI_TOOLS_CONFIG_JSON5', 'JSON5 配置包含重复字段，未修改');
        names.add(key); skip(); if (source[position++] !== ':') throw fail('AI_TOOLS_CONFIG_JSON5', 'JSON5 字段结构无效');
      }
      children.push({ key, value: node(depth + 1) }); skip();
      if (source[position] === close) break;
      if (source[position++] !== ',') throw fail('AI_TOOLS_CONFIG_JSON5', 'JSON5 字段分隔无效');
      skip();
    }
    position += 1;
    return { type: object ? 'object' : 'array', start, end: position, children };
  }
  const root = node(); skip();
  if (position !== source.length) throw fail('AI_TOOLS_CONFIG_JSON5', 'JSON5 配置包含多余内容');
  return { source, value, root };
}

function setJson5Path(content, keys, value) {
  const parsed = parseRanges(content); let node = parsed.root; let depth = 0;
  while (depth < keys.length) {
    if (node.type !== 'object') throw fail('AI_TOOLS_CONFIG_JSON5', 'JSON5 受管理父字段不是对象，未修改');
    const child = node.children.find(item => item.key === keys[depth]);
    if (!child) break;
    node = child.value; depth += 1;
  }
  let result;
  if (depth === keys.length) result = parsed.source.slice(0, node.start) + JSON5.stringify(value, null, 2) + parsed.source.slice(node.end);
  else {
    let nested = value;
    for (let i = keys.length - 1; i > depth; i -= 1) nested = { [keys[i]]: nested };
    const end = node.end - 1; const tail = node.children.length ? parsed.source.slice(node.children.at(-1).value.end, end) : '';
    const trailingComma = /^\s*,/.test(tail.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, ''));
    const insertion = `${node.children.length && !trailingComma ? ',' : ''}\n${JSON.stringify(keys[depth])}: ${JSON5.stringify(nested, null, 2)}\n`;
    result = parsed.source.slice(0, end) + insertion + parsed.source.slice(end);
  }
  const expected = structuredClone(parsed.value); let target = expected;
  for (let i = 0; i < keys.length - 1; i += 1) { if (!Object.hasOwn(target, keys[i])) target[keys[i]] = {}; target = target[keys[i]]; }
  target[keys.at(-1)] = value;
  if (!isDeepStrictEqual(parseRanges(result).value, expected)) throw fail('AI_TOOLS_CONFIG_JSON5', 'JSON5 修改会影响其他字段，未修改');
  return result;
}

module.exports = { parseRanges, setJson5Path };
