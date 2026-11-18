import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'rolldown/utils';
import * as commands from '../src/shared/ipControlCommands.js';
import { formatHex } from '../src/shared/serialFormat.js';

const theme = { button:{ secondary:'' }, textMuted:'', input:'' };
const pause = () => new Promise(resolve=>setImmediate(resolve));
const deferred = () => { let resolve; const promise=new Promise(done=>{resolve=done;}); return { promise,resolve }; };
const nodes = x => !x || typeof x !== 'object' ? [] : [x,...(x.props.children || []).flat(Infinity).flatMap(nodes)];
const text = x => typeof x === 'string' || typeof x === 'number' ? String(x) : !x || typeof x !== 'object' ? '' : x.props.children.flat(Infinity).map(text).join('');
function mount(name, extra, properties) {
  let pos=0, props=properties; const slots=[],effects=[];
  const runtime={ ...extra, React:{Fragment:'fragment'}, formatHex, useLocale:()=> 'zh-CN', useId:()=> 'qa', useMemo:fn=>fn(),
    tr:(s,params={})=>s.replace(/\{(\d+)\}/g,(all,key)=>params[key]??all),
    jsx:(type, attrs,...children)=>({type,props:{...attrs,children}}),useRef:x=>slots[pos++] ||= {current:x},
    useState(x){const slot=slots[pos++] ||= {value:typeof x==='function'?x():x};return [slot.value,v=>{slot.value=typeof v==='function'?v(slot.value):v;}];},
    useEffect(fn,deps){const slot=slots[pos++] ||= {}; if(slot.deps?.length===deps.length&&deps.every((v,i)=>slot.deps[i]===v))return;slot.deps=deps;effects.push(()=>{slot.cleanup?.();slot.cleanup=fn();});},
  };
  for(const icon of ['ChevronDown','ArrowRight','Clock','History','Pencil','Plus','Star','Trash2','X','Pause','Play','Save']) runtime[icon]='icon';
  const src=fs.readFileSync(new URL('../src/components/'+name+'.jsx',import.meta.url),'utf8').replace(/^import .+;\r?\n/gm,'').replace('export default function','function');
  const fn=vm.runInNewContext(transformSync(name+'.jsx',src,{jsx:{runtime:'classic',pragma:'jsx',pragmaFrag:'"fragment"'}}).code+'\n'+name,runtime);
  function draw(){pos=0;const tree=fn(props);while(effects.length)effects.shift()();return tree;}
  const find=(type,match)=>nodes(draw()).find(n=>n.type===type&&(!match||match(n)));
  const button=label=>find('button',n=>(n.props['aria-label']||text(n))===label);
  return {draw,find,button,props(next){props={...props,...next};},dispose(){slots.forEach(slot=>slot.cleanup?.());}};
}

test('traffic actions snapshot session and epoch, cancel silently, prevent double submission and retire stale owners', async()=>{
  const saves=[],clears=[],reset=[],toasts=[],save=deferred(),clear=deferred();
  const api={ipControlSaveRecords:async value=>{saves.push({...value});return save.promise;},ipControlClearRecords:async value=>{clears.push({...value});return clear.promise;}};
  const ui=mount('IpControlRecordControls',{window:{electronAPI:api}},{theme,view:{sessionId:'IP-A',recordEpoch:9},
    disabled:true,onCleared:(ref,epoch)=>reset.push([{...ref},epoch]),showToast:message=>toasts.push(message)});
  ui.draw();assert.ok(ui.button('保存当前记录').props.disabled);assert.ok(ui.button('清空记录').props.disabled);
  ui.props({disabled:false});const startSave=ui.button('保存当前记录').props.onClick;
  startSave();startSave();assert.deepEqual(saves,[{sessionId:'IP-A',recordEpoch:9}]);assert.ok(ui.button('清空记录').props.disabled);
  save.resolve({ok:true,cancelled:true});await pause();assert.deepEqual(toasts,[]);assert.deepEqual(clears,[]);
  ui.button('清空记录').props.onClick();const stale=ui.button('确认清空').props.onClick;ui.button('取消').props.onClick();stale();assert.deepEqual(clears,[]);
  ui.button('清空记录').props.onClick();const submit=ui.button('确认清空').props.onClick;submit();submit();assert.deepEqual(clears,[{sessionId:'IP-A',recordEpoch:9}]);
  ui.dispose();clear.resolve({ok:true,recordEpoch:10});await pause();startSave();submit();assert.deepEqual(reset,[]);assert.equal(saves.length,1);
});

test('record clear rejects stale scopes without changing the view and only acknowledges a successful new epoch', async()=>{
  const reset=[],results=[{ok:false,code:'STALE_RECORDS'},{ok:true,recordEpoch:3}];
  const ui=mount('IpControlRecordControls',{window:{electronAPI:{ipControlClearRecords:async()=>results.shift()}}},{theme,
    view:{sessionId:'s',recordEpoch:2},onCleared:(ref,next)=>reset.push([{...ref},next])});
  ui.draw();ui.button('清空记录').props.onClick();ui.button('确认清空').props.onClick();await pause();
  assert.match(text(ui.find('p',node=>node.props.role==='alert')),/收发记录已变化/);assert.deepEqual(reset,[]);
  ui.button('清空记录').props.onClick();ui.button('确认清空').props.onClick();await pause();
  assert.deepEqual(reset,[[{sessionId:'s',recordEpoch:2},3]]);ui.dispose();
});

