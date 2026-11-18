const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createIpControlHistory } = require('../electron/lib/ip-control-history.cjs');

const endpoint = {mode:'tcp-client',host:'127.0.0.1',port:8192};
async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(),'veylo-ip-history-'));
  const filename = path.join(temporary,'history.json');
  t.after(async () => {
    // Remove only the chosen fixture files and the verified, now-empty temp directory.
    for (const item of await fs.readdir(temporary)) { assert.equal(item,'history.json'); await fs.unlink(path.join(temporary,item)); }
    assert.equal(path.dirname(temporary),os.tmpdir()); await fs.rmdir(temporary);
  });
  let time=1000;
  return { filename, history:createIpControlHistory({filename,now:()=>++time}) };
}

test('history preserves the last 20 distinct typed endpoints across reopen and promotes repeated successes', async t => {
  const {filename,history}=await fixture(t); assert.deepEqual(await history.list(),{ok:true,entries:[]});
  await assert.rejects(fs.stat(filename), {code:'ENOENT'});
  for(let i=0;i<25;i++) assert.ok((await history.record({...endpoint,port:8192+i})).ok);
  const old=(await history.list()).entries; assert.equal(old.length,20); assert.equal(old[0].port,8216);
  const promoted=(await history.record({...endpoint,host:' 127.0.0.1 ',port:old[5].port})).entries;
  assert.equal(promoted.length,20); assert.equal(promoted[0].id,old[5].id); assert.ok(promoted[0].lastSuccessAt>old[0].lastSuccessAt);
  for(const item of [{mode:'tcp-server'}, {mode:'udp',localPort:0},{mode:'udp',localPort:8194}])
    await history.record({...endpoint,...item,port:promoted[0].port});
  const first=await history.record({...endpoint,host:'0:0:0:0:0:0:0:1'});
  const second=await history.record({...endpoint,host:'::1'});
  assert.equal(first.entries[0].id,second.entries[0].id); assert.equal(second.entries[0].host,'::1');
  await history.flush(); assert.deepEqual(await createIpControlHistory({filename}).list(),second);
  assert.equal(new Set(second.entries.slice(1,5).map(row=>row.id)).size,4);
  const bytes=await fs.readFile(filename,'utf8'); assert.doesNotMatch(bytes,/sessionId|payload|peerHost|hex|connected|listening/);
  assert.ok(!bytes.includes('\r'));
});

test('ordered remove and clear operate only on persisted entries even while a write is pending',async t=>{
  const {filename,history}=await fixture(t);
  const a=(await history.record(endpoint)).entries[0];
  const addB=history.record({...endpoint,port:1234}), removeA=history.remove({id:a.id}),after=history.list(),clear=history.clear(),restore=history.record({...endpoint,port:99});
  assert.equal((await addB).entries.length,2); assert.deepEqual((await removeA).entries.map(r=>r.port),[1234]); assert.deepEqual((await after).entries.map(r=>r.port),[1234]);
  assert.deepEqual((await clear).entries,[]);assert.deepEqual((await restore).entries.map(r=>r.port),[99]);await history.flush();
  assert.deepEqual((await createIpControlHistory({filename}).list()).entries.map(r=>r.port),[99]);
});

test('bad inputs and corrupted existing data never overwrite stored bytes',async t=>{
  const {filename,history}=await fixture(t);
  for (const value of [{...endpoint,host:'fake'}, {...endpoint,port:0}, {...endpoint,extra:'private'}, {...endpoint,mode:'udp',localPort:70000}])
    assert.equal((await history.record(value)).code,'INVALID_ENDPOINT');
  assert.equal((await history.remove({id:1})).code,'INVALID_ID');
  await assert.rejects(fs.stat(filename), {code:'ENOENT'});
  const valid=(await history.record(endpoint)).entries[0], raws=['{broken',JSON.stringify({version:1,entries:[{...valid,hex:'FF'}]}),'x'.repeat(32769)];
  for (const raw of raws) {
    await fs.writeFile(filename,raw);
    assert.equal((await history.list()).code,'HISTORY_UNAVAILABLE'); assert.equal((await history.clear()).code,'HISTORY_UNAVAILABLE');
    assert.equal((await history.record(endpoint)).code,'HISTORY_UNAVAILABLE'); assert.equal(await fs.readFile(filename,'utf8'),raw);
  }
});

test('a failed atomic rename keeps prior history readable, leaves no temporary file and permits retry',async t=>{
  const {filename,history}=await fixture(t);const expected=await history.record(endpoint);const before=await fs.readFile(filename);
  const failing=createIpControlHistory({filename,io:{...fs,rename:async()=>{throw Object.assign(new Error('test failure'),{code:'EPERM'});}}});
  assert.equal((await failing.record({...endpoint,port:90})).code,'HISTORY_UNAVAILABLE');await failing.flush();
  assert.deepEqual(await fs.readFile(filename),before);assert.deepEqual(await history.list(),expected);
  assert.deepEqual(await fs.readdir(path.dirname(filename)),['history.json']);assert.equal((await history.record({...endpoint,port:90})).ok,true);
});
