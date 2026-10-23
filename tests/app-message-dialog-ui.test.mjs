import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { confirmAppMessage, normalizeAppMessageOptions, resolveAppMessage, showAppMessage, subscribeAppMessages, trapAppMessageFocus } from '../src/shared/appMessageDialog.js';

test('renderer-local dialogs without a mounted host cancel and cannot authorize main actions', async () => {
  assert.equal(await confirmAppMessage({ message: 'Fixture discard' }), false);
  assert.deepEqual(await showAppMessage({ buttons: ['Unsafe', 'Cancel'], cancelId: 1 }), { response: 1, checkboxChecked: false });
});
test('local requests preserve indexes, unique IDs and checkbox state and reject invalid/replayed replies', async t => {
  const events = []; const unsubscribe = subscribeAppMessages(event => events.push(event)); t.after(unsubscribe);
  const one = showAppMessage({ title: 'First', buttons: ['Cancel', 'Continue'], cancelId: 0, defaultId: 0, checkboxLabel: 'Fixture remember' });
  const two = showAppMessage({ title: 'Second', buttons: ['Continue', 'Cancel'], cancelId: 1 });
  const first = events[0]; const second = events[1]; assert.notEqual(first.requestId, second.requestId); assert.match(first.requestId, /^local-dialog-/);
  assert.equal(resolveAppMessage(first.requestId, { response: 2, checkboxChecked: false }), false);
  assert.equal(resolveAppMessage(first.requestId, { response: 1, checkboxChecked: true }), true); assert.deepEqual(await one, { response: 1, checkboxChecked: true });
  assert.equal(resolveAppMessage(first.requestId, { response: 1, checkboxChecked: true }), false);
  assert.equal(resolveAppMessage(second.requestId, { response: 0, checkboxChecked: true }), false);
  unsubscribe(); assert.deepEqual(await two, { response: 1, checkboxChecked: false });
});
test('local confirm convenience API requires explicit choice, never a truthy object', async t => {
  let shown; const unsubscribe = subscribeAppMessages(event => { if (event.type === 'show') shown = event; }); t.after(unsubscribe);
  const confirmed = confirmAppMessage({ title: 'Discard?', confirmLabel: 'Discard' });
  assert.deepEqual(shown.options.buttons, ['取消', 'Discard']); assert.equal(shown.options.defaultId, 0);
  resolveAppMessage(shown.requestId, { response: 1, checkboxChecked: false }); assert.equal(await confirmed, true);
  const cancelled = confirmAppMessage({ title: 'Keep?' }); resolveAppMessage(shown.requestId, { response: 0, checkboxChecked: false }); assert.equal(await cancelled, false);
});
test('message DTO rejects invalid bounds and host uses modal focus, cancellation and selectable details', () => {
  for (const value of [{ buttons: [] }, { buttons: ['one'], cancelId: 2 }, { detail: '\0' }, { title: 'x'.repeat(241) }]) assert.throws(() => normalizeAppMessageOptions(value));
  const host = fs.readFileSync(new URL('../src/components/AppMessageDialogHost.jsx', import.meta.url), 'utf8');
  assert.match(host, /node\.showModal\(\)/); assert.match(host, /previous\.focus/); assert.match(host, /answer\(options\.cancelId\)/); assert.match(host, /select-text/);
  assert.match(host, /appMessageDialogReady/); assert.match(host, /appMessageDialogUnready/); assert.match(host, /appMessageDialogReply/);
  assert.match(host, /onKeyDown=\{trapAppMessageFocus\}/);
  assert.doesNotMatch(host, /\$\{theme\.card\}/);
  assert.match(host, /bg-\[#202124\]/);
  assert.match(host, /open:flex open:flex-col/); assert.match(host, /min-h-0 flex-1 select-text overflow-y-auto/); assert.match(host, /max-h-\[45vh\] shrink-0 flex-wrap/);
  const ssh = fs.readFileSync(new URL('../src/components/ssh/SshSessionWorkspace.jsx', import.meta.url), 'utf8');
  assert.match(ssh, /await confirmAppMessage/); assert.match(ssh, /current\.draft !== document\.draft/); assert.doesNotMatch(ssh, /window\.confirm/);
});
test('dialog-local Tab wrapping contains focus and excludes disabled, hidden and negative-tabindex controls', () => {
  let focused; let prevented = 0;
  const item = changes => ({ disabled: false, tabIndex: 0, getClientRects: () => [1], focus() { focused = this; }, ...changes });
  const first = item(); const last = item(); const disabled = item({ disabled: true }); const hidden = item({ getClientRects: () => [] }); const skipped = item({ tabIndex: -1 });
  const controls = [first, disabled, hidden, skipped, last]; const dialog = { querySelectorAll: () => controls, ownerDocument: { activeElement: last }, contains: node => controls.includes(node), focus() { focused = this; } };
  const event = { key: 'Tab', currentTarget: dialog, preventDefault() { prevented++; } };
  trapAppMessageFocus(event); assert.equal(focused, first); assert.equal(prevented, 1);
  dialog.ownerDocument.activeElement = first; trapAppMessageFocus({ ...event, shiftKey: true }); assert.equal(focused, last);
  const before = prevented; trapAppMessageFocus({ ...event, key: 'Enter' }); trapAppMessageFocus({ ...event, ctrlKey: true }); assert.equal(prevented, before);
  dialog.querySelectorAll = () => [disabled, hidden, skipped]; trapAppMessageFocus(event); assert.equal(focused, dialog);
});
