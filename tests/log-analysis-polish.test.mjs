import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import { transformSync } from 'rolldown/utils';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snapshots from '../src/shared/logSessionSnapshot.js';
import * as workspace from '../src/shared/logWorkspace.js';
import * as markers from '../src/shared/logMarkers.js';
import * as stream from '../src/shared/logStream.js';
import * as model from '../src/shared/logWorkbenchModel.js';
import { prepareInlineLogAnalysis } from '../src/shared/logInlineAnalysis.js';
import * as analysisHelpers from '../src/shared/logAnalysisState.js';
import { canUseMembershipFeature } from '../src/shared/membershipEntitlements.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixtureRow = (id, raw, deviceId = 'A') => ({ id, raw, message: raw, deviceId, level: 'E', pkg: 'com.fixture', tag: 'A', ts: 1000, receivedAt: 1100, clockBasis: 'source-local' });
function fixture(overrides = {}) {
  const file = new URL('./log-analyzer-ui-actions-4728.test.mjs', import.meta.url), source = fs.readFileSync(file, 'utf8');
  const node = parse(source, { sourceType: 'module', plugins: ['jsx'] }).program.body.find(item => item.type === 'FunctionDeclaration' && item.id.name === 'uiHarness');
  const code = source.slice(node.start, node.end).replaceAll('import.meta.url', JSON.stringify(file.href)).replace('note, logTheme };', 'note, logTheme, aiError, aiAnalyzing, aiCustomPrompt, setAiCustomPrompt, setAiThinkingMode, conversationReady, resetBackendConversation, analysisStates: typeof analysisStates === "undefined" ? [] : analysisStates };');
  const create = vm.runInNewContext(code + '\nuiHarness', { fs, vm, assert, randomUUID, URL, performance, setTimeout, clearTimeout, structuredClone, pause, fixtureRow,
    snapshots, workspace, markers, stream, model, analysisHelpers, prepareInlineLogAnalysis, canUseMembershipFeature });
  const h = create({ aiAnalyzeLog: async () => ({ ok: true }), ...overrides });
  h.enterPrompt = (expression, value) => { const callback = vm.runInNewContext('(' + expression + ')', { setAiCustomPrompt: h.ui().setAiCustomPrompt }); callback(expression === 'setAiCustomPrompt' ? value : { target: { value } }); };
  return h;
}
function prompt(h, value) {
  const source = fs.readFileSync(new URL('../src/components/LogAnalyzer.jsx', import.meta.url), 'utf8'); let expression;
  traverseModule.default(parse(source, { sourceType: 'module', plugins: ['jsx'] }), { JSXAttribute({ node }) {
    if (node.name.name === 'onPromptChange') expression = source.slice(node.value.expression.start, node.value.expression.end);
    else if (node.name.name === 'onChange' && node.value?.type === 'JSXExpressionContainer') {
      const candidate = source.slice(node.value.expression.start, node.value.expression.end);
      if (candidate.includes('setAiCustomPrompt')) expression = candidate;
    }
  } });
  // Exercise the actual public composer callback, not a private hook slot.
  assert.ok(expression); h.enterPrompt(expression, value);
}
async function start(h, id, text = '') {
  if (text) prompt(h, text); await h.drain(); await h.ui().onAiAnalyze(); h.emit('onAiStreamStart', { requestId: id }); await h.drain();
}
const latest = h => h.ui().analysisStates.at(-1);
test('local ACK and waiting-for-confirmation keep the draft and expose an honest phase', async t => {
  const h = fixture(); t.after(h.dispose); await h.mount(); await start(h, 'waiting', 'Keep this question');
  h.emit('onAiOutboundChanged', { operations: [{ id: 'waiting', phase: 'awaiting-confirmation', status: 'running', usage: { sentRequests: 0 } }] }); await h.drain();
  assert.equal(h.ui().aiCustomPrompt, 'Keep this question'); assert.equal(latest(h)?.status, 'awaiting-confirmation');
  assert.equal(h.calls.filter(call => call.method === 'aiAnalyzeLog').length, 1); assert.equal(h.ui().entries[0].raw, 'old raw');
});
for (const outcome of ['cancelled', 'stopped', 'empty', 'failed']) test('actual ' + outcome + ' before a usable answer is explicit, retains the draft and invalidates the retry fingerprint', async t => {
  const h = fixture(); t.after(h.dispose); await h.mount(); await start(h, 'terminal', 'Retain me');
  if (outcome === 'stopped') await h.ui().onAiStop();
  else if (outcome === 'empty') h.emit('onAiStreamEnd', { requestId: 'terminal' });
  else h.emit('onAiOutboundChanged', { operations: [{ id: 'terminal', status: outcome, phase: 'sending', usage: { sentRequests: outcome === 'failed' ? 1 : 0 } }] });
  if (outcome === 'failed') h.emit('onAiStreamError', { requestId: 'terminal', error: 'Synthetic transport failure' });
  else h.emit('onAiStreamEnd', { requestId: 'terminal' });
  await h.drain(); assert.equal(latest(h)?.status, outcome); assert.equal(h.ui().aiCustomPrompt, 'Retain me'); assert.equal(h.ui().aiAnalyzing, false);
  if (outcome === 'failed') assert.match(latest(h).error, /Synthetic transport failure/);
  await h.ui().onAiAnalyze(); const requests = h.calls.filter(call => call.method === 'aiAnalyzeLog'); assert.equal(requests.at(-1).args[0].logChanged, true);
});
test('only a matching usable stream end commits the fingerprint and clears an unchanged draft', async t => {
  const h = fixture(); t.after(h.dispose); await h.mount(); await start(h, 'good', 'Original question');
  h.emit('onAiStreamChunk', { requestId: 'good', type: 'content', text: 'Actual answer' }); h.emit('onAiStreamEnd', { requestId: 'good' }); await h.drain();
  assert.equal(latest(h)?.status, 'completed'); assert.equal(h.ui().aiCustomPrompt, ''); await h.ui().onAiAnalyze();
  assert.equal(h.calls.filter(call => call.method === 'aiAnalyzeLog').at(-1).args[0].logChanged, false);
});
test('edited drafts and previous successful answers survive a later failure', async t => {
  const h = fixture(); t.after(h.dispose); await h.mount(); await start(h, 'good', 'Original'); prompt(h, 'Typed while generating'); await h.drain();
  h.emit('onAiStreamChunk', { requestId: 'good', type: 'content', text: 'Keep the completed answer' }); h.emit('onAiStreamEnd', { requestId: 'good' }); await h.drain(); assert.equal(h.ui().aiCustomPrompt, 'Typed while generating');
  await start(h, 'bad'); h.emit('onAiOutboundChanged', { operations: [{ id: 'bad', status: 'failed', phase: 'sending' }] }); h.emit('onAiStreamError', { requestId: 'bad', error: 'Later failure' }); await h.drain();
  assert.equal(h.ui().aiTurns[0].content, 'Keep the completed answer'); assert.equal(latest(h)?.status, 'failed');
  const source = fs.readFileSync(new URL('../src/components/LogAnalyzer.jsx', import.meta.url), 'utf8'); assert.doesNotMatch(source, /\{aiError\s*\?\s*\(/, 'An error must not replace every previous report');
});

test('whitespace-only edits made during generation are still user edits and survive a successful reply', async t => {
  const h = fixture(); t.after(h.dispose); await h.mount(); await start(h, 'raw-draft', 'Original question');
  prompt(h, 'Original question \n'); await h.drain();
  h.emit('onAiStreamChunk', { requestId: 'raw-draft', type: 'content', text: 'Usable answer' }); h.emit('onAiStreamEnd', { requestId: 'raw-draft' }); await h.drain();
  assert.equal(h.ui().aiCustomPrompt, 'Original question \n');
});

test('an explicit action prompt cannot clear an unrelated composer draft even when its trimmed value matches', async t => {
  const h = fixture(); t.after(h.dispose); await h.mount(); prompt(h, 'Action question'); await h.drain();
  await h.ui().onAiAnalyze('Action question'); h.emit('onAiStreamStart', { requestId: 'action' }); await h.drain();
  h.emit('onAiStreamChunk', { requestId: 'action', type: 'content', text: 'Usable answer' }); h.emit('onAiStreamEnd', { requestId: 'action' }); await h.drain();
  assert.equal(h.ui().aiCustomPrompt, 'Action question');
});
test('completed A then cancelled B cannot omit the changed raw scope on retry', async t => {
  const h = fixture(); t.after(h.dispose); await h.mount(); await start(h, 'A'); h.emit('onAiStreamChunk', { requestId: 'A', type: 'content', text: 'A result' }); h.emit('onAiStreamEnd', { requestId: 'A' }); await h.drain();
  h.emit('onLogAppendBatch', { source: 'realtime', deviceId: 'A', captureId: 'cap-A', sourceIdentity: 'source-A', entries: [fixtureRow('new', 'new raw B')] }); await pause(120); await h.drain(); h.ui().changeText('new raw B'); await pause(300); await h.drain();
  await start(h, 'B'); h.emit('onAiOutboundChanged', { operations: [{ id: 'B', status: 'cancelled', phase: 'awaiting-confirmation' }] }); await h.drain(); await h.ui().onAiAnalyze();
  const requests = h.calls.filter(call => call.method === 'aiAnalyzeLog'); assert.equal(requests.at(-1).args[0].logChanged, true); assert.match(requests.at(-1).args[0].lines[0], /new raw B/);
});
test('unrelated operations and unknown localized stages cannot change this request phase', async t => {
  const h = fixture(); t.after(h.dispose); await h.mount(); await start(h, 'owned');
  h.emit('onAiOutboundChanged', { operations: [{ id: 'other-diagnostic', phase: 'sending', status: 'failed' }, { id: 'owned', phase: 'unknown', stage: '正在发送已确认的 AI 请求', status: 'running' }] }); await h.drain();
  assert.equal(latest(h).status, 'preparing'); h.emit('onAiOutboundChanged', { operations: [{ id: 'owned', phase: 'awaiting-confirmation', status: 'running' }] }); await h.drain(); assert.equal(latest(h).status, 'awaiting-confirmation');
  h.emit('onAiOutboundChanged', { operations: [{ id: 'owned', phase: 'sending', status: 'running', usage: { sentRequests: 1 } }] }); await h.drain(); assert.equal(latest(h).status, 'sending');
  h.emit('onAiStreamChunk', { requestId: 'owned', type: 'reasoning', text: 'Only reasoning' });
  h.emit('onAiOutboundChanged', { operations: [{ id: 'owned', phase: 'awaiting-confirmation', status: 'running', usage: { sentRequests: 1 } }] }); await h.drain(); assert.equal(latest(h).status, 'awaiting-confirmation');
  h.emit('onAiStreamEnd', { requestId: 'owned' }); await h.drain(); assert.equal(latest(h).status, 'empty');
});
test('partial output is flushed on failure and a newer attempt cannot receive an older buffered flush', async t => {
  const h = fixture(); t.after(h.dispose); await h.mount(); await start(h, 'old'); h.emit('onAiStreamChunk', { requestId: 'old', type: 'content', text: 'Partial original' });
  h.emit('onAiOutboundChanged', { operations: [{ id: 'old', status: 'failed', phase: 'sending' }] }); await h.drain(); assert.equal(h.ui().aiTurns[0].content, 'Partial original');
  await start(h, 'new'); h.emit('onAiStreamChunk', { requestId: 'new', type: 'content', text: 'New original' }); h.emit('onAiStreamError', { requestId: 'old', error: 'Late old failure' }); await pause(90); await h.drain();
  assert.equal(h.ui().aiTurns[0].content, 'Partial original'); assert.equal(h.ui().aiTurns[1].content, 'New original'); assert.equal(latest(h).status, 'responding');
});
test('source restoration fences late output and presentation state is never stored in a snapshot', async t => {
  const h = fixture(); t.after(h.dispose); await h.mount(); await start(h, 'old');
  const snapshot = h.ui().getSnapshot(); assert.equal(Object.hasOwn(snapshot, 'analysisStates'), false); assert.equal(Object.hasOwn(snapshot.aiTurns[0], 'status'), false);
  h.ui().restoreSession({ name: 'C', source: 'file', sourceLabel: 'C.log', deviceId: '', entries: [fixtureRow('C', 'C raw', '')], filter: {}, buffers: [], evidence: [], markers: [], aiTurns: [], truncated: false }, { sourceIdentity: 'source-C' }); await h.drain();
  h.emit('onAiOutboundChanged', { operations: [{ id: 'old', status: 'failed', phase: 'sending' }] }); h.emit('onAiStreamChunk', { requestId: 'old', type: 'content', text: 'Wrong source' }); h.emit('onAiStreamEnd', { requestId: 'old' }); await h.drain();
  assert.equal(h.ui().entries[0].raw, 'C raw'); assert.equal(h.ui().aiTurns.length, 0); assert.equal(h.ui().analysisStates.length, 0);
});
test('stopping is coalesced and cannot submit a replacement request before its acknowledgement', async t => {
  let stopped; const h = fixture({ aiStopAnalyze: () => new Promise(resolve => { stopped = resolve; }) }); t.after(h.dispose); await h.mount(); await start(h, 'old');
  const first = h.ui().onAiStop(), second = h.ui().onAiStop(); await h.drain(); assert.equal(latest(h).status, 'stopping'); await h.ui().onAiAnalyze();
  assert.equal(h.calls.filter(call => call.method === 'aiStopAnalyze').length, 1); assert.equal(h.calls.filter(call => call.method === 'aiAnalyzeLog').length, 1);
  stopped({ ok: true }); await Promise.all([first, second]); await h.drain(); assert.equal(latest(h).status, 'stopped');
});
test('a failed local context reset keeps an explicit recovery action and cannot submit or erase the draft', async t => {
  let resets = 0; const h = fixture({ aiClearConversation: async () => ++resets === 1 ? { ok: false, error: 'Synthetic reset failure' } : { ok: true } }); t.after(h.dispose); await h.mount();
  prompt(h, 'Keep for recovery'); await h.drain(); await h.ui().onAiAnalyze(); await h.drain(); assert.equal(latest(h).status, 'failed'); assert.equal(h.ui().conversationReady, false); assert.equal(h.ui().aiCustomPrompt, 'Keep for recovery'); assert.equal(h.calls.some(call => call.method === 'aiAnalyzeLog'), false);
  await h.ui().resetBackendConversation(); await h.drain(); assert.equal(h.ui().conversationReady, true); await h.ui().onAiAnalyze(); assert.equal(h.calls.filter(call => call.method === 'aiAnalyzeLog').length, 1);
  assert.match(fs.readFileSync(new URL('../src/components/LogAnalyzer.jsx', import.meta.url), 'utf8'), /aiError && \(!conversationReady \|\|/);
});
test('actual legacy transport and gate cancellation keep zero sends, followed by one newly confirmed usable result', async t => {
  const url = new URL('./ai-legacy-consent.test.cjs', import.meta.url), source = fs.readFileSync(url, 'utf8'), require = createRequire(url);
  const node = parse(source, { sourceType: 'script' }).program.body.find(item => item.type === 'FunctionDeclaration' && item.id.name === 'fixture');
  const until = async predicate => { for (let index = 0; index < 300; index++) { if (predicate()) return; await pause(1); } assert.fail('Real gate fixture did not settle'); };
  const create = vm.runInNewContext(source.slice(node.start, node.end) + '\nfixture', { require, fs, path, vm, assert, EventEmitter, Buffer, AbortController, URL, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask,
    __dirname: path.dirname(fileURLToPath(url)), until, createOutboundTransport: require('../electron/lib/ai-outbound-transport.cjs').createOutboundTransport, prepareBatch: require('../electron/lib/ai-outbound-policy.cjs').prepareBatch });
  const real = create(), invoke = (channel, args) => real.handlers.get(channel)(real.event, args);
  const h = fixture({ aiAnalyzeLog: args => invoke('ai:analyzeLog', args), aiClearConversation: () => invoke('ai:clearConversation'), aiStopAnalyze: () => invoke('ai:stopAnalyze') });
  t.after(async () => { h.dispose(); await real.transport.cleanup(); }); const send = real.owner.send;
  const channels = { 'ai-outbound:changed': 'onAiOutboundChanged', 'ai:streamStart': 'onAiStreamStart', 'ai:streamChunk': 'onAiStreamChunk', 'ai:streamEnd': 'onAiStreamEnd', 'ai:streamError': 'onAiStreamError' };
  real.owner.send = (channel, payload) => { send(channel, payload); if (channels[channel]) h.emit(channels[channel], payload); };
  await h.mount(); prompt(h, 'token=polish-private'); await h.drain(); await h.ui().onAiAnalyze(); let preview = await real.pending(); await h.drain(); assert.equal(latest(h).status, 'awaiting-confirmation'); assert.equal(real.calls.length, 0);
  await real.decide(preview, 'cancel'); await h.drain(); assert.equal(latest(h).status, 'cancelled'); assert.equal(real.calls.length, 0); assert.equal(h.ui().aiCustomPrompt, 'token=polish-private');
  await h.ui().onAiAnalyze(); preview = await real.pending(); assert.equal(real.calls.length, 0); await real.decide(preview); await until(() => real.events.some(event => event.channel === 'ai:streamEnd' && event.payload.requestId === preview.operationId)); await h.drain();
  assert.equal(real.calls.length, 1); assert.equal(latest(h).status, 'completed'); assert.equal(h.ui().aiCustomPrompt, ''); assert.equal(h.ui().aiTurns.at(-1).content, 'fixture streamed answer'); assert.equal(JSON.stringify(real.calls).includes('polish-private'), false);
  assert.equal(JSON.stringify([...h.profiles]).includes('polish-private'), false);
});
function descendants(node) { return !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(descendants)]; }
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : !node || typeof node !== 'object' ? '' : [node.props?.children].flat(Infinity).map(text).join(' ');
function component(file, name, props) {
  const url = new URL('./log-ai-folds.test.mjs', import.meta.url), source = fs.readFileSync(url, 'utf8');
  const node = parse(source, { sourceType: 'module' }).program.body.find(item => item.type === 'FunctionDeclaration' && item.id.name === 'componentHarness');
  const code = source.slice(node.start, node.end).replaceAll('import.meta.url', JSON.stringify(url.href)).replace("Fragment: 'fragment',", "...analysisHelpers, Fragment: 'fragment',").replace("AlertTriangle: 'icon',", "CheckCircle2: 'icon', Clock3: 'icon', RotateCcw: 'icon', TriangleAlert: 'icon', StopCircle: 'icon', AlertTriangle: 'icon',");
  return vm.runInNewContext(code + '\ncomponentHarness', { fs, vm, URL, transformSync, analysisHelpers, descendants, text, tick: () => pause(0) })(file, name, props);
}
test('composer editing and both mode buttons never submit; Enter, Shift+Enter and IME use real callbacks', async t => {
  const edits = [], modes = []; let submits = 0;
  const h = component('LogAnalysisComposer.jsx', 'LogAnalysisComposer', { value: '', thinking: false, onPromptChange: value => edits.push(value), onThinkingChange: value => modes.push(value), onSubmit: () => submits++, onStop() {}, theme: { input: '', button: { primary: '' } } }); t.after(h.dispose); await h.drain();
  const area = () => descendants(h.tree()).find(node => node.type === 'textarea'), mode = label => descendants(h.tree()).find(node => node.type === 'button' && text(node) === label);
  assert.equal(area().props.maxLength, 4000); area().props.onChange({ target: { value: 'One\nTwo' } }); mode('快速').props.onClick(); mode('思考').props.onClick(); assert.deepEqual(edits, ['One\nTwo']); assert.deepEqual(modes, [false, true]); assert.equal(submits, 0);
  let prevented = 0; const enter = fields => area().props.onKeyDown({ key: 'Enter', preventDefault() { prevented++; }, ...fields });
  enter({ shiftKey: true }); enter({ isComposing: true }); enter({ nativeEvent: { isComposing: true } }); enter({ keyCode: 229 }); area().props.onCompositionStart(); enter({}); area().props.onCompositionEnd(); assert.equal(submits, 0);
  enter({}); assert.equal(submits, 1); assert.equal(prevented, 1); h.setProps({ busy: true }); await h.drain(); enter({}); assert.equal(submits, 1);
});
test('empty and cancelled turn components always explain the result instead of rendering only a timestamp', async t => {
  for (const state of [undefined, { status: 'empty' }, { status: 'cancelled', sentRequests: 0 }, { status: 'stopped' }, { status: 'failed', error: 'Synthetic failure' }]) {
    const h = component('LogAnalysisStatus.jsx', 'LogAnalysisStatus', { state }); t.after(h.dispose); await h.drain(); assert.ok(text(h.tree()).length > 12);
    if (state?.status === 'cancelled') assert.match(text(h.tree()), /没有发送给 AI/);
    if (state === undefined) assert.match(text(h.tree()), /没有保存的分析回复/);
  }
});
test('actual mode binding preserves the backend boolean without auto-submitting and duplicate starts are coalesced', async t => {
  const h = fixture(); t.after(h.dispose); await h.mount();
  const source = fs.readFileSync(new URL('../src/components/LogAnalyzer.jsx', import.meta.url), 'utf8'); let expression;
  traverseModule.default(parse(source, { sourceType: 'module', plugins: ['jsx'] }), { JSXAttribute({ node }) { if (node.name.name === 'onThinkingChange') expression = source.slice(node.value.expression.start, node.value.expression.end); } });
  assert.ok(expression); vm.runInNewContext('(' + expression + ')', { setAiThinkingMode: h.ui().setAiThinkingMode })(true); await h.drain(); assert.equal(h.calls.some(call => call.method === 'aiAnalyzeLog'), false);
  await Promise.all([h.ui().onAiAnalyze(), h.ui().onAiAnalyze()]); const requests = h.calls.filter(call => call.method === 'aiAnalyzeLog'); assert.equal(requests.length, 1); assert.equal(requests[0].args[0].thinkingMode, true);
});
test('oversize prompt is preserved and rejected locally, and retired request identities stay bounded', async t => {
  const h = fixture(); t.after(h.dispose); await h.mount(); prompt(h, 'x'.repeat(4001)); await h.drain(); await h.ui().onAiAnalyze(); await h.drain();
  assert.equal(h.ui().aiCustomPrompt.length, 4001); assert.equal(h.calls.some(call => call.method === 'aiAnalyzeLog'), false); assert.match(h.ui().note, /4,000/);
  const operation = { retired: new Set() }; for (let index = 0; index < 100; index++) analysisHelpers.retireLogAnalysisRequest(operation, String(index)); assert.equal(operation.retired.size, 32);
});
test('the actual header prioritizes confirmation/preparation over map counters and never calls waiting an active analysis', () => {
  const source = fs.readFileSync(new URL('../src/components/LogAnalyzer.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('{/* AI Panel Header */}'), end = source.indexOf('{(() => {', start), header = source.slice(start, end);
  assert.ok(header.indexOf("status === 'awaiting-confirmation'") < header.indexOf(': mapReduceProgress'));
  assert.ok(header.includes("status === 'preparing'")); assert.ok(header.includes("status === 'stopping'")); assert.ok(header.includes("status === 'responding'")); assert.equal(header.includes('tr("分析中…")'), false);
});
