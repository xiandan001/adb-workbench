import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';

const api = () => import('../src/shared/rs232Protocol.js');
const customId = 'custom-10000000-0000-4000-8000-000000000001';
const preferences = (overrides = [], removed = []) => ({ version: 1, overrides, removed });
const edited = (base, patch) => ({ id: base.id, name: base.name, category: base.category, template: base.template, note: base.note, reviewed: false, ...patch });

test('power, query, volume, channel and whiteboard golden frames contain only original bytes and no CRC/newline', async () => {
  const { listProtocolCommands, buildProtocolCommand } = await api(), entries = listProtocolCommands();
  const cases = [[1, {}, 'FE 08 58 42 48 43 4D 44 01 F0 CF'], [5, {}, 'FE 08 58 42 48 43 4D 44 02 08 CF'],
    [42, { XX: 100 }, 'FE 09 58 42 48 43 4D 44 03 03 64 CF'], [37, { XX: 0x15 }, 'FE 09 58 42 48 43 4D 44 03 0B 15 CF'],
    [111, { XX: 2 }, 'FE 09 58 42 48 43 4D 44 06 02 02 CF']];
  for (const [index, values, expected] of cases) {
    const result = buildProtocolCommand(entries[index - 1], values); assert.equal(result.hex, expected); assert.ok(result.bytes instanceof Uint8Array);
    assert.equal(result.bytes.length, expected.split(' ').length); assert.equal(result.bytes.at(-1), 0xcf); assert.equal(result.hex.includes('\n'), false);
  }
  for (const command of entries.filter(entry => entry.protocol !== 'tcl' && !entry.needsReview && !entry.referenceOnly && !entry.template.includes('{') && !entry.template.includes(' LL '))) assert.equal(buildProtocolCommand(command).hex, command.sourceControl);
});
test('documented integer ranges, enums and unknown/missing fields fail closed rather than guessing defaults', async () => {
  const { listProtocolCommands, getProtocolParameters, buildProtocolCommand } = await api(), entries = listProtocolCommands(), volume = entries[41], channel = entries[36];
  assert.equal(getProtocolParameters(volume)[0].max, 100);
  for (const XX of [0, 100, '100', '0x64']) assert.equal(buildProtocolCommand(volume, { XX }).bytes[10], Number(XX));
  assert.equal(buildProtocolCommand(volume, { XX: '64' }).bytes[10], 64, 'Digits are decimal, not silently guessed as hexadecimal');
  for (const values of [{}, { XX: -1 }, { XX: 101 }, { XX: 1.5 }, { XX: '' }, { XX: '3junk' }, { XX: 2, extra: 1 }]) assert.throws(() => buildProtocolCommand(volume, values), { code: 'RS232_PARAMETER_INVALID' });
  assert.equal(buildProtocolCommand(channel, { XX: 'FF' }).bytes[10], 255); assert.throws(() => buildProtocolCommand(channel, { XX: 31 }), { code: 'RS232_PARAMETER_INVALID' });
  assert.throws(() => buildProtocolCommand(entries[110], { XX: 3 }), { code: 'RS232_PARAMETER_INVALID' });
});
test('every documented TX range and enum remains attached to its exact source row', async () => {
  const { listProtocolCommands, getProtocolParameters, buildProtocolCommand } = await api(), entries = listProtocolCommands();
  for (const index of [42, 48, 50, 52, 54, 56]) {
    const parameter = getProtocolParameters(entries[index - 1])[0]; assert.equal(parameter.min, 0); assert.equal(parameter.max, 100);
    assert.throws(() => buildProtocolCommand(entries[index - 1], { XX: 101 }), { code: 'RS232_PARAMETER_INVALID' });
  }
  for (const index of [39, 58, 62, 63, 68, 70, 84, 89, 91, 93, 95, 104, 109, 110]) {
    const parameter = getProtocolParameters(entries[index - 1])[0]; assert.deepEqual(parameter.options.map(option => option.value), [0, 1], String(index));
    assert.equal(parameter.min, 0); assert.equal(parameter.max, 1); assert.throws(() => buildProtocolCommand(entries[index - 1], { XX: 2 }), { code: 'RS232_PARAMETER_INVALID' });
  }
  assert.deepEqual(getProtocolParameters(entries[13])[0].options.map(option => option.value), [0, 1, 2]);
  assert.deepEqual(getProtocolParameters(entries[45])[0].options.map(option => option.value), [0, 1, 2, 3]);
  assert.equal(getProtocolParameters(entries[83])[0].options[0].label, '取消静音');
  assert.equal(getProtocolParameters(entries[88])[0].options[0].label, '取消禁用');
});
test('review gating cannot be bypassed through forged flags; literal bad LL is never silently repaired', async () => {
  const { listProtocolCommands, buildProtocolCommand } = await api(), entries = listProtocolCommands();
  for (const index of [45, 80, 92, 102, 105]) assert.throws(() => buildProtocolCommand({ ...entries[index - 1], needsReview: false }), { code: 'RS232_REVIEW_REQUIRED' });
  assert.throws(() => buildProtocolCommand({ ...entries[104], reviewed: true }, { XX: 1 }), { code: 'RS232_FRAME_INVALID' });
  const corrected = { ...entries[104], template: 'FE LL 58 42 48 43 4D 44 02 1B {XX} CF', reviewed: true };
  assert.equal(buildProtocolCommand(corrected, { XX: 1 }).bytes[1], 9);
  for (const command of entries.filter(entry => entry.referenceOnly)) assert.throws(() => buildProtocolCommand({ ...command, reviewed: true, referenceOnly: false }), { code: 'RS232_REFERENCE_ONLY' });
});
test('only an explicit LL token calculates length; ordinary payload limit is exactly 247 bytes', async () => {
  const { buildProtocolCommand } = await api();
  const command = { id: customId, reviewed: true, template: 'FE LL 58 42 48 43 4D 44 03 50 ' + '00 '.repeat(247) + 'CF' };
  const result = buildProtocolCommand(command); assert.equal(result.bytes.length, 258); assert.equal(result.bytes[1], 255);
  assert.throws(() => buildProtocolCommand({ ...command, template: command.template.replace('LL', '08') }), { code: 'RS232_FRAME_INVALID' });
  assert.throws(() => buildProtocolCommand({ ...command, template: command.template.replace('CF', '00 CF') }), { code: 'RS232_DATA_TOO_LONG' });
  for (const template of ['FE 0 58 42 48 43 4D 44 03 50 CF', 'FE 08 58 42 48 43 4D 4X 03 50 CF', 'FF 08 58 42 48 43 4D 44 03 50 CF', 'FE 08 58 42 48 43 4D 44 09 50 CF']) assert.throws(() => buildProtocolCommand({ ...command, template }));
});
test('unchanged built-ins retain source constraints while explicitly edited templates use reviewed generic bytes', async () => {
  const { listProtocolCommands, getProtocolParameters, buildProtocolCommand } = await api(), volume = listProtocolCommands()[41];
  const metadataOnly = edited(volume, { name: 'My volume', note: 'custom note' }); assert.equal(getProtocolParameters(metadataOnly)[0].max, 100);
  const changed = edited(volume, { template: 'FE LL 58 42 48 43 4D 44 03 03 {XX} CF' });
  assert.equal(getProtocolParameters(changed)[0].max, 255); assert.throws(() => buildProtocolCommand(changed, { XX: 200 }), { code: 'RS232_REVIEW_REQUIRED' });
  assert.equal(buildProtocolCommand({ ...changed, reviewed: true }, { XX: 200 }).bytes[10], 200);
});
test('source ASCII microphone input uses exactly one documented space and actual LL, not invented numeric defaults', async () => {
  const { listProtocolCommands, getProtocolParameters, buildProtocolCommand } = await api(), command = listProtocolCommands()[106];
  assert.deepEqual(getProtocolParameters(command).map(parameter => parameter.type), ['ascii', 'ascii']);
  assert.equal(buildProtocolCommand(command, { XX: '12.34', YY: '56.78' }).hex, 'FE 13 58 42 48 43 4D 44 04 01 31 32 2E 33 34 20 35 36 2E 37 38 CF');
  assert.equal(buildProtocolCommand(command, { XX: '1'.repeat(245), YY: '2' }).bytes[1], 255);
  assert.throws(() => buildProtocolCommand(command, { XX: '1'.repeat(246), YY: '2' }), { code: 'RS232_DATA_TOO_LONG' });
  for (const values of [{ XX: '', YY: '1' }, { XX: '中文', YY: '1' }, { XX: '1 2', YY: '1' }, { XX: '1' }]) assert.throws(() => buildProtocolCommand(command, values), { code: 'RS232_PARAMETER_INVALID' });
});
test('removal wins before overrides, custom entries are reviewed and original catalog/labels cannot be mutated', async () => {
  const { listProtocolCommands, getProtocolDisplayName, getProtocolCategoryLabel } = await api(), base = listProtocolCommands()[0];
  const renamed = edited(base, { name: 'User name', category: 'User category' });
  assert.equal(listProtocolCommands(preferences([renamed], [base.id])).some(entry => entry.id === base.id), false);
  const entry = listProtocolCommands(preferences([renamed])).find(item => item.id === base.id);
  assert.equal(getProtocolDisplayName(entry, 'ja-JP'), 'User name'); assert.equal(getProtocolCategoryLabel(entry.category, 'en-US', entry), 'User category');
  assert.equal(getProtocolDisplayName(base, 'en-US'), 'Power on'); base.template = '00'; assert.notEqual(listProtocolCommands()[0].template, '00');
  const custom = edited(listProtocolCommands()[0], { id: customId, name: '开机', reviewed: true });
  assert.equal(getProtocolDisplayName(listProtocolCommands(preferences([custom])).at(-1), 'en-US'), '开机');
});
test('the actual private error map translates fixed literals lazily when the locale changes, never user strings', () => {
  const source = fs.readFileSync(new URL('../src/shared/rs232Protocol.js', import.meta.url), 'utf8'), declarations = new Map();
  traverseModule.default(parse(source, { sourceType: 'module', plugins: ['importAttributes'] }), { VariableDeclarator({ node }) {
    if (['messages', 'fail'].includes(node.id.name)) declarations.set(node.id.name, source.slice(node.init.start, node.init.end));
  } });
  let locale = 'zh-CN'; const translated = [], context = { tr: literal => { translated.push(literal); return locale + ':' + literal; } };
  context.messages = vm.runInNewContext('(' + declarations.get('messages') + ')', context);
  const fail = vm.runInNewContext('(' + declarations.get('fail') + ')', context);
  assert.equal(translated.length, 0, 'Do not cache errors in the startup locale');
  for (const next of ['zh-CN', 'en-US', 'zh-TW', 'ja-JP', 'ko-KR']) {
    locale = next; assert.throws(() => fail('RS232_PARAMETER_INVALID'), error => error.code === 'RS232_PARAMETER_INVALID' && error.message.startsWith(next + ':'));
  }
  assert.equal(new Set(translated).size, 1); assert.equal(translated[0], '请填写有效的协议参数，不要超出说明范围。');
});
test('unknown commands, accessor parameters, invalid prototypes and malformed tokens fail without invoking accessors', async () => {
  const { listProtocolCommands, buildProtocolCommand, getProtocolParameters } = await api(), command = listProtocolCommands()[41];
  for (const id of ['lango-000', 'lango-112', 'lango-report-5', 'other', '']) assert.throws(() => buildProtocolCommand({ ...command, id, reviewed: true }), { code: 'RS232_COMMAND_INVALID' });
  let invoked = 0; const values = {}; Object.defineProperty(values, 'XX', { enumerable: true, get() { invoked++; return 1; } });
  assert.throws(() => buildProtocolCommand(command, values), { code: 'RS232_PARAMETER_INVALID' }); assert.equal(invoked, 0);
  assert.throws(() => buildProtocolCommand(command, Object.assign(Object.create({ other: 1 }), { XX: 1 })), { code: 'RS232_PARAMETER_INVALID' });
  assert.throws(() => getProtocolParameters({ ...command, template: 'FE LL 58 42 48 43 4D 44 03 03 XX CF' }), { code: 'RS232_TEMPLATE_INVALID' });
  const parameter = getProtocolParameters(command)[0]; parameter.max = 255; assert.equal(getProtocolParameters(command)[0].max, 100);
});
test('listing, parameter selection, localization and generation never invoke IPC or write storage', async () => {
  const protocol = await api(), previous = globalThis.window, storage = globalThis.localStorage, calls = [];
  globalThis.window = { electronAPI: new Proxy({}, { get: (_target, name) => () => { calls.push(String(name)); throw Error('Forbidden IPC'); } }) };
  globalThis.localStorage = { getItem: () => { calls.push('read storage'); return null; }, setItem: () => calls.push('write storage') };
  try {
    const entry = protocol.listProtocolCommands()[41]; protocol.getProtocolParameters(entry); protocol.getProtocolDisplayName(entry, 'ja-JP');
    protocol.getProtocolCategoryLabel(entry.category, 'ko-KR'); protocol.buildProtocolCommand(entry, { XX: 42 }); assert.deepEqual(calls, []);
  } finally {
    if (previous === undefined) delete globalThis.window; else globalThis.window = previous;
    if (storage === undefined) delete globalThis.localStorage; else globalThis.localStorage = storage;
  }
});
