import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { defaultLogViewPreferences, logViewFor, normalizeLogViewPreferences, updateLogView } from '../src/shared/logViewPreferences.js';
import { shouldExitLogFocus } from '../src/shared/logFocus.js';
const require = createRequire(import.meta.url), backend = require('../electron/lib/log-view-preferences.cjs');

test('focus metadata is optional, portable and independent of the saved auxiliary layout', () => {
  let value = updateLogView(defaultLogViewPreferences(), 'A', 'realtime', { sidebarOpen: true, infoExpanded: true, usageExpanded: true, aiPanelHeight: 600 });
  const original = logViewFor(value, 'A', 'realtime'); assert.equal(original.focusMode, false);
  value = updateLogView(value, 'A', 'realtime', { focusMode: true });
  assert.deepEqual(backend.normalizeLogViewPreferences(value), normalizeLogViewPreferences(value));
  assert.deepEqual(logViewFor(value, 'A', 'realtime'), { ...original, focusMode: true });
  assert.equal(logViewFor(value, 'B', 'realtime').focusMode, false);
  const legacy = structuredClone(value); delete legacy.views[0].focusMode;
  assert.equal(normalizeLogViewPreferences(legacy).views[0].focusMode, false);
  const invalid = structuredClone(value); invalid.views[0].focusMode = 'yes'; assert.throws(() => normalizeLogViewPreferences(invalid));
});
test('Escape exits focus only when the document has no active modal, menu or text edit', () => {
  const plain = { key: 'Escape', target: { closest: () => null } }, document = { querySelector: () => null };
  assert.equal(shouldExitLogFocus(plain, document), true);
  assert.equal(shouldExitLogFocus({ ...plain, defaultPrevented: true }, document), false);
  assert.equal(shouldExitLogFocus({ ...plain, isComposing: true }, document), false);
  assert.equal(shouldExitLogFocus(plain, { querySelector: () => ({}) }), false);
  assert.equal(shouldExitLogFocus({ ...plain, target: { closest: () => ({}) } }, document), false);
  assert.equal(shouldExitLogFocus({ ...plain, key: 'Enter' }, document), false);
});
