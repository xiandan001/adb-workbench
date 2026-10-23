const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  auditSource,
  extractNativeHandlers,
  extractRendererCalls,
  PINNED_COMMIT,
} = require('../scripts/ai-tools-native-audit.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ai-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, content) => {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  write('package.json', JSON.stringify({ version: '4.0.18' }));
  write('src-tauri/Cargo.toml', '[package]\nname = "cc-switch"\nversion = "4.0.18"\n');
  write('src-tauri/src/lib.rs', `
    #[tauri::command]
    fn update_tray_menu(app: tauri::AppHandle) -> Result<(), String> { Ok(()) }
    fn run() { builder.invoke_handler(tauri::generate_handler![commands::get_providers, update_tray_menu]); }
  `);
  write('src-tauri/src/commands/provider.rs', `
    #[tauri::command]
    pub async fn get_providers(state: State<'_, AppState>, app: String) -> Result<Vec<String>, String> { todo!() }
  `);
  write('src/App.tsx', `
    import { invoke } from '@tauri-apps/api/core';
    import { open } from '@tauri-apps/plugin-dialog';
    invoke<string[]>('get_providers', { app: 'claude' });
    open({ directory: true });
  `);
  return { root, write };
}

test('Rust inventory ignores comments and literals and records injected parameter types', () => {
  const lib = `
    // tauri::generate_handler![commands::fake]
    const RAW: &str = r##"tauri::generate_handler![commands::also_fake]"##;
    /* outer /* tauri::generate_handler![nested_fake] */ */
    builder.invoke_handler(tauri::generate_handler![commands::send, local]);
    #[tauri::command]
    fn local(app: tauri::AppHandle) -> bool { true }
  `;
  const defs = `
    #[tauri::command]
    pub async fn send<R: tauri::Runtime>(
      state: State<'_, AppState>,
      #[allow(non_snake_case)] onChunk: tauri::ipc::Channel<Vec<(String, u8)>>,
      value: Option<Vec<String>>,
    ) -> Result<(), String> { Ok(()) }
  `;
  const result = extractNativeHandlers(lib, [{ file: 'src-tauri/src/commands/send.rs', source: defs }]);
  assert.deepEqual(result.handlers.map((row) => row.name), ['send', 'local']);
  assert.equal(result.handlers[0].definition.async, true);
  assert.deepEqual(result.handlers[0].definition.parameters.map(({ name, injection }) => [name, injection]), [
    ['state', 'state'], ['onChunk', 'channel'], ['value', null],
  ]);
  assert.equal(result.handlers[0].definition.returnType, 'Result<(), String>');
  assert.deepEqual(result.unresolvedDefinitions, []);
});

test('renderer inventory resolves imported aliases and namespaces, not shadowed calls or comments', () => {
  const source = `
    import { invoke as call } from '@tauri-apps/api/core';
    import * as core from '@tauri-apps/api/core';
    // invoke('fake');
    const text = "call('also_fake')";
    call<string>('get_providers');
    core.invoke(\`update_tray_menu\`);
    function local(call: (x: string) => void) { call('shadowed'); }
    call(commandFromUser);
  `;
  const result = extractRendererCalls(source, 'src/test.ts');
  assert.deepEqual(result.invocations.map((row) => row.name), ['get_providers', 'update_tray_menu']);
  assert.equal(result.unresolvedInvocations.length, 1);
  assert.equal(result.unresolvedInvocations[0].file, 'src/test.ts');
});

test('audit is deterministic, source-only and never declares implementation or permission proof', (t) => {
  const { root, write } = fixture(t);
  write('src/ignored.test.ts', 'This is not valid TypeScript!');
  write('node_modules/unsafe.ts', 'This is not source!');
  const first = auditSource(root, { sourceCommit: PINNED_COMMIT });
  const second = auditSource(root, { sourceCommit: PINNED_COMMIT });
  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.source.commit, PINNED_COMMIT);
  assert.equal(first.counts.nativeHandlers, 2);
  assert.equal(first.counts.rendererCommands, 1);
  assert.equal(first.counts.rendererInvocations, 1);
  assert.equal(first.implementationVerified, false);
  assert.equal(first.permissionGrantsVerified, false);
  assert.equal(first.nativeHandlers[0].rendererReferences.length, 1);
  assert.ok(first.platformApis.some((row) => row.module === '@tauri-apps/plugin-dialog' && row.member === 'open'));
  assert.equal(first.nativeHandlers.find((row) => row.name === 'update_tray_menu').integration.kind, 'platform-equivalent-candidate');
  assert.deepEqual(first.gaps.rendererWithoutHandler, []);
  assert.deepEqual(first.gaps.unresolvedHandlerDefinitions, []);
  assert.match(first.source.fingerprint, /^sha256:[a-f0-9]{64}$/);
});

