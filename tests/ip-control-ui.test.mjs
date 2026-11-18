import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'rolldown/utils';
import * as model from '../src/shared/ipControlModel.js';
import { formatHex } from '../src/shared/serialFormat.js';

const file = name => fs.readFileSync(new URL('../src/' + name, import.meta.url), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const storage = () => { const items = new Map(); return { items, value: null,
  getItem(key) { return items.get(key) ?? null; }, setItem(key, data) { this.value = data; items.set(key, data); } }; };
const view = (status = 'idle', sessionId = '', rest = {}) => ({ ok: true, host: '', port: 0, code: '', entries: [], nextAfter: 0, hasMore: false, status, sessionId, ...rest });
const walk = node => !node || typeof node !== 'object' ? [] : [node, ...(node.props.children || []).flat(Infinity).flatMap(walk)];
const text = node => typeof node === 'string' ? node : node && typeof node === 'object' ? node.props.children.flat(Infinity).map(text).join('') : '';
const theme = { input: '', card: '', textMuted: '', button: { primary: '', secondary: '' } };
function mount(api, saved) {
  let cursor = 0, timer; const slots = [], effects = [], cleanups = [];
  const runtime = { window: { electronAPI: api }, document: { hidden: false, addEventListener() {}, removeEventListener() {} }, ...model, formatHex,
    readEndpoint: (_, mode) => model.readEndpoint(saved, mode), saveEndpoint: (value, _, mode) => model.saveEndpoint(value, saved, mode), useLocale: () => 'zh-CN',
    tr: (str, args = []) => str.replace(/\{(\d+)\}/g, (all, key) => args[key] ?? all), jsx: (type, props, ...children) => ({ type, props: { ...props, children } }),
    lazy: () => 'ProtocolPanel', Suspense: 'Suspense', requestAnimationFrame: () => 1,
    setInterval(fn) { timer = fn; return 1; }, clearInterval() {},
    useEffect(fn) { const i = cursor++; if (!slots[i]) { slots[i] = {}; effects.push(fn); } },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useMemo(fn) { return fn(); },
    useState(initial) { const i = cursor++; const slot = slots[i] ||= { value: typeof initial === 'function' ? initial() : initial };
      return [slot.value, value => { slot.value = typeof value === 'function' ? value(slot.value) : value; }]; },
  };
  for (const name of ['ArrowDownLeft', 'ArrowUpRight', 'CircleAlert', 'Code2', 'Loader2', 'Network', 'Plug', 'Send', 'Unplug']) runtime[name] = 'icon';
  const source = file('components/IpControlPanel.jsx').replace(/^import .+;\r?\n/gm, '').replace('export default function', 'function');
  const fn = vm.runInNewContext(transformSync('IpControlPanel.jsx', source, { jsx: { runtime: 'classic', pragma: 'jsx' } }).code + '\nIpControlPanel', runtime);
  const tree = () => { cursor = 0; const root = fn({ theme, isDark: false }); while (effects.length) cleanups.push(effects.shift()()); return root; };
  const find = (type, predicate = () => true) => walk(tree()).find(node => node.type === type && predicate(node));
  const button = label => find('button', node => text(node) === label);
  const submit = () => find('form').props.onSubmit({ preventDefault() {} });
  const drain = () => new Promise(resolve => setImmediate(resolve));
  return { tree, find, button, submit, drain, poll: () => timer(), dispose() { cleanups.forEach(fn => fn()); } };
}

test('numeric endpoints, byte count and endpoint-only persistence preserve input boundaries', () => {
  const s = storage(); assert.deepEqual(model.readEndpoint(s), { host: '172.20.74.227', port: '8192' });
  for (const host of ['172.20.74.227', '::1', '2001:db8::1']) assert.equal(model.validateEndpoint(host, '8192'), '');
  for (const host of ['999.1.0.1', '010.1.2.3', '127.1', 'server.local', 'http://10.0.0.1', '10.0.0.1:123', '[::1]', '::zz']) assert.equal(model.validateEndpoint(host, 8192), 'INVALID_IP');
  for (const port of ['', '0', '123a', '65536', '123456', '1e2', '1.0']) assert.equal(model.validateEndpoint('10.0.0.1', port), 'INVALID_PORT');
  assert.equal(model.saveEndpoint({ host: ' 192.0.2.1 ', port: '8192', draft: 'PRIVATE' }, s), true);
  assert.deepEqual(model.readEndpoint(s), { host: '192.0.2.1', port: '8192' }); assert.doesNotMatch(s.value, /draft|PRIVATE|connect/i);
  assert.deepEqual(model.inspectHex('0001 FF\r\n0A'), { bytes: 4, code: '' });
  for (const hex of ['0', '0 0', '0xFF', '0A,FF', 'FF GG']) assert.equal(model.inspectHex(hex).code, 'INVALID_HEX');
  assert.equal(model.inspectHex('ab'.repeat(65536)).bytes, 65536); assert.equal(model.inspectHex('ab'.repeat(65537)).code, 'SEND_TOO_LARGE');
});

test('actual controls: no auto-connect; validate, refuse, retry, fill without sending, explicit exact-session send', async () => {
  const saved = storage(), calls = []; let state = view(), fail = true;
  const ui = mount({ ipControlRead: async () => state, ipControlConnect: async ({ host, port }) => {
    calls.push(['connect', host, port]); state = view(fail ? 'error' : 'connected', fail ? 'old' : 'new', { code: fail ? 'REFUSED' : '', host, port }); return fail ? { ok: false, code: 'REFUSED' } : { ok: true };
  }, ipControlSend: async ({ sessionId, hex }) => { calls.push(['send', sessionId, hex]); return { ok: true }; } }, saved);
  ui.tree(); await ui.drain(); assert.deepEqual(calls, []);
  const port = () => ui.find('input', node => node.props.inputMode === 'numeric');
  port().props.onChange({ target: { value: '65536' } }); ui.submit(); assert.equal(port().props['aria-invalid'], true); assert.deepEqual(calls, []);
  port().props.onChange({ target: { value: '8192' } }); ui.submit(); await ui.drain();
  assert.match(text(ui.find('p', n => n.props.role === 'alert')), /拒绝/); assert.equal(port().props.value, '8192'); assert.equal(port().props.disabled, false);
  fail = false; ui.submit(); await ui.drain(); assert.ok(ui.button('断开连接')); assert.equal(port().props.disabled, true);
  ui.button('RS232 协议面板').props.onClick(); assert.equal(ui.find('ProtocolPanel').props.onUse({ hex: '00 FF 08' }), true);
  assert.equal(ui.find('textarea').props.value, '00 FF 08'); assert.equal(calls.length, 2);
  ui.button('发送').props.onClick(); await ui.drain(); assert.deepEqual(calls.at(-1), ['send', 'new', '00 FF 08']);
  ui.dispose();
});

test('pending connection is cancellable and subsequent settlement cannot repaint the UI with an old error', async () => {
  const calls = [], flight = deferred(); let state = view();
  const ui = mount({ ipControlRead: async () => state, ipControlConnect() { state = view('connecting', 'pid', { host: '172.20.74.227', port: 8192 }); return flight.promise; },
    async ipControlDisconnect({ sessionId }) { calls.push(sessionId); state = view('idle', 'pid'); return { ok: true }; } }, storage());
  ui.tree(); await ui.drain(); ui.submit(); await ui.poll();
  const cancel = ui.button('取消连接'); assert.equal(cancel.props.disabled, false); cancel.props.onClick(); await ui.drain();
  flight.resolve({ ok: false, code: 'REFUSED' }); await ui.drain(); assert.deepEqual(calls, ['pid']); assert.ok(ui.button('连接')); assert.equal(ui.find('p', n => n.props.role === 'alert'), undefined);
  ui.dispose();
});

test('display is bounded, avoids duplicates and does not mix session bytes', () => {
  let current = model.mergeIpRead(null, view('connected', 'one', { entries: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, hex: '00' })), nextAfter: 100 }), true);
  current = model.mergeIpRead(current, view('connected', 'one', { entries: [{ id: 100, hex: '00' }, { id: 101, hex: '01' }], nextAfter: 101 }), false);
  assert.equal(current.entries.length, 100); assert.equal(current.entries[0].id, 2); assert.equal(current.omitted, true);
  current = model.mergeIpRead(current, view('connected', 'two', { entries: [{ id: 1, hex: 'FF' }], nextAfter: 1 }), false); assert.deepEqual(current.entries, [{ id: 1, hex: 'FF' }]); assert.equal(current.omitted, false);
});

