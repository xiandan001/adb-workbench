import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as memory from '../src/shared/rs232ProtocolMemory.js';

test('actual shared memory hook keeps a volatile view usable after quota errors without altering stored bytes', () => {
  const slots = [], effects = [], listeners = new Map(); let cursor = 0, denied = false;
  const storage = { raw: null, getItem() { return this.raw; }, setItem(_key, raw) { if (denied) throw Error('quota'); this.raw = raw; } };
  const scope = { workspace: 'rs232', schemeId: '' };
  const source = fs.readFileSync(new URL('../src/shared/useRs232ProtocolMemory.js', import.meta.url), 'utf8').replace(/^import .+;\r?\n/gm, '').replace('export default function', 'function');
  const Component = vm.runInNewContext(source + '\nuseRs232ProtocolMemory', {
    defaultRs232Memory: memory.defaultRs232Memory, normalizeRs232Memory: value => memory.normalizeRs232Memory(structuredClone(value)),
    readRs232Memory: () => memory.readRs232Memory(storage), writeRs232Memory: value => memory.writeRs232Memory(structuredClone(value), storage), Event,
    window: { addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key), dispatchEvent: event => listeners.get(event.type)?.() },
    useState(initial) { const index = cursor++; if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; }]; },
    useEffect(callback) { const index = cursor++; if (!slots[index]) { slots[index] = {}; effects.push(callback); } },
  });
  const draw = () => { cursor = 0; const result = Component(); effects.splice(0).forEach(callback => callback()); return result; };
  let hook = draw(); assert.equal(hook.update(value => memory.setRs232MemoryViewMode(value, scope, 'raw')), true); hook = draw();
  const before = storage.raw; denied = true;
  assert.equal(hook.update(value => memory.setRs232MemoryViewMode(value, scope, 'transactions')), false); hook = draw();
  assert.equal(memory.getRs232MemoryScope(hook.value, scope).viewMode, 'transactions'); assert.ok(hook.error); assert.equal(storage.raw, before);
});
