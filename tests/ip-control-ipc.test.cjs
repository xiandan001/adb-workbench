const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerIpControl, readAnalysisSnapshot, isAnalysisSessionCurrent } = require('../electron/lib/ip-control-ipc.cjs');
const url = pathToFileURL(path.resolve('dist/index.html')).href;
function fixture(history, recordOptions) {
  const handlers = new Map(), services = [];
  const contents = Object.assign(new EventEmitter(), { mainFrame: { url }, isDestroyed: () => false });
  const owner = { webContents: contents, isDestroyed: () => false };
  const dispose = registerIpControl({ handle: (name, fn) => handlers.set(name, fn) }, {
    getOwner: () => owner, appRoot: path.resolve('.'), isDev: false, history, ...recordOptions, createService({ onSuccessfulEndpoint }) {
      const calls = []; let close, opened = new Promise(resolve => { close = resolve; });
      const service = { calls, onSuccessfulEndpoint, connect: () => opened, read: () => ({ ok: true }), send: args => { calls.push(args); return { ok: true }; },
        dispose() { calls.push('dispose'); close({ ok: false, code: 'CANCELLED' }); } };
      services.push(service); return service;
    }
  });
  return { contents, services, dispose, invoke(name, args, event = { sender: contents, senderFrame: contents.mainFrame }) { return handlers.get('ip-control:' + name)(event, args); } };
}
test('only the packaged main document has access: no socket for another window, subframe or unexpected document', async () => {
  const f = fixture();
  for (const event of [{ sender: {}, senderFrame: f.contents.mainFrame }, { sender: f.contents, senderFrame: { url } }]) {
    assert.equal((await f.invoke('connect', {}, event)).code, 'NOT_AUTHORIZED');
  }
  f.contents.mainFrame.url = 'https://example.invalid/'; assert.equal((await f.invoke('read')).code, 'NOT_AUTHORIZED');
  assert.equal(f.services.length, 0); f.dispose();
});

test('record actions accept only main-frame session scope; export freezes before dialog, cancellation is a no-op', async () => {
  const scope = { sessionId:'network-A', recordEpoch:0 };
  let finish, choices=0, writes=0, current=true;
  const f = fixture(undefined, { chooseRecordFile: () => { choices++; return new Promise(r=>{finish=r;}); },
    writeRecordFile: async (_path, frozen, options) => {
      assert.equal(frozen.sessionId,scope.sessionId); assert.ok(options.isCurrent()); writes++;
    } });
  await f.invoke('read');
  let freezes=0, clears=0;
  Object.assign(f.services[0], {
    snapshotForExport: () => { freezes++; return { ok:true, snapshot:{sessionId:scope.sessionId} }; },
    clearRecords: args => { assert.deepEqual(args,scope); clears++; return {ok:true,recordEpoch:1}; },
    isRecordScopeCurrent: () => current
  });
  for(const action of ['save-records','clear-records']){
    assert.equal((await f.invoke(action,scope,{sender:f.contents,senderFrame:{url}})).code,'NOT_AUTHORIZED');
    assert.equal((await f.invoke(action,{...scope,filePath:'injected'})).ok,false);
  }
  assert.equal(clears+choices+freezes,0);
  const first=f.invoke('save-records',scope); assert.equal(freezes,1);
  assert.equal((await f.invoke('save-records',scope)).code,'SAVE_BUSY');
  finish({canceled:true}); assert.deepEqual(await first,{ok:true,cancelled:true}); assert.equal(writes,0);
  const second=f.invoke('save-records',scope); finish({filePath:'chosen.log'}); assert.deepEqual(await second,{ok:true});
  const third=f.invoke('save-records',scope); current=false; finish({filePath:'stale.log'}); assert.equal((await third).ok,false); assert.equal(writes,1);
  current=true; assert.deepEqual(await f.invoke('clear-records',scope),{ok:true,recordEpoch:1}); assert.equal(clears,1);
  const last=f.invoke('save-records',scope); f.dispose(); finish({filePath:'old-owner.log'}); assert.equal((await last).ok,false); assert.equal(writes,1);
});

test('AI snapshot reads do not create a service and cannot reuse a departed owner or old session', async () => {
  const f = fixture(), id = 'session-a';
  assert.equal(readAnalysisSnapshot(id), null); assert.equal(f.services.length, 0);
  await f.invoke('read');
  f.services[0].currentSessionId = () => id;
  f.services[0].snapshotForAnalysis = requested => requested === id ? { sessionId: id } : null;
  assert.deepEqual(readAnalysisSnapshot(id), { sessionId: id }); assert.equal(isAnalysisSessionCurrent(id), true);
  assert.equal(readAnalysisSnapshot('old'), null); assert.deepEqual(f.services[0].calls, []);
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.equal(readAnalysisSnapshot(id), null); assert.equal(isAnalysisSessionCurrent(id), false);
  f.dispose();
});

test('history comes only from transport evidence; listing and deleting never connect, send, or expose data to a subframe', async () => {
  let records = [], failWrite = false;
  const f = fixture({ list: async () => ({ ok: true, entries: records }), record: async value => {
    if (failWrite) return { ok: false, code: 'HISTORY_UNAVAILABLE' };
    records.push(value); return { ok: true };
  }, remove: async ({ id }) => { records = records.filter(row => row.id !== id); return { ok: true, entries: records }; },
  clear: async () => { records = []; return { ok: true, entries: records }; }, flush: async () => {} });
  await f.invoke('read'); assert.deepEqual((await f.invoke('history')).entries, []);
  await f.services[0].onSuccessfulEndpoint({ id: 'peer', mode: 'tcp-client', host: '127.0.0.1', port: 8192 });
  assert.equal((await f.invoke('read')).historyRevision, 1);
  for (const action of ['history','clear-history','remove-history']) {
    assert.equal((await f.invoke(action, {id:'peer'}, {sender:f.contents,senderFrame:{url}})).code, 'NOT_AUTHORIZED');
  }
  assert.equal((await f.invoke('history')).entries.length, 1);
  failWrite = true; await f.services[0].onSuccessfulEndpoint({}); assert.equal((await f.invoke('history')).error, 'HISTORY_UNAVAILABLE');
  assert.deepEqual((await f.invoke('remove-history', {id:'peer'})).entries, []);
  assert.equal((await f.invoke('read')).historyRevision, 3);
  assert.deepEqual(f.services[0].calls, []); await f.dispose();
});
test('changing tabs does not reconnect; losing the document disposes the session and fences late replies', async () => {
  const f = fixture(), pending = f.invoke('connect', {});
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  await f.invoke('read'); assert.equal(f.services.length, 1);
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.equal((await pending).code, 'NOT_AUTHORIZED'); assert.deepEqual(f.services[0].calls, ['dispose']);
  f.contents.mainFrame = { url }; await f.invoke('read');
  f.contents.emit('render-process-gone'); assert.deepEqual(f.services[1].calls, ['dispose']);
  await f.invoke('read'); f.dispose(); assert.deepEqual(f.services[2].calls, ['dispose']); assert.equal((await f.invoke('read')).code, 'NOT_AUTHORIZED');
});
