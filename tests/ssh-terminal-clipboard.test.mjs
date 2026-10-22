import test from 'node:test';
import assert from 'node:assert/strict';
import { sshClipboardAction } from '../src/shared/sshTerminalClipboard.js';

test('SSH Ctrl+C copies a selection but preserves the remote interrupt without a selection', () => {
  assert.equal(sshClipboardAction({ key: 'c', ctrlKey: true }, true), 'copy');
  assert.equal(sshClipboardAction({ key: 'c', ctrlKey: true }, false), null);
  assert.equal(sshClipboardAction({ key: 'C', ctrlKey: true, shiftKey: true }, false), 'copy');
  assert.equal(sshClipboardAction({ key: 'Insert', ctrlKey: true }, true), 'copy');
});

test('SSH supports desktop and terminal paste shortcuts without consuming unrelated keys', () => {
  for (const event of [{ key: 'v', ctrlKey: true }, { key: 'V', ctrlKey: true, shiftKey: true }, { key: 'Insert', shiftKey: true }]) {
    assert.equal(sshClipboardAction(event, false), 'paste');
  }
  for (const event of [{ key: 'v' }, { key: 'v', ctrlKey: true, altKey: true }, { key: 'Insert' }, { key: 'c', altKey: true }, { key: 'c', metaKey: true }]) {
    assert.equal(sshClipboardAction(event, true), null);
  }
});
