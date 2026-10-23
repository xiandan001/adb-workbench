import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpDraft, mcpInput, promptInput } from '../src/components/ai-tools/aiResourcesModel.js';
import { aiToolsCan } from '../src/components/ai-tools/aiToolsModel.js';

test('MCP editing never copies masked values or application bookkeeping into a save', () => {
  const original = { id: 'one', name: 'Local', description: '', type: 'stdio', command: 'node', args: ['server.js'], key: 'awb_one', envKeys: ['TOKEN'], hasSecrets: true, applications: ['claude'] };
  const draft = mcpDraft(original); assert.equal(draft.secretText, '{}');
  const kept = mcpInput(draft, original);
  assert.deepEqual(kept, { id: 'one', name: 'Local', description: '', type: 'stdio', command: 'node', args: ['server.js'] });
  assert.equal(mcpInput({ ...draft, secretMode: 'clear' }, original).env, null);
  assert.deepEqual(mcpInput({ ...draft, secretMode: 'replace', secretText: '{"TOKEN":"user-entered"}' }, original).env, { TOKEN: 'user-entered' });
});
test('MCP remote origin changes require replacing or explicitly clearing old headers', () => {
  const original = { id: 'two', name: 'Remote', type: 'http', url: 'https://old.example/mcp', headerKeys: ['Authorization'] };
  const changed = { ...mcpDraft(original), url: 'https://new.example/mcp' };
  assert.throws(() => mcpInput(changed, original), /请求头/);
  assert.equal(mcpInput({ ...changed, secretMode: 'clear' }, original).headers, null);
  assert.equal(Object.hasOwn(mcpInput({ ...changed, secretMode: 'clear' }, original), 'command'), false);
});
test('resource JSON validation rejects code and reserved keys; prompt content remains plain LF text', () => {
  assert.throws(() => mcpInput({ ...mcpDraft(), name: 'x', command: 'node', argsText: 'not-json' }), /JSON/);
  assert.throws(() => mcpInput({ ...mcpDraft(), name: 'x', command: 'node', secretMode: 'replace', secretText: '{"__proto__":"no"}' }), /名称/);
  const prompt = promptInput({ name: 'Prompt', description: '', content: 'first\r\n<script>not executed</script>' });
  assert.equal(prompt.content, 'first\n<script>not executed</script>');
  assert.throws(() => promptInput({ name: 'Prompt', description: '', content: '<!-- adb-workbench:prompt:start -->' }), /保留标记/);
});
test('resource restore remains accessible after expiry without enabling ordinary resource writes', () => {
  const snapshot = { membership: { activated: false }, capabilities: ['resources_backups_list', 'resources_backup_preview_restore', 'resources_apply', 'resources_mcp_save'] };
  assert.equal(aiToolsCan(snapshot, 'resources_backups_list'), true);
  assert.equal(aiToolsCan(snapshot, 'resources_backup_preview_restore'), true);
  assert.equal(aiToolsCan(snapshot, 'resources_apply'), false);
  assert.equal(aiToolsCan(snapshot, 'resources_apply', { restoring: true }), true);
  assert.equal(aiToolsCan(snapshot, 'resources_mcp_save', { restoring: true }), false);
});
