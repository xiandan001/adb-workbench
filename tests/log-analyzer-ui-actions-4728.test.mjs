import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import { advanceLogAiRevision, buildLogClipboardText, freezeLogSessionSnapshot, logDocumentKey, logListPreview } from '../src/shared/logSessionSnapshot.js';
import * as snapshots from '../src/shared/logSessionSnapshot.js';
import * as workspace from '../src/shared/logWorkspace.js';
import * as markers from '../src/shared/logMarkers.js';
import * as stream from '../src/shared/logStream.js';
import * as model from '../src/shared/logWorkbenchModel.js';
import { prepareInlineLogAnalysis } from '../src/shared/logInlineAnalysis.js';
import * as analysisHelpers from '../src/shared/logAnalysisState.js';

test('same-length changed AI text, reasoning or evidence ref is dirty without putting the answer in uiRevision', () => {
  const turn = { header: 'same header', content: 'secret-A', reasoning: 'think-A', evidenceRefs: ['L1'] };
  let version = advanceLogAiRevision(null, [turn]);
  const document = { documentId: 'document', entries: [], markers: [], aiTurns: [turn], filter: {}, buffers: ['main'], timeRange: { kind: 'all' } };
  const first = logDocumentKey({ ...document, aiRevision: version.revision });
  version = advanceLogAiRevision(version, [{ ...turn, reasoningExpanded: true }]); assert.equal(logDocumentKey({ ...document, aiRevision: version.revision }), first);
  version = advanceLogAiRevision(version, [{ ...turn, content: 'secret-B' }]); const second = logDocumentKey({ ...document, aiRevision: version.revision }); assert.notEqual(second, first);
  version = advanceLogAiRevision(version, [{ ...turn, content: 'secret-B', reasoning: 'think-B' }]); assert.notEqual(logDocumentKey({ ...document, aiRevision: version.revision }), second);
  const before = version.revision; version = advanceLogAiRevision(version, [{ ...turn, content: 'secret-B', reasoning: 'think-B', evidenceRefs: ['L2'] }]); assert.ok(version.revision > before);
  assert.equal(first.includes('secret-A'), false); assert.equal(second.includes('secret-B'), false);
  const snapshot = freezeLogSessionSnapshot({ ...document, source: 'file', evidence: [], truncated: false, aiRevision: version.revision }); assert.equal(snapshot.aiRevision, version.revision);
});
test('bounded list previews do not rewrite raw text or split a Unicode surrogate pair', () => {
  const raw = 'x'.repeat(2047) + '😀' + 'z'.repeat(1000000), result = logListPreview(raw);
  assert.ok(result.text.length <= 2049); assert.equal(result.text.includes('\uFFFD'), false); assert.equal(result.truncated, true); assert.ok(raw.endsWith('z'.repeat(100)));
});
test('clipboard builds original raw records in yielding batches and rejects oversize rather than copying a partial log', async () => {
  let yields = 0; const rows = Array.from({ length: 1200 }, (_, id) => ({ id, raw: `raw ${id}\r\n原文` }));
  assert.equal(await buildLogClipboardText(rows, { yieldTask: async () => yields++ }), rows.map(row => row.raw).join('\n')); assert.ok(yields >= 2);
  await assert.rejects(buildLogClipboardText([{ raw: '超'.repeat(100) }], { maxBytes: 200 }), /8 MiB/); assert.equal(rows[0].raw, 'raw 0\r\n原文');
});
test('the actual advanced PID input callback accepts decimal digits and rejects malformed/out-of-range values', () => {
  const source = fs.readFileSync(new URL('../src/components/LogAnalyzer.jsx', import.meta.url), 'utf8'); let handler;
  traverseModule.default(parse(source, { sourceType: 'module', plugins: ['jsx'] }), { JSXAttribute(path) {
    if (path.node.name.name !== 'onChange' || path.node.value?.type !== 'JSXExpressionContainer') return;
    const expression = path.node.value.expression, text = source.slice(expression.start, expression.end);
    if (text.includes("field === 'pid'")) handler = text;
  } });
  assert.ok(handler); let filter = { pkg: 'com.existing' };
  const input = new Function('field', 'setFilter', `return (${handler})`)('pid', update => { filter = update(filter); });
  input({ target: { value: '123' } }); assert.equal(filter.pid, 123); assert.equal(filter.pkg, 'com.existing');
  for (const value of ['', '12x', '-1', '2147483648', '999999999999999999999999']) { input({ target: { value } }); assert.equal(filter.pid, undefined); }
});

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixtureRow = (id, raw, deviceId = 'A') => ({ id, raw, message: raw, deviceId, level: 'E', pkg: 'com.fixture', tag: 'A', ts: 1000, receivedAt: 1100, clockBasis: 'source-local' });
function uiHarness(overrides = {}, visibleWindow, { engineError = '' } = {}) {
  const slots = [], listeners = new Map(), calls = [], clipboard = [], profiles = new Map(), effects = [], layouts = [], timers = new Set();
  let cursor = 0, changed = false, rendered, props = { theme: { primary: 'tech', button: { primary: '' } } }, closeProps;
  let state = { source: 'realtime', deviceId: 'A', captureId: 'cap-A', sourceIdentity: 'source-A', sourceLabel: 'Device A', running: false, buffers: ['main'], entries: [fixtureRow('old', 'old raw')], truncated: false };
  let nextId = 0, profileRevision = 0, readerRevision = -1, forTarget;
  const key = (device, source) => JSON.stringify([device, source]);
  const view = (device, source) => profiles.get(key(device, source)) || { sidebarOpen: false, aiPanelHeight: 440, detailWrap: true, colWidths: { ts: 140, pkg: 100, tag: 100 }, filter: {}, buffers: ['main'], hasSavedView: false };
  const updateProfile = (device, source, field, value) => { const previous = view(device, source), next = typeof value === 'function' ? value(previous[field]) : value; if (JSON.stringify(previous[field]) === JSON.stringify(next)) return; profiles.set(key(device, source), { ...previous, [field]: next, hasSavedView: true }); profileRevision++; changed = true; };
  let preferenceDevice = '', preferenceSource = 'realtime';
  const setField = (field, value) => updateProfile(preferenceDevice, preferenceSource, field, value);
  const setTargetField = (device, source, field, value) => updateProfile(device, source, field, value);
  const archive = { enabled: false, maxBytes: 512 * 1048576 };
  const retryPreferences = () => {};
  const emit = (name, payload) => { for (const listener of listeners.get(name) || []) listener(structuredClone(payload)); };
  const handlers = {
    adbListDevices: async () => [{ id: 'A', model: 'A', status: 'device' }, { id: 'B', model: 'B', status: 'device' }],
    logGetState: async () => structuredClone(state), mcpGetInfo: async () => ({ running: false, port: 49321 }), vipGetStatus: async () => ({ activated: true }),
    autoDiagnoseStatus: async () => ({ ok: true, enabled: true }), autoDiagnoseRulesList: async () => ({ ok: true, rules: [] }), logAnalyzerGetContext: async () => null,
    aiClearConversation: async () => ({ ok: true }), aiStopAnalyze: async () => ({ ok: true }), aiGetContextUsage: async () => ({ ok: true, percent: 0 }),
    smartSearchStop: async () => ({ ok: true }),
    logSessionSave: async args => ({ ok: true, session: { id: randomUUID(), name: args.name, entryCount: args.entries.length } }),
    adbStartLog: async args => { state = { ...state, source: 'realtime', sourceLabel: 'Device ' + args.deviceId, captureId: 'cap-' + args.deviceId, sourceIdentity: 'source-' + args.deviceId, deviceId: args.deviceId, running: true, buffers: args.buffers || args.types || [], entries: [] }; emit('onLogReset', { ...state, reason: 'capture-started' }); return { ok: true, captureId: state.captureId, sourceIdentity: state.sourceIdentity, buffers: state.buffers }; },
    adbStopLog: async () => { state = { ...state, running: false }; return { ok: true }; },
    logOpenFile: async () => ({ ok: true, requestId: 'import-1', filePath: 'PRIVATE/fixture.log' }), logCancelImport: async () => ({ ok: true, cancelled: true }),
    logClear: async () => { state = { ...state, sourceIdentity: 'cleared-' + ++nextId, entries: [] }; emit('onLogReset', { ...state, reason: 'cleared' }); return { ok: true, sourceIdentity: state.sourceIdentity }; },
    logClearDevice: async () => ({ ok: true }), ...overrides,
  };
  const api = new Proxy({}, { get(_target, name) {
    if (name.startsWith('on')) return callback => { const set = listeners.get(name) || new Set(); set.add(callback); listeners.set(name, set); return () => set.delete(callback); };
    if (!Object.hasOwn(handlers, name)) return undefined;
    return (...args) => { calls.push({ method: name, args: structuredClone(args) }); return handlers[name](...args); };
  } });
  const equal = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const effect = queue => (fn, deps) => { const index = cursor++, slot = slots[index] || (slots[index] = {}); if (deps && equal(slot.deps, deps)) return; slot.deps = deps; queue.push(() => { slot.cleanup?.(); slot.cleanup = fn(); }); };
  const text = fs.readFileSync(new URL('../src/components/LogAnalyzer.jsx', import.meta.url), 'utf8');
  const cut = text.indexOf('  return (\n    <div className='); assert.ok(cut > 0);
  const prefix = text.slice(0, cut).replace(/^import .+;\r?\n/gm, '').replace('export default function LogAnalyzer', 'function LogAnalyzer');
  const statusHook = fs.readFileSync(new URL('../src/shared/useMembershipStatus.js', import.meta.url), 'utf8')
    .replace(/^import .+;\r?\n/gm, '').replace('export default function useMembershipStatus', 'function useMembershipStatus');
  const component = vm.runInNewContext(statusHook + '\n' + prefix + '\nreturn { showVipBlock, returnFromMembership, activateMembership, membershipOrigin, aiCustomPrompt, setAiCustomPrompt, onStart, onStop, stopCaptureAndImport, onOpenFile, cancelImport, onClear, clearDeviceBuffers, onCopyAll, togglePause, onAiAnalyze, onAiStop, onAiClear, onSmartSearch, onSmartSearchStop, restoreSession, getSnapshot, sessionSaved, configureDevice, toggleBuffer, applyContext, changeText, filter, buffers, scopeBuffers, captureDeviceId, deviceId, entries, filtered, aiTurns, aiHistoryReadOnly, hasUnsaved, documentId, sourceIdentity, importState, source, note, logTheme }; }\nLogAnalyzer', {
    ...snapshots, ...workspace, ...markers, ...stream, ...model, ...analysisHelpers, prepareInlineLogAnalysis,
    crypto: { randomUUID }, window: { electronAPI: api, addEventListener() {}, removeEventListener() {}, innerHeight: 900 },
    document: { addEventListener() {}, removeEventListener() {}, body: { style: {} } }, navigator: { clipboard: { writeText: async value => clipboard.push(value) } }, performance,
    setTimeout, clearTimeout, requestAnimationFrame: callback => { const timer = setTimeout(() => callback(performance.now()), 0); timers.add(timer); return timer; }, cancelAnimationFrame: clearTimeout,
    tr: (value, values = {}) => String(value).replace(/\{(\d+)\}/g, (token, index) => values[index] ?? token), getLocale: () => 'zh-CN', useLocale: () => 'zh-CN', isDarkTheme: value => value.primary === 'tech',
    showAppMessage: async () => ({ response: 2 }), confirmAppMessage: async () => true,
    useState(initial) { const index = cursor++; if (!slots[index]) { const slot = { value: typeof initial === 'function' ? initial() : initial }; slot.setter = value => { const next = typeof value === 'function' ? value(slot.value) : value; if (!Object.is(next, slot.value)) { slot.value = next; changed = true; } }; slots[index] = slot; } return [slots[index].value, slots[index].setter]; },
    useRef(initial) { const index = cursor++; if (!slots[index]) slots[index] = { current: initial }; return slots[index]; },
    useMemo(fn, deps) { const index = cursor++, slot = slots[index]; if (slot && equal(slot.deps, deps)) return slot.value; const value = fn(); slots[index] = { value, deps }; return value; },
    useCallback(fn, deps) { const index = cursor++, slot = slots[index]; if (slot && equal(slot.deps, deps)) return slot.value; slots[index] = { value: fn, deps }; return fn; },
    useEffect: effect(effects), useLayoutEffect: effect(layouts), useDeferredValue: value => value,
    useLogWorksetMemory: () => ({ error: '', saving: false, retry() {} }),
    useLogViewPreferences(device, source) { preferenceDevice = device; preferenceSource = source; const value = view(device, source); if (readerRevision !== profileRevision) { readerRevision = profileRevision; const current = new Map(profiles); forTarget = (selectedDevice, selectedSource) => current.get(key(selectedDevice, selectedSource)) || { ...view('', 'realtime'), hasSavedView: false }; } return { view: value, hasSavedView: value.hasSavedView, forTarget, setTargetField, setField, archive, setArchive() {}, retry: retryPreferences, error: '' }; },
    useLogViewEngine(options) { const rows = visibleWindow || options.entries, index = model.createLogViewIndex(); index.sync({ reset: true, upsertRows: rows }); const result = index.query({ filter: options.filter, timeRange: options.timeRange, rules: options.rules }); const lookup = new Map(rows.map(row => [row.id, row])); return { ...result, rows: result.ids.map(id => lookup.get(id)), windowRows: rows, issues: [], error: engineError, selectionPending: false, pending: false, pendingCount: 0, cancel() {}, retry() {} }; },
    useLogCloseProtection(value) { closeProps = value; return { request: null, approved: false, save() {}, resolve() {} }; },
  });
  function render() { cursor = 0; rendered = component(props); for (const callback of layouts.splice(0)) callback(); return rendered; }
  async function drain() { for (let index = 0; index < 20; index++) { changed = false; render(); for (const callback of effects.splice(0)) callback(); await pause(0); if (!changed && !effects.length) { render(); return rendered; } } throw new Error('UI harness did not settle'); }
  return { calls, clipboard, profiles, emit, render, drain, async mount() { return drain(); }, ui: () => rendered, setState(value) { state = value; }, setProps(value) { props = { ...props, ...value }; }, closeProps: () => closeProps,
    dispose() { for (const slot of slots) slot?.cleanup?.(); for (const timer of timers) clearTimeout(timer); } };
}