test('audit preserves missing native mappings, dynamic calls, and duplicate registrations as gaps', (t) => {
  const { root, write } = fixture(t);
  write('src-tauri/src/lib.rs', 'builder.invoke_handler(tauri::generate_handler![commands::missing, commands::missing]);');
  write('src/App.ts', "import { invoke } from '@tauri-apps/api/core'; invoke('unknown'); invoke(name);");
  const result = auditSource(root, { sourceCommit: PINNED_COMMIT });
  assert.deepEqual(result.gaps.duplicateNativeHandlers, ['missing']);
  assert.deepEqual(result.gaps.unresolvedHandlerDefinitions.map((row) => row.name), ['missing', 'missing']);
  assert.ok(result.gaps.rendererWithoutHandler.includes('unknown'));
  assert.equal(result.gaps.unresolvedInvokeCalls.length, 1);
});

test('syntax errors are audit failures, not silently missing capability entries', (t) => {
  const { root, write } = fixture(t);
  write('src/broken.ts', 'const broken = ;');
  assert.throws(() => auditSource(root, { sourceCommit: PINNED_COMMIT }), /src\/broken.ts/);
});

test('scope policy excludes authentication and host lifecycle but does not pretend quota is generic', (t) => {
  const { root, write } = fixture(t);
  write('src-tauri/src/lib.rs', 'builder.invoke_handler(tauri::generate_handler![commands::auth_start_login, commands::get_balance, commands::get_codex_oauth_quota]);');
  write('src-tauri/src/commands/quota.rs', `
    #[tauri::command] pub fn auth_start_login() {}
    #[tauri::command] pub fn get_balance() {}
    #[tauri::command] pub fn get_codex_oauth_quota() {}
  `);
  const result = auditSource(root, { sourceCommit: PINNED_COMMIT });
  const rows = new Map(result.nativeHandlers.map((row) => [row.name, row]));
  assert.equal(rows.get('auth_start_login').scope.disposition, 'excluded-login');
  assert.equal(rows.get('get_codex_oauth_quota').scope.disposition, 'unavailable-without-oauth');
  assert.equal(rows.get('get_balance').scope.disposition, 'credential-adapter-review');
  assert.equal(rows.get('get_balance').scope.requiresProviderSpecificCredential, true);
});

const reference = path.resolve(__dirname, '../.superpowers/references/cc-switch-upstream');
test('pinned upstream inventory covers 347 main commands plus 7 tray handlers and 332 renderer commands', {
  skip: !fs.existsSync(path.join(reference, 'src-tauri/src/lib.rs')),
}, () => {
  const result = auditSource(reference);
  assert.equal(result.source.commit, PINNED_COMMIT);
  assert.equal(result.source.packageVersion, '4.0.18');
  assert.equal(result.counts.nativeHandlers, 354);
  assert.equal(result.nativeHandlers.filter((row) => row.reference.startsWith('commands::')).length, 346);
  assert.equal(result.nativeHandlers.filter((row) => /^(?:tray|tray_panel)::/.test(row.reference)).length, 7);
  assert.equal(result.counts.rendererCommands, 332);
  assert.equal(result.counts.rendererInvocations, 342);
  assert.deepEqual(result.gaps.unresolvedHandlerDefinitions, []);
  assert.deepEqual(result.gaps.rendererWithoutHandler, []);
  assert.deepEqual(result.gaps.unresolvedInvokeCalls, []);
  assert.deepEqual(result.gaps.duplicateNativeHandlers, []);
});
