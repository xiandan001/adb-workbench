const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const HAN = /[\u3400-\u9fff]/;
const VISIBLE_ATTRIBUTES = new Set(['title', 'placeholder', 'aria-label', 'aria-description', 'alt', 'label', 'emptyText', 'description', 'confirmLabel', 'cancelLabel', 'ariaLabel']);
const TECHNICAL_TERMS = new Set(['ADB', 'AI', 'API', 'APK', 'ASCII', 'Bash', 'CPU', 'Ctrl', 'DTR', 'English', 'FPS', 'GPU', 'HEX', 'IP', 'JSON', 'MCP', 'OEM', 'OTA', 'PATH', 'PID', 'PNG', 'RAM', 'RS232', 'RTS', 'SFTP', 'SSH', 'Skills', 'TOML', 'TX', 'RX', 'UTF-8', 'XML', 'YAML', 'scrcpy', 'Ctrl+Enter', 'Ctrl+K', 'Ctrl+C', 'Ctrl+V', 'Tab', 'Enter', 'Esc', 'Root', 'Remount', 'Loader', 'Unlock', 'Android', 'GitHub', 'OAuth', 'HTTPS', 'TLS', 'TCP', 'UDP', 'USB', 'Wi-Fi', 'Windows', 'Linux', 'macOS', 'WebDAV', 'Claude Code', 'Codex', 'Gemini CLI', 'OpenCode', 'OpenClaw', 'Hermes', 'Kimi Code', 'Grok Build', 'Antigravity', 'MCode', 'Pi', 'KB', 'MB', 'GB', 'KiB', 'MiB', 'GiB', 'ms', 'px', 'Hz', 'OK', 'N/A']);
const SKIP_FILES = new Set(['electron/api-keys.cjs', 'electron/lib/ai-keys.cjs']);
const TRANSLATORS = new Set(['tr', 'trFor']);
const normalized = value => value.replace(/\s+/g, ' ').trim();
const identity = (file, kind, source) => crypto.createHash('sha256').update(JSON.stringify([file, kind, source])).digest('hex').slice(0, 24);
const placeholders = value => [...new Set(value.match(/\{\d+\}/g) || [])].sort().join(',');
const sourceValue = node => node.type === 'StringLiteral' ? node.value : node.type === 'TemplateLiteral' ? node.quasis.map((part, index) => (part.value.cooked ?? part.value.raw) + (index < node.expressions.length ? `{${index}}` : '')).join('') : normalized(node.value || '');
function translator(pathNode) {
  const parent = pathNode.parent;
  return parent?.type === 'CallExpression' && parent.arguments[0] === pathNode.node && (TRANSLATORS.has(parent.callee?.name) || parent.callee?.type === 'MemberExpression' && TRANSLATORS.has(parent.callee.property?.name));
}
function consoleDiagnostic(pathNode) {
  return Boolean(pathNode.findParent(parent => parent.isCallExpression() && parent.node.callee?.type === 'MemberExpression' && parent.node.callee.object?.name === 'console'));
}
function technical(value) {
  const text = normalized(value);
  return !/[A-Za-z\u3400-\u9fff]/.test(text) || TECHNICAL_TERMS.has(text) || /^--[a-z][a-z0-9-]*$/.test(text) || /^\d+(?:\.\d+)?\s*(?:Mbps|ms|s|B|KiB|MiB|GiB|Hz|px|K|M|%)$/.test(text);
}
function auditSource({ file, source, catalog, exclusions = [] }) {
  const diagnostics = [], messages = new Set(), usedExclusions = new Set();
  const allowed = new Map(exclusions.filter(item => item.file === file).map(item => [item.id, item]));
  let ast;
  try { ast = parser.parse(source, { sourceType: 'unambiguous', allowReturnOutsideFunction: true, plugins: ['jsx'] }); }
  catch (error) { return { diagnostics: [{ file, line: error.loc?.line || 1, kind: 'parse', message: error.message }], messages, usedExclusions }; }
  function report(node, kind, value, message) {
    const id = identity(file, kind, value), exemption = allowed.get(id);
    if (exemption && typeof exemption.reason === 'string' && exemption.reason.trim().length >= 12) {
      if (exemption.kind !== 'catalog-source' || catalog.has(value)) { usedExclusions.add(id); return; }
    }
    diagnostics.push({ file, line: node.loc?.start.line || 1, column: (node.loc?.start.column || 0) + 1, kind, id, source: value, message });
  }
  traverse(ast, {
    'StringLiteral|TemplateLiteral|JSXText'(p) {
      const node = p.node, value = sourceValue(node), parent = p.parent;
      if (!value.trim()) return;
      if (translator(p)) {
        if (node.type === 'TemplateLiteral' && node.expressions.length) report(node, 'dynamic-key', value, 'Use a static message key and interpolation parameters');
        messages.add(value);
        if (!catalog.has(value)) report(node, 'missing-translation', value, 'No English translation is registered for this message');
        return;
      }
      if (parent?.type === 'ObjectProperty' && parent.key === node && !parent.computed || parent?.type === 'ObjectMethod' && parent.key === node || consoleDiagnostic(p)) return;
      if (p.findParent(q => q.isTemplateLiteral())) return;
      const attribute = parent?.type === 'JSXAttribute' && VISIBLE_ATTRIBUTES.has(parent.name?.name);
      const textNode = node.type === 'JSXText';
      const uiConstructor = parent?.type === 'NewExpression' && ['Error', 'TypeError', 'RangeError'].includes(parent.callee?.name) && parent.arguments[0] === node;
      const displayProperty = parent?.type === 'ObjectProperty' && parent.value === node && VISIBLE_ATTRIBUTES.has(parent.key.name || parent.key.value);
      const displayAssignment = parent?.type === 'AssignmentExpression' && parent.right === node && parent.left?.type === 'MemberExpression' && ['textContent', 'innerText', 'title'].includes(parent.left.property?.name);
      const visibleEnglish = (attribute || textNode || uiConstructor || displayProperty || displayAssignment) && /[a-zA-Z]{2}/.test(value) && !technical(value) && !/^[A-Z][A-Z0-9_]+$/.test(value);
      if (HAN.test(value) || visibleEnglish) report(node, 'unlocalized-literal', value, 'Application text must use tr() or an exact reviewed non-UI exclusion');
      if (value === 'zh-CN' && parent?.type === 'CallExpression' && parent.callee?.type === 'MemberExpression' && /^toLocale(?:Date|Time)?String$/.test(parent.callee.property?.name)) report(node, 'fixed-locale', value, 'Display formatting must use the selected locale');
    },
  });
  return { diagnostics, messages, usedExclusions };
}
function loadCatalog(directory, exclusions = []) {
  const catalog = new Map(), diagnostics = [];
  for (const name of ['en-core.json', 'en-workspace.json', 'en-tools.json', 'en-backend.json']) {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) { diagnostics.push({ file, line: 1, kind: 'catalog', message: 'Required language catalog is missing' }); continue; }
    let entries;
    try { entries = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { diagnostics.push({ file, line: 1, kind: 'catalog', message: error.message }); continue; }
    for (const [key, value] of Object.entries(entries)) {
      if (typeof value !== 'string' || !value.trim()) diagnostics.push({ file, line: 1, kind: 'empty-translation', source: key, message: 'English translation must be nonempty text' });
      else if (placeholders(key) !== placeholders(value)) diagnostics.push({ file, line: 1, kind: 'placeholders', source: key, message: 'Translation interpolation parameters do not match the source' });
      else if (HAN.test(value.replaceAll('卓控台', ''))) {
        const id = identity('electron/locales/' + name, 'catalog-sample', key + '\0' + value);
        if (!exclusions.some(item => item.file === 'electron/locales/' + name && item.id === id && item.kind === 'catalog-sample' && item.reason?.length >= 12)) diagnostics.push({ file, line: 1, kind: 'untranslated-catalog', id, source: key, message: 'English translation still contains untranslated Chinese text' });
      }
      // Domains share common source keys; the runtime follows the same stable priority.
      if (!catalog.has(key)) catalog.set(key, value);
    }
  }
  return { catalog, diagnostics };
}
function runtimeFiles(root) {
  const files = [];
  const walk = directory => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name), relative = path.relative(root, full).replaceAll('\\', '/');
      if (relative === 'electron/locales') continue;
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:jsx?|cjs|mjs)$/.test(entry.name) && !SKIP_FILES.has(relative)) files.push(relative);
    }
  };
  for (const directory of ['src', 'electron', 'public']) walk(path.join(root, directory));
  return files.sort();
}
function auditJson({ file, source, catalog }) {
  const diagnostics = [], fields = new Set(['label', 'hint', 'title', 'description', 'message', 'placeholder', 'emptyText']);
  let value;
  try { value = JSON.parse(source); }
  catch { return [{ file, line: 1, kind: 'json', message: 'Runtime JSON is invalid' }]; }
  function walk(node, field) {
    if (typeof node === 'string' && fields.has(field) && HAN.test(node) && !catalog.has(node)) diagnostics.push({ file, line: source.slice(0, source.indexOf(JSON.stringify(node))).split('\n').length, kind: 'missing-translation', source: node, message: 'Built-in display data needs an English translation' });
    else if (node && typeof node === 'object') for (const [key, child] of Object.entries(node)) walk(child, key);
  }
  walk(value, ''); return diagnostics;
}
function auditHtml({ file, source, catalog, exclusions = [] }) {
  const diagnostics = [], stack = [];
  const tokens = /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<[^>]+>|[^<]+/gi;
  function check(value, offset, declared) {
    const text = normalized(value);
    if (technical(text) || text === '卓控台') return;
    const kind = declared && catalog.has(declared) && declared === text ? null : 'unlocalized-markup';
    if (!kind) return;
    const id = identity(file, kind, text);
    if (exclusions.some(item => item.file === file && item.id === id && item.reason?.length >= 12)) return;
    diagnostics.push({ file, line: source.slice(0, offset).split('\n').length, kind, id, source: text, message: 'HTML copy requires a declared data-i18n key with an English translation' });
  }
  for (const token of source.matchAll(tokens)) {
    const text = token[0];
    if (text.startsWith('<!--') || /^<(?:script|style)\b/i.test(text) || /^<!/.test(text)) continue;
    if (/^<\//.test(text)) { stack.pop(); continue; }
    if (text.startsWith('<')) {
      const tag = /^<([\w-]+)/.exec(text)?.[1]; if (!tag) continue;
      const attributes = Object.fromEntries([...text.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map(match => [match[1], match[3]]));
      for (const name of ['aria-label', 'title', 'alt', 'placeholder']) if (attributes[name]) check(attributes[name], token.index, attributes['data-i18n-label']);
      if (!/\/\s*>$/.test(text) && !['meta', 'link', 'input', 'img', 'br', 'hr'].includes(tag)) stack.push(attributes['data-i18n']);
    } else check(text, token.index, stack.at(-1));
  }
  return diagnostics;
}
function auditProject(root) {
  const exclusionFile = path.join(root, 'scripts/i18n-exclusions.json');
  const exclusions = fs.existsSync(exclusionFile) ? JSON.parse(fs.readFileSync(exclusionFile, 'utf8')) : [];
  const loaded = loadCatalog(path.join(root, 'electron/locales'), exclusions);
  const diagnostics = [...loaded.diagnostics], messages = new Set(), files = runtimeFiles(root);
  for (const file of files) {
    const result = auditSource({ file, source: fs.readFileSync(path.join(root, file), 'utf8'), catalog: loaded.catalog, exclusions });
    diagnostics.push(...result.diagnostics); for (const message of result.messages) messages.add(message);
  }
  const markup = ['index.html', 'log-analyzer.html', 'electron/startup/scene.html'];
  for (const file of markup) if (fs.existsSync(path.join(root, file))) diagnostics.push(...auditHtml({ file, source: fs.readFileSync(path.join(root, file), 'utf8'), catalog: loaded.catalog, exclusions }));
  for (const directory of ['src/data', 'electron/assets', 'electron/lib']) {
    if (!fs.existsSync(path.join(root, directory))) continue;
    for (const name of fs.readdirSync(path.join(root, directory)).filter(name => name.endsWith('.json'))) {
      const file = directory + '/' + name;
      diagnostics.push(...auditJson({ file, source: fs.readFileSync(path.join(root, file), 'utf8'), catalog: loaded.catalog }));
    }
  }
  return { ok: !diagnostics.length, files: files.length, messages: messages.size, catalogEntries: loaded.catalog.size, diagnostics };
}
module.exports = { auditSource, auditProject, auditHtml, auditJson, loadCatalog, identity, placeholders };