test('history modal ignores stale reads, only current enabled row starts once; dismiss, clear and delete make no network calls', async()=>{
  const first=deferred(), calls=[], starts=[], item={id:'1',mode:'udp',host:'192.0.2.1',port:8192,localPort:123,lastSuccessAt:123};
  let reads=0, rows=[item], confirm=false, clears=0;
  const api={ipControlHistory:()=>++reads===1?first.promise:Promise.resolve({ok:true,entries:rows}),
    ipControlRemoveHistory:args=>{calls.push({...args});return {ok:false};},ipControlClearHistory:()=>{clears++;rows=[];return {ok:true,entries:[]};}};
  const ui=mount('IpControlHistory',{window:{electronAPI:api},confirmAppMessage:async()=>confirm,trapAppMessageFocus(){}},{
    theme,locked:false,revision:0,onConnect:e=>{starts.push(e);return true;}, modeName:m=>m,displayAddress:(h,p)=>h+':'+p});
  ui.draw();assert.equal(ui.button('连接历史').props['aria-expanded'],false);
  ui.props({revision:1}); ui.draw(); await pause();first.resolve({ok:true,entries:[]});await pause();
  assert.match(text(ui.button('连接历史')), /1/);
  ui.button('连接历史').props.onClick();ui.draw();await pause();assert.equal(ui.button('连接历史').props['aria-expanded'],true);
  const row=()=>ui.button('使用 udp：192.0.2.1:8192');assert.ok(row());assert.match(text(row()),/123/);assert.equal(ui.button('连接历史').props['aria-haspopup'],'dialog');
  ui.props({locked:true});assert.equal(row().props.disabled,true);row().props.onClick();assert.deepEqual(starts,[]);
  ui.props({locked:false});const staleRow=row().props.onClick;
  ui.find('dialog').props.onCancel({preventDefault(){}});assert.equal(ui.find('dialog'),undefined);assert.deepEqual(starts,[]);
  ui.button('连接历史').props.onClick();ui.draw();await pause();staleRow();assert.deepEqual(starts,[]);
  const start=row().props.onClick;start();start();assert.deepEqual(starts,[item]);assert.deepEqual(calls,[]);assert.equal(ui.find('dialog'),undefined);
  ui.button('连接历史').props.onClick();ui.draw();await pause();await ui.button('移除 udp：192.0.2.1:8192').props.onClick();await pause();
  assert.deepEqual(calls,[{id:'1'}]);assert.ok(row());assert.match(text(ui.draw()), /原记录已保留/);
  ui.button('清除连接历史').props.onClick();await pause();assert.equal(clears,0);confirm=true;ui.button('清除连接历史').props.onClick();await pause();
  assert.equal(clears,1);assert.match(text(ui.draw()),/暂无成功连接记录/);assert.deepEqual(starts,[item]);ui.dispose();
});

test('dedicated command library: add, rename without replacing bytes, fill only, delete, cancel and confirm history clear',async()=>{
  const raw=new Map([['adb-workbench.serial-preferences.v1','PRIVATE-COM-FAVORITES'],['adb-workbench.serial-history.v1','PRIVATE-COM-SEND']]);
  const storage={getItem:k=>raw.get(k)??null,setItem:(k,v)=>raw.set(k,v)}, fills=[];
  const addHistory=()=>commands.appendIpSendHistory({host:'192.0.2.1',port:8192,hex:'00ff',mode:'tcp-client'},storage);
  let confirm=false;
  const ui=mount('IpControlSavedCommands',{readIpCommands:()=>commands.readIpCommands(storage),saveIpFavorite:req=>commands.saveIpFavorite({...req},storage),
    removeIpFavorite:id=>commands.removeIpFavorite(id,storage),removeIpSendHistory:id=>commands.removeIpSendHistory(id,storage),clearIpSendHistory:()=>commands.clearIpSendHistory(storage),
    confirmAppMessage:async()=>confirm},{theme,draft:'ABCD',revision:0,onFill:hex=>fills.push(hex)});
  assert.equal(ui.button('常用命令 / 发送历史').props['aria-expanded'],false);ui.button('常用命令 / 发送历史').props.onClick();
  ui.find('input').props.onChange({target:{value:'TEST'}});ui.find('form').props.onSubmit({preventDefault(){}});
  assert.equal(commands.readIpCommands(storage).favorites[0].hex,'ABCD');
  ui.button('编辑常用命令 TEST').props.onClick();ui.props({draft:'EF00'});ui.find('input').props.onChange({target:{value:'RENAMED'}});ui.find('form').props.onSubmit({preventDefault(){}});
  assert.equal(commands.readIpCommands(storage).favorites[0].name,'RENAMED');assert.equal(commands.readIpCommands(storage).favorites[0].hex,'ABCD');
  ui.find('button',n=>n.props.title==='仅回填，不发送'&&text(n).includes('RENAMED')).props.onClick();assert.deepEqual(fills,['ABCD']);
  addHistory();ui.props({revision:1});
  ui.find('button',n=>n.props.title==='仅回填，不发送'&&text(n).includes('192.0.2.1')).props.onClick();assert.deepEqual(fills,['ABCD','00FF']);
  ui.button('删除发送记录').props.onClick();assert.equal(commands.readIpCommands(storage).history.length,0);addHistory();ui.props({revision:2});
  await ui.button('清空发送历史').props.onClick();assert.equal(commands.readIpCommands(storage).history.length,1);confirm=true;await ui.button('清空发送历史').props.onClick();
  assert.equal(commands.readIpCommands(storage).history.length,0);assert.equal(commands.readIpCommands(storage).favorites.length,1);
  ui.button('删除常用命令 RENAMED').props.onClick();assert.equal(commands.readIpCommands(storage).favorites.length,0);
  assert.equal(raw.get('adb-workbench.serial-preferences.v1'),'PRIVATE-COM-FAVORITES');assert.equal(raw.get('adb-workbench.serial-history.v1'),'PRIVATE-COM-SEND');ui.dispose();
});
