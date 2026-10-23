import test from 'node:test';
import assert from 'node:assert/strict';
import { createSkillsRequestGate, executeSkillMutation, skillActionEnabled, skillApplyRequest, skillChangeSummary, skillInstallation } from '../src/components/ai-tools/aiSkillsModel.js';

const preview = () => ({ token: 'fixture-token', expiresAt: 1000, operation: 'install', targetPath: 'C:\\fixture\\skills\\sample', toolId: 'claude', skillId: 'fixture-id', changes: [{ path: 'SKILL.md', action: 'add', bytes: 100 }] });
test('skills apply uses only the one-use token, never target paths or file content supplied by the renderer', () => {
  assert.deepEqual(skillApplyRequest(preview(), 1), { command: 'skills_apply', args: { token: 'fixture-token' }, options: { restoring: false } });
  assert.throws(() => skillApplyRequest(preview(), 1000), /过期/);
  assert.throws(() => skillApplyRequest({ ...preview(), token: '' }, 1), /预览/);
});
test('restoration is explicitly routed through the expired-membership recovery exception', () => {
  const request = skillApplyRequest({ ...preview(), operation: 'restore' }, 1);
  assert.equal(request.options.restoring, true);
  const can = (command, options) => command === 'skills_apply' && options.restoring;
  assert.equal(skillActionEnabled(can, 'skills_apply', { recoveryOnly: true, restoring: true }), true);
  assert.equal(skillActionEnabled(() => true, 'skills_import', { recoveryOnly: true }), false);
  assert.equal(skillActionEnabled(() => true, 'skills_remove', { recoveryOnly: true }), false);
});
test('previews summarize every change but bound displayed rows', () => {
  const changes = Array.from({ length: 500 }, (_, i) => ({ path: `${i}.txt`, action: i % 2 ? 'add' : 'remove', bytes: 1 }));
  const result = skillChangeSummary({ changes });
  assert.equal(result.total, 500); assert.equal(result.add, 250); assert.equal(result.remove, 250); assert.equal(result.shown.length, 100); assert.equal(result.hidden, 400);
});
test('installation metadata is tool-scoped and never treated as execution permission', () => {
  const skill = { installations: [{ toolId: 'claude', currentLibraryVersion: false }] };
  assert.equal(skillInstallation(skill, 'claude').currentLibraryVersion, false);
  assert.equal(skillInstallation(skill, 'codex'), null);
});
test('one in-flight request and hidden/remounted workspaces cannot apply late results', () => {
  const gate = createSkillsRequestGate(); const first = gate.start(); assert.ok(first); assert.equal(gate.start(), null);
  gate.setActive(false); assert.equal(gate.current(first), false); assert.equal(gate.start(), null);
  gate.setActive(true); const second = gate.start(); assert.ok(second); assert.equal(gate.finish(first), false);
  assert.equal(gate.current(second), true); assert.equal(gate.finish(second), true); assert.ok(gate.start());
});

test('a successful filesystem action is not reported as failed merely because its follow-up list refresh fails', async () => {
  const outcome = await executeSkillMutation(async () => ({ operation: 'install', backupId: 'fixture' }), 'skills_apply', { token: 'test' }, {}, async () => { throw new Error('refresh denied'); });
  assert.equal(outcome.result.operation, 'install'); assert.equal(outcome.data, null); assert.equal(outcome.refreshError, 'refresh denied');
  let reads = 0;
  const cancelled = await executeSkillMutation(async () => ({ cancelled: true }), 'skills_import', {}, {}, async () => { reads++; });
  assert.equal(cancelled.result.cancelled, true); assert.equal(reads, 0);
  await assert.rejects(executeSkillMutation(async () => { throw new Error('apply failed'); }, 'skills_apply', {}, {}, async () => { reads++; }), /apply failed/);
  assert.equal(reads, 0);
});
