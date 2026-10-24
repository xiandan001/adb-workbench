const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const EAST_ASIAN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LETTER = /\p{L}/u;
const LOCALES = Object.freeze({ 'en-US': 'en', 'zh-TW': 'tw', 'ja-JP': 'ja', 'ko-KR': 'ko' });
const DOMAINS = Object.freeze(['core', 'workspace', 'tools', 'backend']);
const DISPLAY_LOCALES = new Set(['zh-CN', ...Object.keys(LOCALES)]);
const AUTONYMS = new Set(['简体中文', '繁體中文', 'English', '日本語', '한국어']);
const TARGET_SCRIPT = { 'ja-JP': /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u, 'ko-KR': /\p{Script=Hangul}/u };
const FIXED_BRANDS = new Map([['微信支付', 'WeChat Pay'], ['支付宝', 'Alipay']]);
const INLINE_CATALOG_FILES = new Set(['public/startup.js', 'electron/startup/particles.js']);
const VISIBLE_ATTRIBUTES = new Set(['title', 'placeholder', 'aria-label', 'aria-description', 'alt', 'label', 'emptyText', 'description', 'confirmLabel', 'cancelLabel', 'ariaLabel']);
const TECHNICAL_TERMS = new Set(['ADB', 'AI', 'API', 'APK', 'ASCII', 'Bash', 'CPU', 'Ctrl', 'DTR', 'FPS', 'GPU', 'HEX', 'IP', 'JSON', 'MCP', 'OEM', 'OTA', 'PATH', 'PID', 'PNG', 'RAM', 'RS232', 'RTS', 'SFTP', 'SSH', 'Skills', 'TOML', 'TX', 'RX', 'UTF-8', 'XML', 'YAML', 'scrcpy', 'Ctrl+Enter', 'Ctrl+K', 'Ctrl+C', 'Ctrl+V', 'Tab', 'Enter', 'Esc', 'Root', 'Remount', 'Loader', 'Unlock', 'Android', 'GitHub', 'OAuth', 'HTTPS', 'TLS', 'TCP', 'UDP', 'USB', 'Wi-Fi', 'Windows', 'Linux', 'macOS', 'WebDAV', 'Claude Code', 'Codex', 'Gemini CLI', 'OpenCode', 'OpenClaw', 'Hermes', 'Kimi Code', 'Grok Build', 'Antigravity', 'MCode', 'Pi', 'KB', 'MB', 'GB', 'KiB', 'MiB', 'GiB', 'ms', 'px', 'Hz', 'OK', 'N/A']);
const SKIP_FILES = new Set(['electron/api-keys.cjs', 'electron/lib/ai-keys.cjs']);
for (const indicator of ['MCP:', 'ANR ×', 'OOM ×']) TECHNICAL_TERMS.add(indicator);
const TRANSLATORS = new Set(['tr', 'trFor']);
const normalized = value => value.replace(/\s+/g, ' ').trim();
const identity = (file, kind, source) => crypto.createHash('sha256').update(JSON.stringify([file, kind, source])).digest('hex').slice(0, 24);
const placeholders = value => (value.match(/\{\d+\}/g) || []).sort().join(',');
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
  return !LETTER.test(text) || TECHNICAL_TERMS.has(text) || /^--[a-z][a-z0-9-]*$/.test(text) || /^\d+(?:\.\d+)?\s*(?:Mbps|ms|s|B|KiB|MiB|GiB|Hz|px|K|M|%)$/.test(text);
}
function reviewed(exemption, value, catalog) {
  return exemption && (exemption.kind === undefined || ['raw', 'machine', 'brand', 'catalog-source'].includes(exemption.kind))
    && typeof exemption.reason === 'string' && exemption.reason.trim().length >= 12
    && !(value.includes('卓控台') && exemption.kind !== 'machine')
    && (exemption.kind !== 'catalog-source' || catalog.has(value));
}
function literalObject(node) {
  if (node?.type === 'ObjectExpression') return node;
  if (node?.type === 'CallExpression' && node.callee?.object?.name === 'Object' && node.callee.property?.name === 'freeze'
    && node.arguments.length === 1 && node.arguments[0].type === 'ObjectExpression') return node.arguments[0];
  return null;
}
const propertyKey = property => !property.computed && property.type === 'ObjectProperty'
  ? property.key.type === 'StringLiteral' ? property.key.value : property.key.name : undefined;
