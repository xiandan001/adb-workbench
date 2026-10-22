import test from 'node:test';
import assert from 'node:assert/strict';
import { inlineCandidates, inlineSuffix, advanceInlineInput, readInlinePrefix, inlineKey, inlinePlacement } from '../src/shared/sshInlineCompletion.js';

test('inline candidates are bounded safe exact-prefix matches with no execution characters', () => {
  const entries = ['git', 'git status', 'git status', 'git\nrm', 'git\x1b[A', 'git\u009b2J', ...Array.from({ length: 12 }, (_, i) => `git show ${i}`)].map(command => ({ command }));
  assert.equal(inlineCandidates(entries, 'git').length, 8);
  assert.equal(inlineCandidates(entries, 'git')[0].command, 'git status');
  assert.deepEqual(inlineCandidates(entries, ''), []);
  assert.equal(inlineSuffix('git', 'git status'), ' status');
  assert.equal(inlineSuffix('git', 'Git status'), null);
  assert.equal(inlineSuffix('git', 'git status\r'), null);
});

test('temporary input consistency supports plain tail typing but blocks complex editing until next prompt', () => {
  assert.equal(advanceInlineInput('', 'git'), 'git');
  assert.equal(advanceInlineInput('git', '\x7f'), 'gi');
  assert.equal(advanceInlineInput('git', '\x08'), 'gi');
  assert.equal(advanceInlineInput('git', '\x1b[A'), null);
  assert.equal(advanceInlineInput('git', '\x12'), null);
  assert.equal(advanceInlineInput('git', '\r'), null);
  assert.equal(advanceInlineInput(null, 'a'), null);
  assert.equal(advanceInlineInput('🙂', '\x7f'), null);
});

function fakeBuffer(lines, cursorX, cursorY = 0) {
  return { type: 'normal', baseY: 0, cursorX, cursorY, getLine: y => lines[y] && { isWrapped: y > 0, translateToString: (trim, start = 0, end) => { const text = lines[y].slice(start, end); return trim ? text.trimEnd() : text; } } };
}
const context = { active: true, focused: true, replaying: false, shell: { status: 'ready', phase: 'prompt', promptId: 7 }, boundary: { promptId: 7, row: 0, column: 2 }, expected: 'git', writer: { queuedBytes: 0, inFlight: false } };
test('prefix requires exact trusted prompt, echo agreement, line end, normal buffer and drained writes', () => {
  const buffer = fakeBuffer(['$ git'], 5);
  assert.equal(readInlinePrefix({ ...context, buffer }), 'git');
  for (const changed of [{ active: false }, { focused: false }, { replaying: true }, { expected: 'git s' }, { writer: { queuedBytes: 1 } }, { writer: { queuedBytes: 0, inFlight: true } }, { shell: { ...context.shell, promptId: 8 } }, { shell: { ...context.shell, phase: 'running' } }, { buffer: { ...buffer, type: 'alternate' } }, { buffer: fakeBuffer(['$ git suffix'], 5) }]) {
    assert.equal(readInlinePrefix({ ...context, buffer, ...changed }), null);
  }
  assert.equal(readInlinePrefix({ ...context, expected: 'git status', buffer: fakeBuffer(['$ git ', 'status'], 6, 1) }), 'git status');
});

test('popup consumes only navigation, suffix acceptance and escape; Enter remains native', () => {
  assert.deepEqual(inlineKey('ArrowDown', 1, 3), { action: 'select', index: 2, consume: true });
  assert.deepEqual(inlineKey('ArrowUp', 0, 3), { action: 'select', index: 2, consume: true });
  assert.equal(inlineKey('Tab', 0, 3).action, 'accept');
  assert.equal(inlineKey('Enter', 0, 3).consume, false);
  assert.equal(inlineKey('ArrowUp', 0, 0).consume, false);
  assert.equal(inlineKey('Tab', 0, 0).consume, false);
});

test('inline popup is clamped and flips above near bottom edge', () => {
  const result = inlinePlacement({ x: 870, y: 550, lineHeight: 16, width: 320, height: 200, viewportWidth: 900, viewportHeight: 600 });
  assert.equal(result.left, 572); assert.equal(result.top, 350);
  assert.ok(inlinePlacement({ x: 0, y: 0, lineHeight: 16, width: 320, height: 200, viewportWidth: 240, viewportHeight: 150 }).width <= 224);
});
