import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import { subscribeConnectionStatus } from '../src/shared/connectionStatus.js';

function callback(file, property, testNode) {
  const code = fs.readFileSync(new URL('../src/' + file, import.meta.url), 'utf8');
  let source;
  traverse.default(parse(code, { sourceType: 'module', plugins: ['jsx'] }), { [property](p) {
    const value = testNode(p.node);
    if (value) source = code.slice(value.start, value.end);
  } });
  assert.ok(source, file + ' callback not found'); return source;
}
test('clicking an explicit workspace targets the correct subpage even when serial is already mounted; no transport commands', () => {
  const navigate = callback('App.jsx', 'JSXAttribute', node =>
    node.name?.name === 'onNavigateConnection' && node.value?.expression?.type === 'ArrowFunctionExpression' && node.value.expression);
  const apply = callback('components/SerialPanel.jsx', 'CallExpression', node =>
    node.callee.name === 'useEffect' && node.arguments[1]?.elements?.some(dep => dep?.name === 'navigationRequest') && node.arguments[0]);
  for (const [page, previous, target] of [['serial','ip-control','rs232'], ['serial','rs232','ip-control'], ['devices','rs232','terminal']]) {
    let tab = page, request = null, workspace = { mode:previous, draft:'preserved' }, terminalOpened = false;
    vm.runInNewContext('(' + navigate + ')', { setSerialNavigation: value => {request=value;}, setActiveTab: next => {tab=next;} })(target);
    assert.equal(tab,'serial'); assert.equal(request.mode,target);
    const changes=[];
    vm.runInNewContext('(' + apply + ')', { navigationRequest:request, updateSerialWorkspace: change=>changes.push(change.mode),
      setWorkspace: update=>{workspace=update(workspace);}, setTerminalOpened: v=>{terminalOpened=v;}, onNavigationHandled: fn=>{request=fn(request);} })();
    assert.deepEqual(changes,[target]); assert.equal(workspace.mode,target); assert.equal(workspace.draft,'preserved');
    assert.equal(request,null); assert.equal(terminalOpened,target==='terminal');
  }
});

test('IP subscription accepts push over stale first response, resyncs on visibility and disposes its listener', async () => {
  const events = new Map(), document = {hidden:false,addEventListener:(key,fn)=>events.set(key,fn),removeEventListener:key=>events.delete(key)};
  const window = {addEventListener:(key,fn)=>events.set(key,fn),removeEventListener:key=>events.delete(key)};
  const calls=[], values=[]; let receive, pending, removed=false;
  const payload=phase=>({mode:'udp',phase,activeCount:phase==='ready'?1:0,pendingCount:0,unsavedCount:0,failedCount:0,transferCount:0,labels:[]});
  const stop=subscribeConnectionStatus({api:{ipControlConnectionStatusSubscribe:({active})=>{
    calls.push(active); if(calls.length===1)return new Promise(resolve=>{pending=resolve;}); return {success:true,status:payload('idle')};
  },onIpControlConnectionStatus:fn=>{receive=fn;return ()=>{removed=true;};}},document,window,onStatus:(id,v)=>{if(id==='ip-control')values.push(v.phase);},onError(){}});
  const tick=()=>new Promise(r=>setImmediate(r)); await tick();receive(payload('ready'));pending({success:true,status:payload('idle')});await tick();
  assert.deepEqual(values,['ready']);document.hidden=true;events.get('visibilitychange')();await tick();receive(payload('idle'));assert.deepEqual(values,['ready']);
  document.hidden=false;events.get('visibilitychange')();await tick();assert.deepEqual(values,['ready','idle']);stop();await tick();
  assert.deepEqual(calls,[true,false,true,false]);assert.equal(removed,true);assert.equal(events.size,0);
});
