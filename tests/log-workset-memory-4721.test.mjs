import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeLogFilter, normalizeLogBuffers } from '../src/shared/logWorkspace.js';

function harness(remember) {
  const slots = [], effects = [], timers = new Map(), calls = []; let cursor = 0, serial = 0;
  const source = fs.readFileSync(new URL('../src/shared/useLogWorksetMemory.js', import.meta.url), 'utf8')
    .replace(/^import .+;\n/gm, '').replace('export default function useLogWorksetMemory', 'function useLogWorksetMemory');
  const hook = vm.runInNewContext(`${source}\nuseLogWorksetMemory`, { normalizeLogFilter, normalizeLogBuffers, tr: value => value,
    window: { electronAPI: { worksetRemember: args => { calls.push(args); return remember(args); } } },
    setTimeout: callback => { const id = ++serial; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
    useCallback(fn, deps) { const index = cursor++, previous = slots[index]; if (!previous || deps.some((value, position) => value !== previous.deps[position])) slots[index] = { value: fn, deps }; return slots[index].value; },
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], value => { slots[index] = value; }]; },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useEffect(run, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, position) => value !== previous.deps[position])) {
        previous?.cleanup?.(); const record = { deps }; slots[index] = record; effects.push(() => { record.cleanup = run(); });
      }
    },
  });
  let input = { deviceId: 'device-A', filter: { text: 'error' }, buffers: ['crash'] };
  const render = next => { if (next) input = next; cursor = 0; const result = hook(input); for (const run of effects.splice(0)) run(); return result; };
  return { render, calls, timers, input };
}

test('resolved validation and rejected write failures remain visible and retry submits unchanged filters', async () => {
  let attempt = 0;
  const h = harness(async () => { attempt++; if (attempt === 1) return { ok: false, error: 'Rejected filter metadata' }; if (attempt === 2) throw Error('Disk full'); return { ok: true }; });
  await h.render().retry(); assert.equal(h.render().error, 'Rejected filter metadata');
  await h.render().retry(); assert.equal(h.render().error, 'Disk full');
  await h.render().retry(); assert.equal(h.render().error, ''); assert.equal(h.render().saving, false);
  for (const call of h.calls) { assert.equal(call.part, 'logs'); assert.deepEqual(call.value.filter, h.input.filter); assert.deepEqual(call.value.buffers, h.input.buffers); }
  assert.equal(h.input.filter.text, 'error');
});

test('newer log metadata success cannot be overwritten by an older failed remember response', async () => {
  const pending = [];
  const h = harness(() => new Promise(resolve => pending.push(resolve)));
  const old = h.render().retry();
  const next = { deviceId: 'device-B', filter: { text: 'new-filter' }, buffers: ['main'] };
  const current = h.render(next).retry();
  pending[1]({ ok: true }); await current;
  pending[0]({ ok: false, error: 'Old failure' }); await old;
  assert.equal(h.render().error, ''); assert.equal(h.calls[1].value.deviceId, 'device-B'); assert.equal(h.calls[1].value.filter.text, 'new-filter');
});

test('LogAnalyzer exposes an inline retry and observation warnings follow edited rather than generated steps', () => {
  const logs = fs.readFileSync(new URL('../src/components/LogAnalyzer.jsx', import.meta.url), 'utf8');
  assert.match(logs, /worksetMemory.error && <div role="alert"/); assert.match(logs, /onClick=\{worksetMemory.retry\}/);
  assert.match(logs, /disabled=\{worksetMemory.saving\}/);
  const results = fs.readFileSync(new URL('../src/components/AiWorkspaceResults.jsx', import.meta.url), 'utf8');
  const expression = results.match(/const observationOnly = ([^;]+);/)?.[1]; assert.ok(expression);
  const observation = new Function('edited', `return ${expression}`);
  assert.equal(observation({ steps: [{ type: 'screenshot' }] }), true);
  assert.equal(observation({ steps: [{ type: 'screenshot' }, { type: 'tap' }] }), false);
});
