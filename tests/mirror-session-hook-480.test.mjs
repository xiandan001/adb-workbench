import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('the real renderer hook subscribes once, ignores an older initial response and performs no device or recording action', async () => {
  const source = fs.readFileSync(new URL('../src/shared/useMirrorSessions.js', import.meta.url), 'utf8').replace(/^import .+;\r?\n/gm, '').replace('export default function', 'function');
  let resolve, listener, cleanup, slot = 0, unsubscribed = 0; const values = [], calls = [];
  const pending = new Promise(done => { resolve = done; });
  const api = new Proxy({ mirrorGetState: () => { calls.push('snapshot'); return pending; }, onMirrorStateChanged: callback => { calls.push('subscribe'); listener = callback; return () => { unsubscribed++; }; } },
    { get(target, key) { if (!(key in target)) throw Error('Unexpected action:' + String(key)); return target[key]; } });
  const Hook = vm.runInNewContext(source + '\nuseMirrorSessions', { tr: value => value,
    useState(initial) { const index = slot++; values[index] = initial; return [initial, value => { values[index] = value; }]; }, useEffect(callback) { cleanup = callback(); } });
  Hook(api); listener({ sessions: [{ id: 'NEW', deviceId: 'A', phase: 'running' }] });
  resolve({ sessions: [{ id: 'OLD', deviceId: 'A', phase: 'starting' }] }); await pending; await Promise.resolve();
  assert.equal(values[0].A.id, 'NEW'); assert.deepEqual(calls, ['subscribe', 'snapshot']);
  cleanup(); listener({ sessions: [] }); assert.equal(values[0].A.id, 'NEW'); assert.equal(unsubscribed, 1);
});
