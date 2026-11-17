import test from 'node:test';
import assert from 'node:assert/strict';
import * as transactions from '../src/shared/serialTransactions.js';
import fs from 'node:fs';
import vm from 'node:vm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'rolldown/utils';
import { applySerialWorkspaceSnapshot, applySerialWorkspaceDelta, emptySerialWorkspaces } from '../src/shared/serialWorkspace.js';
const { mergeSerialTransactions } = transactions;

test('dirty transaction deltas retain earlier metadata, honor eviction and stay separate across workspaces', () => {
  let states = emptySerialWorkspaces();
  states = applySerialWorkspaceSnapshot(states, { workspace: 'rs232', revision: 1, entries: [], firstId: 0, lastId: 0, firstTransactionId: 1, lastTransactionId: 1, transactions: [{ id: 1, status: 'waiting' }] });
  states = applySerialWorkspaceDelta(states, { workspace: 'rs232', revision: 2, baseRevision: 1, entries: [], firstTransactionId: 1, lastTransactionId: 2, transactions: [{ id: 2, status: 'waiting' }] });
  assert.deepEqual(states.rs232.transactions.map(item => item.id), [1, 2]); assert.deepEqual(states.terminal.transactions, []);
  states = applySerialWorkspaceDelta(states, { workspace: 'rs232', revision: 3, baseRevision: 2, entries: [], firstTransactionId: 1, lastTransactionId: 2, transactions: [{ id: 1, status: 'matched' }] });
  assert.equal(states.rs232.transactions[0].status, 'matched');
  assert.equal(mergeSerialTransactions(states.rs232.transactions, { firstTransactionId: 2, lastTransactionId: 2, transactions: [] }).length, 1);
  assert.equal(mergeSerialTransactions(states.rs232.transactions, { firstTransactionId: 0, lastTransactionId: 0, transactions: [] }, true).length, 0);
});

test('a missed transaction row requests an authoritative snapshot; ordinary legacy payloads remain compatible', () => {
  let states = emptySerialWorkspaces();
  states = applySerialWorkspaceDelta(states, { workspace: 'rs232', revision: 1, baseRevision: -1, entries: [], firstId: 0, lastId: 0, firstTransactionId: 1, lastTransactionId: 3, transactions: [{ id: 3, status: 'matched' }] });
  assert.equal(states.rs232.needsSnapshot, true);
  const legacy = applySerialWorkspaceSnapshot(emptySerialWorkspaces(), { workspace: 'rs232', revision: 1, firstId: 0, lastId: 0, entries: [] });
  assert.deepEqual(legacy.rs232.transactions, []); assert.equal(legacy.rs232.needsSnapshot, false);
});

test('actual transaction view renders a bounded recent viewport, preserves original lookup and invokes no actions', () => {
  const source = fs.readFileSync(new URL('../src/components/SerialTransactionsView.jsx', import.meta.url), 'utf8').replace(/^import .+;\r?\n/gm, '').replace('export default function', 'function');
  const code = transformSync('SerialTransactionsView.jsx', source, { jsx: { runtime: 'classic', pragma: 'jsx' } }).code;
  let actions = 0;
  const Component = vm.runInNewContext(code + '\nSerialTransactionsView', { ...transactions, jsx: createElement, useLocale: () => 'zh-CN', getLocale: () => 'zh-CN', useRef: () => ({ current: null }), useState: value => [value, () => {}], useLayoutEffect() {}, tr: (value, args = {}) => value.replace(/\{(\d+)\}/g, (all, key) => args[key] ?? all) });
  const entries = [{ id: 200 }, { id: 202 }]; assert.equal(transactions.serialTransactionRecord(entries, 202), entries[1]); assert.equal(transactions.serialTransactionRecord(entries, 201), undefined);
  const rows = Array.from({ length: 200 }, (_, index) => ({ id: index + 1, commandId: 'lango-005', status: 'matched', valueKind: 'power', value: 1, requestAt: 1700000000000, txRecordId: 200, rxRecordId: 202 }));
  const html = renderToStaticMarkup(createElement(Component, { transactions: rows, entries, following: true, theme: { input: '', textMuted: '' }, onRecord: () => actions++, onFollowing: () => actions++ }));
  assert.ok((html.match(/data-serial-transaction-id=/g) || []).length <= 10); assert.match(html, /开机/); assert.match(html, /不代表设备执行成功/); assert.equal(actions, 0);
});
