import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProtocolCommandDraft, fillProtocolDraft, prepareProtocolCommandDraft, protocolCommandDraftChanged,
  protocolParameterEditorModel, updateProtocolParameterDraft,
} from '../src/shared/rs232ProtocolDraft.js';
import { listProtocolCommands } from '../src/shared/rs232Protocol.js';

test('byte options start from the catalog, reset prior review when edited, and serialize only real overrides', () => {
  const { id, name, category, template } = listProtocolCommands().find(command => command.id === 'tcl-032');
  const initial = createProtocolCommandDraft({ id, name, category, template, note: '', reviewed: true });
  const [base] = protocolParameterEditorModel(initial).parameters;
  assert.deepEqual(base.options.map(option => option.hex), ['01', '02', '03']);
  assert.ok(!Object.hasOwn(prepareProtocolCommandDraft(initial), 'parameterOverrides'));
  const edited = updateProtocolParameterDraft(initial, base, { ...base, options: [{ label: 'Manual option', hex: '0a' }] });
  assert.equal(edited.reviewed, false);
  assert.ok(protocolCommandDraftChanged(initial, edited));
  const expected = [{ key: 'XX', label: base.label, options: [{ label: 'Manual option', value: 10 }] }];
  assert.deepEqual(prepareProtocolCommandDraft(edited).parameterOverrides, expected);
  const removed = { ...edited, template: 'AA 06 31 01 CRC1 CRC2' };
  assert.ok(!Object.hasOwn(prepareProtocolCommandDraft(removed), 'parameterOverrides'));
});

test('draft validation reports duplicate or incomplete option rows before saving', () => {
  const initial = createProtocolCommandDraft({
    id: 'custom-00112233-4455-6677-8899-aabbccddeeff', name: 'Mode', category: 'Custom',
    template: 'AA LL 31 {MODE} CRC1 CRC2', note: '', reviewed: false,
  });
  const [base] = protocolParameterEditorModel(initial).parameters;
  const update = options => updateProtocolParameterDraft(initial, base, { ...base, options });
  assert.throws(() => prepareProtocolCommandDraft(update([{ label: 'Mode A', hex: 'A' }])), /两位 HEX/);
  assert.throws(() => prepareProtocolCommandDraft(update([{ label: 'Mode A', hex: '0A' }, { label: 'Mode B', hex: '0a' }])), /不能重复/);
});

test('protocol selection fills an exact HEX draft only after send preferences are accepted', async () => {
  const calls = [], frame = { hex: 'FE 08 58 42 48 43 4D 44 01 F0 CF' };
  assert.equal(await fillProtocolDraft(frame, { onPreferences: async value => { calls.push(['preferences', value]); return true; }, onDraft: value => calls.push(['draft', value]) }), true);
  assert.deepEqual(calls, [['preferences', { sendMode: 'hex', lineEnding: 'none' }], ['draft', frame.hex]]);
});

test('failed preferences never replace the current draft or send anything', async () => {
  const calls = [];
  assert.equal(await fillProtocolDraft({ hex: 'FE 08 58 42 48 43 4D 44 01 F0 CF' }, { onPreferences: async () => false, onDraft: value => calls.push(value) }), false);
  assert.deepEqual(calls, []);
  await assert.rejects(fillProtocolDraft({ hex: 'FE' }, { onPreferences: async () => { throw Error('quota'); }, onDraft: value => calls.push(value) }), /quota/);
  assert.deepEqual(calls, []);
});

test('invalid protocol bytes fail before changing either draft or preferences', async () => {
  let changes = 0;
  for (const hex of ['', 'F', 'GG 01', 'FE 0x01']) await assert.rejects(fillProtocolDraft({ hex }, { onPreferences: () => { changes++; return true; }, onDraft: () => changes++ }));
  assert.equal(changes, 0);
});
test('runtime-first failed preference writes compensate only the previous send format before returning', async () => {
  const before = { sendMode: 'text', lineEnding: 'crlf' }, config = { baudRate: 19200, path: 'TEST-NOT-A-PORT' }, changes = [];
  let preferences = { ...before, config }, draft = 'AT';
  assert.equal(await fillProtocolDraft({ hex: 'FE 08 58 42 48 43 4D 44 02 08 CF' }, { previous: before,
    onPreferences: value => { changes.push(value); preferences = { ...preferences, ...value }; return false; }, onDraft: value => { draft = value; } }), false);
  assert.deepEqual(preferences, { ...before, config }); assert.equal(draft, 'AT'); assert.deepEqual(changes, [{ sendMode: 'hex', lineEnding: 'none' }, before]);
});
test('a late cancelled fill cannot change the draft and the validated HEX is frozen across the preference await', async () => {
  let accept, draft = 'old', current = true; const frame = { hex: 'FE 08 58 42 48 43 4D 44 02 08 CF' };
  const pending = fillProtocolDraft(frame, { isCurrent: () => current, onPreferences: () => new Promise(resolve => { accept = resolve; }), onDraft: value => { draft = value; } });
  current = false; accept(true); assert.equal(await pending, false); assert.equal(draft, 'old');
  current = true; const expected = frame.hex;
  const frozen = fillProtocolDraft(frame, { isCurrent: () => current, onPreferences: () => new Promise(resolve => { accept = resolve; }), onDraft: value => { draft = value; } });
  frame.hex = 'NOT HEX'; accept(true); assert.equal(await frozen, true); assert.equal(draft, expected);
});