function inlineCatalogValues({ file, ast, catalogs, diagnostics, messages }) {
  const accepted = new Set();
  if (!INLINE_CATALOG_FILES.has(file)) return accepted;
  const report = (node, locale, source, message) => diagnostics.push({ file, line: node.loc?.start.line || 1,
    column: (node.loc?.start.column || 0) + 1, kind: 'inline-catalog', locale, source, message });
  traverse(ast, { VariableDeclarator({ node }) {
    if (node.id.name !== 'messagesByLocale') return;
    const table = literalObject(node.init);
    if (!table) { report(node, undefined, undefined, 'Startup message tables must be static object literals'); return; }
    const locales = new Set();
    for (const localeProperty of table.properties) {
      const locale = propertyKey(localeProperty), entries = literalObject(localeProperty.value);
      if (!Object.hasOwn(LOCALES, locale) || locales.has(locale) || !entries) {
        report(localeProperty, locale, undefined, 'Startup message table locale must be supported, unique and a static object'); continue;
      }
      locales.add(locale); const keys = new Set();
      for (const property of entries.properties) {
        const key = propertyKey(property), value = property.value;
        if (typeof key !== 'string' || keys.has(key) || value?.type !== 'StringLiteral') {
          report(property, locale, key, 'Startup messages require unique source keys and literal text values'); continue;
        }
        keys.add(key); messages.add(key);
        const catalog = catalogs?.get(locale);
        if (!catalog?.has(key) || catalog.get(key) !== value.value) {
          report(value, locale, key, 'Startup message differs from the registered translation for this locale'); continue;
        }
        accepted.add(value);
      }
    }
  } });
  return accepted;
}
function auditSource({ file, source, catalog, catalogs, exclusions = [] }) {
  const diagnostics = [], messages = new Set(), usedExclusions = new Set();
  const allowed = new Map(exclusions.filter(item => item.file === file).map(item => [item.id, item]));
  let ast;
  try { ast = parser.parse(source, { sourceType: 'unambiguous', allowReturnOutsideFunction: true, plugins: ['jsx'] }); }
  catch (error) { return { diagnostics: [{ file, line: error.loc?.line || 1, kind: 'parse', message: error.message }], messages, usedExclusions }; }
  function report(node, kind, value, message) {
    const id = identity(file, kind, value), exemption = allowed.get(id);
    if (reviewed(exemption, value, catalog)) { usedExclusions.add(id); return; }
    diagnostics.push({ file, line: node.loc?.start.line || 1, column: (node.loc?.start.column || 0) + 1, kind, id, source: value, message });
  }
  const inlineValues = inlineCatalogValues({ file, ast, catalogs, diagnostics, messages });
  traverse(ast, {
    'StringLiteral|TemplateLiteral|JSXText'(p) {
      const node = p.node, value = sourceValue(node), parent = p.parent;
      if (!value.trim()) return;
      if (inlineValues.has(node)) return;
      if (translator(p)) {
        if (node.type === 'TemplateLiteral' && node.expressions.length) report(node, 'dynamic-key', value, 'Use a static message key and interpolation parameters');
        messages.add(value);
        if (!catalog.has(value)) report(node, 'missing-translation', value, 'No complete target-language catalog entry is registered for this message');
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
      if (EAST_ASIAN.test(value) || visibleEnglish) report(node, 'unlocalized-literal', value, 'Application text must use tr() or an exact reviewed non-UI exclusion');
      const localeMethod = parent?.type === 'CallExpression' && parent.callee?.type === 'MemberExpression'
        && /^toLocale(?:Date|Time)?String$/.test(parent.callee.property?.name);
      const intlFormatter = ['NewExpression', 'CallExpression'].includes(parent?.type) && parent.callee?.type === 'MemberExpression'
        && parent.callee.object?.name === 'Intl' && /^(?:DateTimeFormat|NumberFormat|RelativeTimeFormat|ListFormat|PluralRules|DisplayNames|Collator)$/.test(parent.callee.property?.name);
      if (DISPLAY_LOCALES.has(value) && parent.arguments?.[0] === node && (localeMethod || intlFormatter)) report(node, 'fixed-locale', value, 'Display formatting must use the selected locale');
    },
  });
  return { diagnostics, messages, usedExclusions };
}
function loadCatalog(directory, exclusions = []) {
  const catalogs = new Map(Object.keys(LOCALES).map(locale => [locale, new Map()])), diagnostics = [];
  for (const domain of DOMAINS) {
    const records = new Map(), keys = new Set();
    for (const [locale, prefix] of Object.entries(LOCALES)) {
      const name = `${prefix}-${domain}.json`, file = path.join(directory, name);
      const issue = (kind, message, extra = {}) => diagnostics.push({ file, locale, domain, line: 1, kind, message, ...extra });
      if (!fs.existsSync(file)) { issue('catalog', 'Required language catalog is missing'); continue; }
      let entries;
      try {
        const text = fs.readFileSync(file, 'utf8'); entries = JSON.parse(text);
        if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Language catalog must be a JSON object');
        const object = parser.parseExpression(text); const seen = new Set();
        for (const property of object.properties) {
          const key = propertyKey(property);
          if (typeof key !== 'string' || !key.trim() || seen.has(key)) throw new Error('Language catalog contains an empty or repeated source key');
          seen.add(key);
        }
      } catch (error) { issue('catalog', error.message); continue; }
      records.set(locale, { file, entries });
      for (const [key, value] of Object.entries(entries)) {
        keys.add(key);
        if (typeof value !== 'string' || !value.trim()) issue('empty-translation', 'Translation must be nonempty text', { source: key });
        else if (placeholders(key) !== placeholders(value)) issue('placeholders', 'Translation interpolation parameters do not match the source', { source: key });
        else if (locale === 'en-US' && EAST_ASIAN.test(value) && !(AUTONYMS.has(key) && key === value)) {
          const id = identity('electron/locales/' + name, 'catalog-sample', key + '\0' + value);
          if (!exclusions.some(item => item.file === 'electron/locales/' + name && item.id === id && item.kind === 'catalog-sample' && item.reason?.length >= 12)) {
            issue('untranslated-catalog', 'English translation still contains untranslated East Asian text', { id, source: key });
          }
        } else if (TARGET_SCRIPT[locale] && !TARGET_SCRIPT[locale].test(value)
          && /[\p{L}]/u.test(value) && !technical(value) && key !== '卓控台'
          && !(AUTONYMS.has(key) && key === value) && FIXED_BRANDS.get(key) !== value) {
          issue('untranslated-catalog', 'Ordinary application copy must contain the target language, not an English or source-language fallback', { source: key });
        }
        // The runtime resolves duplicate domain keys in this same priority order.
        if (!catalogs.get(locale).has(key)) catalogs.get(locale).set(key, value);
      }
    }
    for (const [locale, { file, entries }] of records) for (const key of keys) {
      if (!Object.hasOwn(entries, key)) diagnostics.push({ file, locale, domain, line: 1, kind: 'missing-translation', source: key,
        message: 'This domain key is missing for this locale; fallback to another locale or domain is not accepted' });
    }
  }
  return { catalog: catalogs.get('en-US'), catalogs, diagnostics };
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
    if (typeof node === 'string' && fields.has(field) && !technical(node) && !catalog.has(node)) diagnostics.push({ file, line: source.slice(0, source.indexOf(JSON.stringify(node))).split('\n').length, kind: 'missing-translation', source: node, message: 'Built-in display data needs complete target-language translations' });
    else if (node && typeof node === 'object') for (const [key, child] of Object.entries(node)) walk(child, key);
  }
  walk(value, ''); return diagnostics;
}
function auditHtml({ file, source, catalog, exclusions = [] }) {
  const diagnostics = [], stack = [];
  const tokens = /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<[^>]+>|[^<]+/gi;
  function check(value, offset, declared) {
    const text = normalized(value);
    if (technical(text)) return;
    const kind = declared && catalog.has(declared) && declared === text ? null : 'unlocalized-markup';
    if (!kind) return;
    const id = identity(file, kind, text);
    if (exclusions.some(item => item.file === file && item.id === id && reviewed(item, text, catalog))) return;
    diagnostics.push({ file, line: source.slice(0, offset).split('\n').length, kind, id, source: text, message: 'HTML copy requires a declared data-i18n key with complete target-language translations' });
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
    const result = auditSource({ file, source: fs.readFileSync(path.join(root, file), 'utf8'), catalog: loaded.catalog, catalogs: loaded.catalogs, exclusions });
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
  return { ok: !diagnostics.length, files: files.length, messages: messages.size, catalogEntries: loaded.catalog.size,
    sourceLocale: 'zh-CN', catalogEntriesByLocale: Object.fromEntries([...loaded.catalogs].map(([locale, entries]) => [locale, entries.size])), diagnostics };
}
module.exports = { auditSource, auditProject, auditHtml, auditJson, loadCatalog, identity, placeholders, LOCALES, DOMAINS };