test('each mode remembers valid inputs on blur without network I/O or saving drafts or invalid edits', async () => {
  const saved = storage(), calls = [];
  saved.setItem('adb-workbench.ip-control.endpoint.v1', '{"version":1,"host":"192.0.2.8","port":8432}');
  const api = { ipControlRead: async () => view(), ipControlConnect: req => calls.push(req) };
  const ui = mount(api, saved); ui.tree(); await ui.drain();
  const host = () => ui.find('input', node => !node.props.inputMode);
  assert.equal(host().props.value, '192.0.2.8'); assert.equal(ui.button('TCP Client').props['aria-pressed'], true);
  ui.button('TCP Server').props.onClick(); assert.equal(host().props.value, '127.0.0.1');
  host().props.onChange({target:{value:'192.0.2.7'}}); host().props.onBlur();
  host().props.onChange({target:{value:'invalid'}}); host().props.onBlur();
  ui.button('UDP').props.onClick(); assert.equal(host().props.value, '172.20.74.227');
  const local = () => ui.find('input', n => n.props.placeholder === '0');
  local().props.onChange({ target: { value: '9010' } }); local().props.onBlur();
  assert.deepEqual(model.readEndpoint(saved, 'tcp-server'), {host:'192.0.2.7', port:'8192'});
  assert.deepEqual(model.readEndpoint(saved, 'udp'), {host:'172.20.74.227',port:'8192', localPort:'9010'});
  assert.deepEqual(model.readEndpoint(saved), {host:'192.0.2.8',port:'8432'});
  assert.deepEqual(calls, []); ui.dispose();
  const reopened = mount(api, saved); reopened.tree(); await reopened.drain();
  const reopenedHost = () => reopened.find('input', node => !node.props.inputMode).props.value;
  assert.equal(reopened.button('TCP Client').props['aria-pressed'], true); assert.equal(reopenedHost(), '192.0.2.8');
  reopened.button('TCP Server').props.onClick(); assert.equal(reopenedHost(), '192.0.2.7');
  reopened.button('UDP').props.onClick(); assert.equal(reopened.find('input', n => n.props.placeholder === '0').props.value,'9010');
  assert.deepEqual(calls, []); reopened.dispose();
});

