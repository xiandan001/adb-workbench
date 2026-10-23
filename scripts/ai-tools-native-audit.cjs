#!/usr/bin/env node
// Source inventory only: no upstream code is loaded or executed, and no user CLI files are read.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const PINNED_COMMIT = 'e4873bc8aa2555225d4867ec2f04b1290f1d21d9';
const DEFAULT_SOURCE = path.resolve(__dirname, '../.superpowers/references/cc-switch-upstream');
const LIB_FILE = 'src-tauri/src/lib.rs';
const PLATFORM_COMMANDS = {
  update_tray_menu: 'host tray lifecycle',
  set_window_theme: 'host theme',
  pick_directory: 'owner-scoped Electron directory dialog',
  open_external: 'validated Electron shell.openExternal',
  copy_text_to_clipboard: 'owner-scoped Electron clipboard',
  save_file_dialog: 'owner-scoped Electron save dialog',
  open_file_dialog: 'owner-scoped Electron file dialog',
  open_zip_file_dialog: 'owner-scoped Electron archive dialog',
  take_tray_navigation: 'host tray navigation',
  tray_panel_state: 'host tray state',
  tray_panel_placement: 'host tray placement',
  tray_panel_layout: 'host tray layout',
  tray_panel_hide: 'host tray lifecycle',
  tray_panel_action: 'host tray actions',
  tray_app_page_seen: 'host tray navigation',
  reveal_session_path: 'validated Electron shell.showItemInFolder',
  export_session_markdown: 'owner-scoped save dialog and bounded export',
  open_config_folder: 'validated Electron shell.openPath',
  open_app_config_folder: 'validated Electron shell.openPath',
  open_workspace_directory: 'validated Electron shell.openPath',
  enter_lightweight_mode: 'host lifecycle; do not destroy the host window',
  exit_lightweight_mode: 'host lifecycle',
  is_lightweight_mode: 'host lifecycle',
};
const PLATFORM_MODULES = {
  '@tauri-apps/api/core': 'owner-scoped typed Electron IPC; explicit streaming and binary adapters',
  '@tauri-apps/api/event': 'owner-scoped subscriptions with cleanup',
  '@tauri-apps/api/app': 'host application metadata',
  '@tauri-apps/api/window': 'host window and focus lifecycle',
  '@tauri-apps/api/path': 'main-process validated paths; never renderer filesystem authority',
  '@tauri-apps/plugin-dialog': 'owner-scoped Electron native dialogs',
  '@tauri-apps/plugin-process': 'host-controlled lifecycle; no embedded-core restart',
  '@tauri-apps/plugin-updater': 'excluded upstream updater; use existing host OTA',
  '@tauri-apps/plugin-opener': 'validated Electron shell APIs',
};

const lineAt = (source, offset) => source.slice(0, offset).split('\n').length;
const slash = (value) => value.split(path.sep).join('/');
const compact = (value) => value.trim().replace(/\s+/g, ' ');

// Mask Rust comments/literals without shifting offsets. Lifetimes such as '_ remain code.
function maskRust(source) {
  const output = source.split('');
  const mask = (start, end) => {
    for (let i = start; i < end; i += 1) if (source[i] !== '\n') output[i] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const start = i;
    if (source.startsWith('//', i)) {
      i = source.indexOf('\n', i);
      if (i < 0) i = source.length;
    } else if (source.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < source.length && depth) {
        if (source.startsWith('/*', i)) { depth += 1; i += 2; }
        else if (source.startsWith('*/', i)) { depth -= 1; i += 2; }
        else i += 1;
      }
      if (depth) throw new Error('Unterminated Rust block comment');
    } else {
      const raw = /^(?:br|r)(#*)"/.exec(source.slice(i));
      const character = /^'(?:\\(?:u\{[\da-fA-F]+\}|x[\da-fA-F]{2}|.)|[^'\\\r\n])'/u.exec(source.slice(i));
      if (raw) {
        const close = `"${raw[1]}`;
        const end = source.indexOf(close, i + raw[0].length);
        if (end < 0) throw new Error('Unterminated Rust raw string');
        i = end + close.length;
      } else if (source[i] === '"') {
        i += 1;
        while (i < source.length && source[i] !== '"') i += source[i] === '\\' ? 2 : 1;
        if (i >= source.length) throw new Error('Unterminated Rust string');
        i += 1;
      } else if (character) i += character[0].length;
      else { i += 1; continue; }
    }
    mask(start, i);
  }
  return output.join('');
}

function matchingEnd(source, start, open, close) {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === open) depth += 1;
    else if (source[i] === close && --depth === 0) return i;
  }
  throw new Error(`Unbalanced ${open}${close} in source inventory`);
}

