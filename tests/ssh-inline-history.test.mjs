import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptSshHistoryResult } from '../src/shared/sshInlineHistory.js';
import { inlinePlacement } from '../src/shared/sshInlineCompletion.js';

test('cancelled history clear preserves complete prior history and pause state', () => {
  const previous = { entries: [{ id: 'one', command: 'git status' }], paused: true, persistent: true };
  assert.equal(acceptSshHistoryResult(previous, { success: true, cancelled: true }), previous);
  assert.equal(previous.entries[0].command, 'git status');
  const confirmed = { success: true, entries: [], paused: true, persistent: true };
  assert.equal(acceptSshHistoryResult(previous, confirmed), confirmed);
});

test('history button anchored popover fits viewport at narrow and bottom edges', () => {
  const result = inlinePlacement({ x: 760, y: 540, lineHeight: 24, width: 520, height: 260, viewportWidth: 900, viewportHeight: 600 });
  assert.equal(result.left, 372); assert.equal(result.top, 280);
  const narrow = inlinePlacement({ x: 20, y: 10, lineHeight: 24, width: 520, height: 260, viewportWidth: 300, viewportHeight: 180 });
  assert.equal(narrow.width, 284); assert.equal(narrow.maxHeight, 164);
  assert.ok(narrow.left >= 8 && narrow.left + narrow.width <= 292);
  assert.ok(narrow.top >= 8 && narrow.top + narrow.maxHeight <= 172);
});