test('server listens only on explicit submit, waits for peer and binds writes to the currently observed peer', async () => {
  const calls = []; let state = view();
  const ui = mount({ ipControlRead: async () => state,
    ipControlConnect: async args => { calls.push({...args}); state = view('listening', 's', { ...args }); return {ok:true}; },
    ipControlSend: async req => { calls.push({...req}); return {ok:true}; },
    ipControlDisconnect: async req => { calls.push({...req}); state = {...state,status:'idle'}; return {ok:true}; },
  }, storage());
  ui.tree(); await ui.drain(); ui.button('TCP Server').props.onClick(); assert.ok(ui.button('开始监听'));
  assert.deepEqual(calls, []); ui.submit(); await ui.drain();
  assert.deepEqual(calls[0], { mode:'tcp-server',host:'127.0.0.1',port:8192 });
  assert.match(text(ui.tree()), /等待客户端/); ui.find('textarea').props.onChange({target:{value:'F0 00'}});
  assert.equal(ui.button('发送').props.disabled,true); assert.equal(ui.button('UDP').props.disabled,true);
  state = { ...state, status:'connected',peerId:'one',peerHost:'192.0.2.10',peerPort:34901 }; await ui.poll();
  assert.match(text(ui.tree()), /192\.0\.2\.10:34901/); ui.button('发送').props.onClick(); await ui.drain();
  assert.deepEqual(calls[1], {sessionId:'s',peerId:'one',hex:'F0 00'});
  state = { ...state, peerId:'two',peerPort:34902 }; await ui.poll(); ui.button('发送').props.onClick(); await ui.drain();
  assert.equal(calls[2].peerId,'two'); ui.button('停止监听').props.onClick(); await ui.drain(); assert.equal(calls[3].sessionId,'s');
  ui.dispose();
});

test('UDP local port and datagram limits are checked before sending; ready does not claim peer is connected', async () => {
  const calls = []; let state = view();
  const ui = mount({ ipControlRead: async () => state, ipControlConnect: async args => {
    calls.push({...args}); state=view('ready','udp-session',{...args,localPort:42019}); return {ok:true};
  }, ipControlSend: async req => { calls.push({...req}); return {ok:true}; } }, storage());
  ui.tree(); await ui.drain(); ui.button('UDP').props.onClick();
  const local = () => ui.find('input', n => n.props.placeholder === '0');
  local().props.onChange({target:{value:'99999'}}); ui.submit(); assert.equal(local().props['aria-invalid'],true); assert.deepEqual(calls,[]);
  local().props.onChange({target:{value:''}}); ui.submit(); await ui.drain();
  assert.deepEqual(calls[0],{mode:'udp',host:'172.20.74.227',port:8192,localPort:0});
  assert.equal(local().props.value,'42019'); assert.equal(text(ui.find('span',n=>n.props.role==='status')),'UDP 就绪');
  ui.find('textarea').props.onChange({target:{value:'ff'.repeat(65508)}}); assert.equal(ui.button('发送').props.disabled,true); assert.match(text(ui.tree()), /65507/);
  ui.find('textarea').props.onChange({target:{value:'00FF'}}); ui.button('发送').props.onClick(); await ui.drain();
  assert.deepEqual(calls[1],{sessionId:'udp-session',hex:'00FF'}); assert.equal(model.inspectHex('ff'.repeat(65507),'udp').code,''); ui.dispose();
});