test('actual start callback reads B configuration while existing A source/filter stays bound until start reset', async t => {
  const h = uiHarness(); t.after(h.dispose); h.profiles.set(JSON.stringify(['B', 'realtime']), { sidebarOpen: false, aiPanelHeight: 440, detailWrap: true, colWidths: { ts: 140, pkg: 100, tag: 100 }, filter: { pkg: 'com.B' }, buffers: ['radio'], hasSavedView: true });
  h.profiles.set(JSON.stringify(['A', 'realtime']), { sidebarOpen: false, aiPanelHeight: 440, detailWrap: true, colWidths: { ts: 140, pkg: 100, tag: 100 }, filter: { tag: 'A' }, buffers: ['main'], hasSavedView: true });
  await h.mount(); assert.equal(h.ui().filter.tag, 'A'); h.ui().configureDevice('B'); await h.drain(); assert.equal(h.ui().captureDeviceId, 'A'); assert.equal(h.ui().deviceId, 'B'); assert.equal(h.ui().filter.tag, 'A');
  assert.equal(h.calls.filter(call => call.method === 'adbStartLog').length, 0); await h.ui().onStart(); await h.drain();
  const request = h.calls.find(call => call.method === 'adbStartLog').args[0]; assert.equal(request.deviceId, 'B'); assert.deepEqual(request.buffers, ['radio']); assert.equal(request.archive.enabled, false);
  assert.equal(h.ui().captureDeviceId, 'B'); assert.equal(h.ui().filter.pkg, 'com.B');
});
test('preference callback identity changes cannot rehydrate A or retarget the prepared B capture', async t => {
  const h = uiHarness(); t.after(h.dispose); await h.mount();
  h.ui().configureDevice('B'); await h.drain(); const initialReads = h.calls.filter(call => call.method === 'logGetState').length;
  assert.equal(h.ui().deviceId, 'B'); h.ui().toggleBuffer('radio'); await h.drain();
  assert.equal(h.ui().deviceId, 'B'); assert.equal(h.ui().captureDeviceId, 'A'); assert.equal(h.ui().entries[0].raw, 'old raw');
  assert.equal(h.calls.filter(call => call.method === 'logGetState').length, initialReads, 'Metadata writes must not restart the source subscription/hydration');
  assert.equal(h.calls.filter(call => call.method === 'logAnalyzerGetContext').length, 1, 'Metadata writes must not reapply a stale inbound context');
  await h.ui().onStart(); await h.drain(); const request = h.calls.find(call => call.method === 'adbStartLog').args[0];
  assert.equal(request.deviceId, 'B'); assert.deepEqual(request.buffers, ['main', 'radio']);
});
test('actual import callback keeps the old view until matching commit and rejects a cancelled late reset', async t => {
  const h = uiHarness(); t.after(h.dispose); await h.mount(); const old = h.ui().entries[0].raw;
  await h.ui().onOpenFile(); await h.drain(); assert.equal(h.ui().source, 'realtime'); assert.equal(h.ui().entries[0].raw, old);
  await h.ui().cancelImport(); h.emit('onLogReset', { source: 'file', reason: 'import-completed', requestId: 'import-1', sourceIdentity: 'late-file', entries: [fixtureRow('late', 'should not replace', '')] }); await h.drain();
  assert.equal(h.ui().entries[0].raw, old); assert.equal(h.ui().sourceIdentity, 'source-A');
});
test('actual inline callback sends the bounded frozen raw scope through legacy IPC only and ignores late old-source chunks', async t => {
  let finish;
  const h = uiHarness({ aiAnalyzeLog: () => new Promise(resolve => { finish = resolve; }) }); t.after(h.dispose); await h.mount();
  const pending = h.ui().onAiAnalyze('question'); await pause(0); await h.drain(); const sent = h.calls.find(call => call.method === 'aiAnalyzeLog'); assert.ok(sent); assert.equal(sent.args[0].lines[0], '[L1] old raw');
  h.emit('onAiStreamStart', { requestId: 'old-request' }); h.emit('onAiStreamChunk', { requestId: 'old-request', text: 'partial', type: 'content' }); await pause(80); await h.drain();
  h.ui().restoreSession({ name: 'saved C', source: 'file', sourceLabel: 'C.log', deviceId: '', entries: [fixtureRow('c', 'C原文', '')], filter: {}, buffers: [], evidence: [], markers: [], aiTurns: [{ header: 'saved', content: 'historic', reasoning: '', evidenceRefs: [] }], truncated: false }, { sourceIdentity: 'source-C' }); await h.drain();
  h.emit('onAiStreamChunk', { requestId: 'old-request', text: 'LATE', type: 'content' }); h.emit('onAiStreamEnd', { requestId: 'old-request' }); finish({ ok: true }); await pending; await pause(80); await h.drain();
  assert.equal(h.ui().aiTurns[0].content, 'historic'); assert.equal(h.ui().aiHistoryReadOnly, true); assert.equal(h.ui().sourceIdentity, 'source-C');
});
test('membership activation and cancellation preserve the actual log window, selected device and AI draft', async t => {
  const h = uiHarness({ vipGetStatus: async () => ({ activated: false }) }); t.after(h.dispose); await h.mount();
  h.ui().setAiCustomPrompt('draft on A'); await h.drain();
  const { documentId, sourceIdentity } = h.ui();
  h.calls.length = 0;
  await h.ui().onAiAnalyze(); await h.drain();
  assert.equal(h.ui().membershipOrigin.deviceId, 'A');
  h.ui().applyContext({ deviceId: 'B', packageName: 'com.other' }); await h.drain();
  h.ui().returnFromMembership(); await h.drain();
  assert.equal(h.ui().membershipOrigin, null);
  await h.ui().onAiAnalyze(); await h.drain();
  h.ui().activateMembership({ activated: false }); await h.drain();
  assert.equal(h.ui().membershipOrigin.deviceId, 'A');
  h.ui().activateMembership({ activated: true, scope: 'vip' }); await h.drain();
  assert.equal(h.ui().membershipOrigin, null);
  assert.equal(h.ui().aiCustomPrompt, 'draft on A');
  assert.equal(h.ui().deviceId, 'A');
  assert.equal(h.ui().documentId, documentId);
  assert.equal(h.ui().sourceIdentity, sourceIdentity);
  assert.deepEqual(h.calls.map(value => value.method), ['vipGetStatus', 'vipGetStatus']);
});
test('actual local clear never invokes device clear and clipboard preserves original raw text', async t => {
  const h = uiHarness(); t.after(h.dispose); await h.mount(); await h.ui().onCopyAll(); assert.deepEqual(h.clipboard, ['old raw']); await h.ui().onClear(); await h.drain(); assert.equal(h.calls.filter(call => call.method === 'logClear').length, 1); assert.equal(h.calls.filter(call => call.method === 'logClearDevice').length, 0);
  assert.equal(h.ui().entries.length, 0);
});
test('actual snapshot uses the displayed full window, not newer ingress, and cannot incorrectly mark it all saved', async t => {
  const shown = fixtureRow('shown', 'frozen shown'), newer = fixtureRow('newer', 'new ingress');
  const h = uiHarness({ logGetState: async () => ({ source: 'realtime', deviceId: 'A', captureId: 'cap-A', sourceIdentity: 'source-A', running: true, buffers: ['main'], entries: [shown, newer], truncated: false }) }, [shown]); t.after(h.dispose);
  await h.mount(); const snapshot = h.ui().getSnapshot('loaded'); assert.deepEqual(snapshot.entries.map(row => row.id), ['shown']); assert.equal(snapshot.sourceIdentity, 'source-A');
  h.ui().sessionSaved(snapshot); await h.drain(); assert.equal(h.ui().hasUnsaved, true); assert.equal(h.calls.some(call => call.method === 'adbStopLog'), false);
});
test('actual copy callback rejects an oversized whole-record selection before writing the clipboard', async t => {
  const h = uiHarness(); t.after(h.dispose); await h.mount();
  const entry = fixtureRow('large', 'x'.repeat(8 * 1024 * 1024 + 1), '');
  h.ui().restoreSession({ name: 'large', source: 'file', sourceLabel: 'large.log', deviceId: '', entries: [entry], filter: {}, buffers: [], evidence: [], markers: [], aiTurns: [], truncated: false }, { sourceIdentity: 'large-source' }); await h.drain();
  await h.ui().onCopyAll(); await h.drain(); assert.equal(h.clipboard.length, 0); assert.match(h.ui().note, /8 MiB/);
});
test('the actual loaded-snapshot callback protects the first failed query without changing paused or last-good windows', async t => {
  const h = uiHarness({}, [], { engineError: 'isolated regex timed out' }); t.after(h.dispose); await h.mount();
  assert.equal(h.ui().entries.length, 1); assert.equal(h.ui().getSnapshot('loaded').entries[0].raw, 'old raw', 'An unpaused first-query failure cannot save an empty loaded session');
  assert.equal(h.ui().getSnapshot('filtered').entries.length, 0, 'The failed filter must not pretend to match all rows');
  h.ui().togglePause(); await h.drain(); assert.equal(h.ui().getSnapshot('loaded').entries.length, 0, 'An explicit paused empty window must never borrow live ingress');
  const shown = fixtureRow('shown', 'frozen good'), newer = fixtureRow('newer', 'new ingress');
  const good = uiHarness({ logGetState: async () => ({ source: 'realtime', deviceId: 'A', captureId: 'cap-A', sourceIdentity: 'source-A', running: false, buffers: ['main'], entries: [shown, newer], truncated: false }) }, [shown], { engineError: 'new regex timed out' }); t.after(good.dispose); await good.mount();
  assert.deepEqual(good.ui().getSnapshot('loaded').entries.map(row => row.id), ['shown'], 'A nonempty last-good window remains authoritative');
});
test('actual advanced/detail card themes explicitly provide readable foregrounds in both palettes', async t => {
  const h = uiHarness(); t.after(h.dispose); await h.mount(); assert.match(h.ui().logTheme.card, /text-slate-100/);
  h.setProps({ theme: { primary: 'default', button: { primary: '' } } }); await h.drain(); assert.match(h.ui().logTheme.card, /text-slate-800/);
});
test('actual hydrate, ingress and reset callbacks keep the loaded snapshot within the shared byte budget', async t => {
  const raw = 'x'.repeat(1024 * 1024), largeRow = id => ({ ...fixtureRow(id, raw), level: 'I' }), initial = Array.from({ length: 96 }, (_, index) => largeRow('initial-' + index));
  const h = uiHarness({ logGetState: async () => ({ source: 'realtime', deviceId: 'A', captureId: 'cap-A', sourceIdentity: 'source-A', running: false, buffers: ['main'], entries: initial, truncated: false }) }); t.after(h.dispose);
  await h.mount(); assert.equal(h.ui().entries.length, 96);
  h.emit('onLogAppendBatch', { source: 'realtime', deviceId: 'A', captureId: 'cap-A', sourceIdentity: 'source-A', entries: Array.from({ length: 32 }, (_, index) => largeRow('burst-' + index)) });
  await pause(120); await h.drain(); assert.equal(h.ui().entries.length, 100); assert.equal(h.ui().entries.at(-1).id, 'burst-31');
  const snapshot = h.ui().getSnapshot('loaded'); assert.equal(snapshot.entries.length, 100); assert.equal(snapshot.truncated, true);
  h.emit('onLogReset', { source: 'realtime', deviceId: 'A', captureId: 'cap-A', sourceIdentity: 'reset-A', entries: initial.concat(Array.from({ length: 32 }, (_, index) => largeRow('reset-' + index))), reason: 'cleared', truncated: false });
  await h.drain(); assert.equal(h.ui().entries.length, 100); assert.equal(h.ui().entries.at(-1).id, 'reset-31'); assert.equal(h.ui().getSnapshot('loaded').truncated, true);
});
