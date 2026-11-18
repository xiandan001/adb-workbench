import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
const require = createRequire(import.meta.url);
const { removeConnectionEntry } = require('../electron/lib/history.cjs');
const entries = [
  { id:'1700000000', deviceId:'192.0.2.4:5555', type:'wifi', transport:'adb' },
  { id:'1700000000', deviceId:'usb-id', type:'usb', transport:'adb' },
  { id:'1700000000', deviceId:'hdc:192.0.2.4:5555', type:'wifi', transport:'hdc' },
  { id:'1700000001', deviceId:'hdc:serial', type:'usb', transport:'hdc' },
];
const onlyId = ({id,deviceId}) => ({ id,deviceId });
const fixture = t => {
  const base=fs.realpathSync(os.tmpdir()), dir=fs.mkdtempSync(path.join(base,'veylo-remove-device-history-'));
  const file=path.join(dir,'connection_history.json');fs.writeFileSync(file, JSON.stringify(entries,null,2)+'\n');
  t.after(()=>{ assert.equal(path.dirname(fs.realpathSync(dir)),base); assert.ok(path.basename(dir).startsWith('veylo-remove-device-history-'));
    fs.unlinkSync(file); fs.rmdirSync(dir); });
  return {dir,file};
};
test('remove exactly the selected ADB/HDC Wi-Fi or USB history record, never its same-timestamp neighbor',t=>{
  const {file}=fixture(t);
  for (const row of entries) {
    fs.writeFileSync(file,JSON.stringify(entries,null,2)+'\n');
    const expected=entries.filter(item=>item!==row), result=removeConnectionEntry(file,onlyId(row));
    assert.equal(result.success,true);assert.deepEqual(result.data,expected);assert.deepEqual(JSON.parse(fs.readFileSync(file)),expected);
    const obsolete=removeConnectionEntry(file,onlyId(row));assert.deepEqual(obsolete,{success:true,data:expected});
  }
});
test('invalid requests, corrupt/ambiguous records and failed atomic replacement preserve original bytes',t=>{
  const {dir,file}=fixture(t), before=fs.readFileSync(file);
  for(const args of [null,{id:entries[0].id}, {...onlyId(entries[0]),path:file}, {id:0,deviceId:'foo'}]) assert.equal(removeConnectionEntry(file,args).code,'INVALID_ENTRY');
  const failed=removeConnectionEntry(file,onlyId(entries[0]),{...fs,renameSync(){throw Error('injected');}});
  assert.equal(failed.success,false);assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(fs.readdirSync(dir),['connection_history.json']);
  for(const raw of ['{badJSON',JSON.stringify([entries[0],entries[0]])]) {
    fs.writeFileSync(file,raw);assert.equal(removeConnectionEntry(file,onlyId(entries[0])).success,false);assert.equal(fs.readFileSync(file,'utf8'),raw);
  }
});
test('only the expected main document can remove a record; handler has no device or terminal service',async t=>{
  const {file,dir}=fixture(t), url=pathToFileURL(path.join(dir,'dist/index.html')).href;
  const frame={url};const contents={mainFrame:frame,isDestroyed:()=>false}; const owner={webContents:contents,isDestroyed:()=>false};
  const source=fs.readFileSync(new URL('../electron/lib/history.cjs',import.meta.url),'utf8');
  const module={exports:{}};const ipc=new Map();
  vm.runInNewContext(source,{module,TextDecoder,require(key){
    if(key==='electron')return {app:{getAppPath:()=>dir,getPath:()=>dir}};
    if(key==='./app-context.cjs')return {getMainWindow:()=>owner,isDev:false};
    assert.ok(['fs','path','node:crypto','node:url'].includes(key));return require(key);
  }});
  module.exports.register({handle:(key,fn)=>ipc.set(key,fn)});const remove=ipc.get('history:remove');
  for(const event of [{sender:contents,senderFrame:{url}},{sender:{},senderFrame:frame}])assert.equal((await remove(event,onlyId(entries[1]))).code,'NOT_AUTHORIZED');
  frame.url='https://invalid.example/';const exact={sender:contents,senderFrame:frame};assert.equal((await remove(exact,onlyId(entries[1]))).code,'NOT_AUTHORIZED');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)),entries);frame.url=url;assert.equal((await remove(exact,onlyId(entries[1]))).success,true);assert.equal(JSON.parse(fs.readFileSync(file)).length,3);
});
test('renderer mutation lock deduplicates clicks, updates the shared list, rejects stale reads and retains list on failure',async()=>{
  const app=fs.readFileSync(new URL('../src/App.jsx',import.meta.url),'utf8'), funcs={};
  traverse.default(parse(app,{sourceType:'module',plugins:['jsx']}),{ VariableDeclarator({node}) {
    if(node.id.name==='refreshConnectionHistory'||node.id.name==='changeConnectionHistory') {
      const fn=node.init.type==='CallExpression'?node.init.arguments[0]:node.init;funcs[node.id.name]=app.slice(fn.start,fn.end);
    }
  }});
  let finishRead,finishRemove,rows=entries.slice();const calls=[],alerts=[];
  const env={window:{electronAPI:{loadConnectionHistory:()=>new Promise(resolve=>{finishRead=resolve;}),
    removeConnectionHistory:args=>{calls.push({...args});return new Promise(resolve=>{finishRemove=resolve;});}}},
    historyVersion:{current:0},historyMutation:{current:false},setHistoryChanging(){},setConnectionHistory:next=>{rows=next;},showToast:value=>alerts.push(value),tr:s=>s};
  env.refreshConnectionHistory=vm.runInNewContext('('+funcs.refreshConnectionHistory+')',env);
  const mutate=vm.runInNewContext('('+funcs.changeConnectionHistory+')',env), load=env.refreshConnectionHistory();
  const removal=mutate(entries[0]);await mutate(entries[0]);assert.deepEqual(calls,[onlyId(entries[0])]);
  const expected=entries.slice(1);finishRemove({success:true,data:expected});await removal;finishRead({success:true,data:entries});await load;
  assert.deepEqual(rows,expected);const failure=mutate(entries[1]);finishRemove({success:false});await failure;assert.deepEqual(rows,expected);assert.match(alerts.at(-1),/原历史已保留/);
  assert.match(app,/recentWirelessEntries\(connectionHistory\)/);
});