function parametersOf(source) {
  const masked = maskRust(source);
  const parts = [];
  let start = 0;
  const stack = [];
  for (let i = 0; i <= masked.length; i += 1) {
    const c = masked[i];
    if (c && '(<[{'.includes(c)) stack.push(c);
    else if (c && ')>]}'.includes(c) && !(c === '>' && masked[i - 1] === '-')) stack.pop();
    if ((c === ',' && !stack.length) || i === masked.length) {
      const part = source.slice(start, i).trim();
      if (part) parts.push(part);
      start = i + 1;
    }
  }
  return parts.map((part) => {
    while (part.startsWith('#[')) part = part.slice(matchingEnd(maskRust(part), 1, '[', ']') + 1).trim();
    const colon = part.indexOf(':');
    const name = compact(colon < 0 ? part : part.slice(0, colon)).replace(/^mut /, '');
    const type = compact(colon < 0 ? '' : part.slice(colon + 1));
    const injection = /\bState\s*</.test(type) ? 'state'
      : /\bAppHandle\b/.test(type) ? 'appHandle'
        : /\b(?:Window|WebviewWindow)\b/.test(type) ? 'window'
          : /\bChannel\s*</.test(type) ? 'channel' : null;
    return { name, type, injection };
  });
}

function definitionsIn(source, file) {
  const masked = maskRust(source);
  const definitions = [];
  const expression = /\b(?:pub(?:\([^)]*\))?\s+)?(async\s+)?fn\s+(\w+)\s*(?:<[^{};]*?>\s*)?\(/g;
  for (const match of masked.matchAll(expression)) {
    const open = match.index + match[0].lastIndexOf('(');
    const close = matchingEnd(masked, open, '(', ')');
    const body = masked.indexOf('{', close);
    if (body < 0) continue;
    const result = source.slice(close + 1, body).trim();
    definitions.push({
      name: match[2], file, line: lineAt(source, match.index), async: Boolean(match[1]),
      parameters: parametersOf(source.slice(open + 1, close)),
      returnType: result.startsWith('->') ? compact(result.slice(2)) : '()',
    });
  }
  return definitions;
}

function extractNativeHandlers(libSource, definitionFiles) {
  const masked = maskRust(libSource);
  const handlers = [];
  const definitionRows = [
    ...definitionsIn(libSource, LIB_FILE),
    ...definitionFiles.flatMap(({ source, file }) => definitionsIn(source, file)),
  ];
  const definitions = new Map();
  for (const row of definitionRows) {
    const existing = definitions.get(row.name) || [];
    existing.push(row);
    definitions.set(row.name, existing);
  }
  const expression = /\.invoke_handler\s*\(\s*tauri\s*::\s*generate_handler\s*!\s*\[/g;
  for (const match of masked.matchAll(expression)) {
    const start = match.index + match[0].lastIndexOf('[');
    const end = matchingEnd(masked, start, '[', ']');
    const content = masked.slice(start + 1, end);
    let offset = 0;
    for (const part of content.split(',')) {
      const reference = part.trim().replace(/\s*::\s*/g, '::');
      if (reference) {
        if (!/^(?:\w+::)*\w+$/.test(reference)) throw new Error(`Unsupported native registration: ${reference}`);
        const name = reference.split('::').at(-1);
        const candidates = (definitions.get(name) || []).filter((row) => reference.includes('::') || row.file === LIB_FILE);
        handlers.push({
          name, reference,
          registration: { file: LIB_FILE, line: lineAt(libSource, start + 1 + offset + part.search(/\S/)) },
          definition: candidates.length === 1 ? candidates[0] : null,
          definitionCandidates: candidates.length === 1 ? undefined : candidates.map(({ file, line }) => ({ file, line })),
        });
      }
      offset += part.length + 1;
    }
  }
  if (!handlers.length) throw new Error('No native invoke_handler registration found');
  return {
    handlers,
    unresolvedDefinitions: handlers.filter((row) => !row.definition).map(({ name, definitionCandidates }) => ({ name, candidates: definitionCandidates })),
  };
}

function importedCallee(callPath) {
  const callee = callPath.node.callee;
  const namespace = callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression';
  const local = namespace ? callee.object : callee;
  if (local.type !== 'Identifier') return null;
  const binding = callPath.scope.getBinding(local.name);
  if (!binding || !binding.path.parentPath.isImportDeclaration()) return null;
  const declaration = binding.path.parentPath.node;
  if (!declaration.source.value.startsWith('@tauri-apps/')) return null;
  if (namespace) {
    if (!binding.path.isImportNamespaceSpecifier()) return null;
    const member = callee.computed ? callee.property.value : callee.property.name;
    return { module: declaration.source.value, member };
  }
  if (!binding.path.isImportSpecifier()) return null;
  return { module: declaration.source.value, member: binding.path.node.imported.name || binding.path.node.imported.value };
}

function literalString(node) {
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && !node.expressions.length) return node.quasis[0].value.cooked;
  return null;
}

function extractRendererCalls(source, file) {
  let ast;
  try { ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] }); }
  catch (error) { throw new Error(`Cannot audit ${file}: ${error.message}`); }
  const invocations = [];
  const unresolvedInvocations = [];
  const platformApis = [];
  const events = [];
  const visitCall = (callPath) => {
    const imported = importedCallee(callPath);
    if (!imported) return;
    const location = { file, line: callPath.node.loc.start.line };
    if (imported.module === '@tauri-apps/api/core' && imported.member === 'invoke') {
      const name = literalString(callPath.node.arguments[0]);
      if (name === null) unresolvedInvocations.push(location);
      else invocations.push({ name, ...location });
    }
    if (imported.module === '@tauri-apps/api/event' && ['listen', 'once', 'emit'].includes(imported.member)) {
      events.push({ name: literalString(callPath.node.arguments[0]), operation: imported.member, ...location });
    }
  };
  traverse(ast, {
    ImportDeclaration(importPath) {
      const { node } = importPath;
      if (!node.source.value.startsWith('@tauri-apps/')) return;
      for (const specifier of node.specifiers) {
        platformApis.push({
          module: node.source.value,
          member: specifier.type === 'ImportSpecifier' ? specifier.imported.name || specifier.imported.value : specifier.type === 'ImportNamespaceSpecifier' ? '*' : 'default',
          typeOnly: node.importKind === 'type' || specifier.importKind === 'type',
          file, line: specifier.loc.start.line,
        });
      }
    },
    CallExpression: visitCall,
    OptionalCallExpression: visitCall,
  });
  return { invocations, unresolvedInvocations, platformApis, events };
}

