import test from 'node:test';
import assert from 'node:assert/strict';
import { readIpCommands, saveIpFavorite, removeIpFavorite, appendIpSendHistory, removeIpSendHistory, clearIpSendHistory } from '../src/shared/ipControlCommands.js';

function mock() {
  const data = new Map([['adb-workbench.serial-preferences.v1','untouched'],['adb-workbench.serial-history.v1','untouched']]), calls=[];
  return {data,calls,getItem(k){calls.push(['get',k]);return data.get(k)??null;},setItem(k,v){calls.push(['write',k]);data.set(k,v);},removeItem(k){calls.push(['remove',k]);data.delete(k);}};
}
const req = {mode:'tcp-client',host:'127.0.0.1',port:8192,hex:'ff 01'};
const rejects = (fn,code) => assert.throws(fn,e=>e.code===code);
test('favorites persist across fresh storage handles, normalize full HEX, edit in place, reject duplicate names and protect COM keys',()=>{
  const st=mock();assert.deepEqual(readIpCommands(st),{favorites:[],history:[]});
  const first=saveIpFavorite({name:'  Display  ',hex:'00 ff\r\n800d'},st).favorites[0];assert.equal(first.name,'Display');assert.equal(first.hex,'00FF800D');
  rejects(()=>saveIpFavorite({name:'display',hex:'00'},st),'NAME_EXISTS');
  const second=saveIpFavorite({id:first.id,name:'Display status',hex:'11 22'},st).favorites;assert.equal(second.length,1);assert.equal(second[0].id,first.id);
  const restored=mock();for(const [k,v] of st.data)restored.data.set(k,v);assert.deepEqual(readIpCommands(restored).favorites,second);
  assert.deepEqual(removeIpFavorite(first.id,st).favorites,[]);rejects(()=>removeIpFavorite(first.id,st),'NOT_FOUND');
  assert.ok(!st.calls.some(([,key])=>key.includes('serial')));assert.equal(st.data.get('adb-workbench.serial-preferences.v1'),'untouched');
});
test('network send history deduplicates only the same mode, endpoint and bytes, promotes newer and deletes records independently',()=>{
  const st=mock();
  const first=appendIpSendHistory(req,st).history[0]; assert.equal(first.hex,'FF01'); assert.ok(Number.isSafeInteger(first.at));
  appendIpSendHistory({...req,mode:'udp'},st);appendIpSendHistory({...req,port:1000},st);appendIpSendHistory({...req,hex:'FE'},st);
  const rows=appendIpSendHistory({...req,hex:'fF01'},st).history;assert.equal(rows.length,4);assert.equal(rows[0].id,first.id);
  assert.equal(removeIpSendHistory(rows[1].id,st).history.length,3);
  saveIpFavorite({name:'a',hex:'00'},st);const empty=clearIpSendHistory(st);assert.equal(empty.favorites.length,1);assert.equal(empty.history.length,0);
  assert.ok(!st.calls.some(([,k])=>k.includes('serial')));
});
test('bounded history evicts complete old rows without truncating HEX, touching favorites or crossing either cap',()=>{
  const st=mock();saveIpFavorite({name:'keep',hex:'00'},st);st.calls.length=0;
  for(let i=0;i<30;i++)appendIpSendHistory({...req,port:8192+i},st);
  const max=readIpCommands(st).history;assert.equal(max.length,20);assert.equal(max[0].port,8221);
  const hex='AC'.repeat(65536);for(let i=0;i<12;i++)appendIpSendHistory({...req,hex,port:2010+i},st);
  const rows=readIpCommands(st).history;assert.ok(rows.length>0&&rows.length<12);assert.equal(rows[0].port,2021);assert.ok(rows.every(r=>r.hex===hex));
  assert.ok(!st.calls.some(([kind,k])=>kind==='write' && k.includes('favorites')));
});
test('input, entry and byte limits reject without dirtying stored preferences',()=>{
  const st=mock();for(let i=0;i<32;i++)saveIpFavorite({name:'f'+i,hex:'00'},st);
  rejects(()=>saveIpFavorite({name:'overflow',hex:'00'},st),'FAVORITE_LIMIT');
  for(const hex of ['','0 1','FF00?','0x00']) rejects(()=>appendIpSendHistory({...req,hex},st),'INVALID_HEX');
  rejects(()=>appendIpSendHistory({...req,hex:'FF'.repeat(65537)},st),'SEND_TOO_LARGE');
  rejects(()=>appendIpSendHistory({...req,mode:'udp',hex:'FF'.repeat(65508)},st),'UDP_TOO_LARGE');
  for(const invalid of [{host:'n/a'},{mode:'terminal'},{port:0}]) rejects(()=>appendIpSendHistory({...req,...invalid},st),'INVALID_ENDPOINT');
  assert.equal(readIpCommands(st).history.length,0);const full=mock(), hex='FF'.repeat(65536);
  for(let i=0;i<3;i++)saveIpFavorite({name:'max'+i,hex},full);
  const before=new Map(full.data);rejects(()=>saveIpFavorite({name:'over',hex},full),'STORAGE_LIMIT');assert.deepEqual(full.data,before);
});
test('quota errors, corrupt schema and large stored values retain original bytes and return actionable error codes',()=>{
  const st=mock(), first=saveIpFavorite({name:'saved',hex:'AB'},st).favorites[0], key=st.calls.find(([k])=>k==='write')[1];
  const old=st.data.get(key);st.setItem=()=>{throw Error('quota');};
  rejects(()=>removeIpFavorite(first.id,st),'STORAGE_UNAVAILABLE');assert.equal(st.data.get(key),old);
  for (const malformed of ['{broken',JSON.stringify({version:2,entries:[]}),JSON.stringify({version:1,entries:[{...first,hex:'odd'}]}),'x'.repeat(530000)]) {
    st.data.set(key,malformed);rejects(()=>saveIpFavorite({name:'b',hex:'00'},st),'STORAGE_INVALID');assert.equal(st.data.get(key),malformed);
  }
});