function scopeFor(name, domain) {
  if (name.startsWith('auth_') || (domain === 'copilot' && !/_(?:usage|models)/.test(name))) {
    return { disposition: 'excluded-login', reason: 'No integrated account login or managed-account entrypoints requested.' };
  }
  if (['codex_oauth', 'xai_oauth', 'agy_account', 'copilot'].includes(domain) || /(?:codex|xai)_oauth/.test(name)) {
    return { disposition: 'unavailable-without-oauth', reason: 'Account-backed adapter must not import existing CLI login or claim API-key support.' };
  }
  if (['get_subscription_quota', 'get_coding_plan_quota', 'get_balance', 'query_usage', 'test_usage_script'].includes(name)) {
    return { disposition: 'credential-adapter-review', requiresProviderSpecificCredential: true, reason: 'Only explicitly supported API-key/credential adapters; account-only paths remain unavailable.' };
  }
  return { disposition: 'implementation-review', reason: 'Inventory is not implementation, permission, or test evidence.' };
}

function walkSource(root, directory, accept) {
  const found = [];
  const visit = (relative) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const next = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Source symlink not permitted: ${next}`);
      if (entry.isDirectory()) {
        if (!['node_modules', 'target', 'dist', '__tests__', '.git'].includes(entry.name)) visit(next);
      } else if (entry.isFile() && accept(next)) found.push(next);
    }
  };
  visit(directory);
  return found;
}

function auditSource(sourceRoot, { sourceCommit } = {}) {
  const root = fs.realpathSync(sourceRoot);
  const hash = crypto.createHash('sha256');
  const read = (file) => {
    const absolute = path.join(root, file);
    const actual = fs.realpathSync(absolute);
    const relative = path.relative(root, actual);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error(`Source escapes root: ${file}`);
    const data = fs.readFileSync(absolute);
    hash.update(`${file}\0`).update(data).update('\0');
    return data.toString('utf8');
  };
  const packageVersion = JSON.parse(read('package.json')).version;
  const cargo = read('src-tauri/Cargo.toml');
  const cargoPackage = /\[package\]([\s\S]*?)(?=\n\[|$)/.exec(cargo)?.[1] || '';
  const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargoPackage)?.[1] || null;
  const commit = sourceCommit ?? execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid audited source commit');
  const lib = read(LIB_FILE);
  const definitionPaths = walkSource(root, 'src-tauri/src/commands', (file) => file.endsWith('.rs'));
  for (const file of ['src-tauri/src/tray.rs', 'src-tauri/src/tray_panel.rs']) {
    if (fs.existsSync(path.join(root, file))) definitionPaths.push(file);
  }
  const definitionFiles = definitionPaths.map((file) => ({ file, source: read(file) }));
  const native = extractNativeHandlers(lib, definitionFiles);
  const frontendFiles = walkSource(root, 'src', (file) => /\.[jt]sx?$/.test(file) && !/\.(?:test|spec)\.[jt]sx?$/.test(file));
  const frontend = frontendFiles.map((file) => extractRendererCalls(read(file), file));
  const invocations = frontend.flatMap((row) => row.invocations);
  const allNames = new Set(native.handlers.map((row) => row.name));
  const rendererCommands = [...new Set(invocations.map((row) => row.name))].sort().map((name) => ({
    name, registered: allNames.has(name),
    references: invocations.filter((row) => row.name === name).map(({ file, line }) => ({ file, line })),
  }));
  const rendererByName = new Map(rendererCommands.map((row) => [row.name, row.references]));
  const nativeHandlers = native.handlers.map((entry) => {
    const row = { ...entry }; delete row.definitionCandidates;
    const domain = row.definition ? path.posix.basename(row.definition.file, '.rs') : 'unresolved';
    return {
      ...row, domain, rendererReferences: rendererByName.get(row.name) || [],
      integration: { kind: PLATFORM_COMMANDS[row.name] ? 'platform-equivalent-candidate' : 'node-port-required', candidate: PLATFORM_COMMANDS[row.name] || null, reviewed: false },
      scope: scopeFor(row.name, domain),
    };
  });
  const imports = frontend.flatMap((row) => row.platformApis);
  const platformApis = [...new Set(imports.map((row) => `${row.module}\0${row.member}\0${row.typeOnly}`))].sort().map((key) => {
    const [module, member, typeOnly] = key.split('\0');
    return {
      module, member, typeOnly: typeOnly === 'true', reviewed: false,
      candidate: PLATFORM_MODULES[module] || 'explicit host adapter review required',
      references: imports.filter((row) => row.module === module && row.member === member && String(row.typeOnly) === typeOnly).map(({ file, line }) => ({ file, line })),
    };
  });
  const events = frontend.flatMap((row) => row.events);
  return {
    schemaVersion: 1,
    auditVersion: '1.0.0',
    implementationVerified: false,
    permissionGrantsVerified: false,
    source: { repository: 'https://github.com/farion1231/cc-switch', commit, pinnedCommit: PINNED_COMMIT, matchesPinnedCommit: commit === PINNED_COMMIT, packageVersion, cargoVersion, fingerprint: `sha256:${hash.digest('hex')}` },
    counts: { nativeHandlers: nativeHandlers.length, rendererCommands: rendererCommands.length, rendererInvocations: invocations.length, rendererFiles: frontendFiles.length, platformImports: platformApis.length, eventTopics: new Set(events.filter((row) => row.name !== null).map((row) => row.name)).size },
    scopePolicy: { accountLogin: 'excluded', purchaseEntrypoints: 'excluded', featureEntitlement: 'existing-host-vip', upstreamUpdater: 'excluded-use-host-ota', quota: 'provider-specific-api-key-adapters-only; never import CLI OAuth credentials', appliedToSource: false },
    nativeHandlers,
    rendererCommands,
    platformApis,
    events,
    limitations: { eventCoverage: 'Direct imported Tauri calls only; wrapper/imported-constant event topics require separate review.', unresolvedEventTopics: events.filter((row) => row.name === null) },
    gaps: {
      unresolvedHandlerDefinitions: native.unresolvedDefinitions,
      duplicateNativeHandlers: [...allNames].filter((name) => nativeHandlers.filter((row) => row.name === name).length > 1),
      rendererWithoutHandler: rendererCommands.filter((row) => !row.registered).map((row) => row.name),
      unresolvedInvokeCalls: frontend.flatMap((row) => row.unresolvedInvocations),
    },
  };
}

function runCli(args) {
  let source = DEFAULT_SOURCE;
  let output;
  let summary = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--source' && args[i + 1]) source = path.resolve(args[++i]);
    else if (args[i] === '--output' && args[i + 1]) output = path.resolve(args[++i]);
    else if (args[i] === '--summary') summary = true;
    else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  const manifest = auditSource(source);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, serialized, { encoding: 'utf8' });
  }
  process.stdout.write(summary ? `${JSON.stringify({ source: manifest.source, counts: manifest.counts, gaps: manifest.gaps, output: output ? slash(output) : null }, null, 2)}\n` : serialized);
  if (!manifest.source.matchesPinnedCommit || Object.values(manifest.gaps).some((rows) => rows.length)) process.exitCode = 1;
}

if (require.main === module) {
  try { runCli(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { auditSource, extractNativeHandlers, extractRendererCalls, PINNED_COMMIT };
