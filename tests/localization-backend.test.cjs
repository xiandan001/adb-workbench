const test = require('node:test');
const assert = require('node:assert/strict');
const { tr, getLocale, setLocale, withLocale, scopeIpc, onLocaleChanged, windowArguments, createLocalizationService } = require('../electron/lib/localization.cjs');

function harness(overrides = {}) {
  const calls = []; const handlers = new Map();
  const window = () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, mainFrame: {}, send: (...args) => calls.push(args) } });
  const main = window(); const analyzer = window();
  const service = createLocalizationService({ readSettings: async () => ({}), writeSettingsPatch: async patch => calls.push(['save', patch]),
    getMainWindow: () => main, getWindows: () => [main, analyzer], ...overrides });
  service.register({ on: (channel, handler) => handlers.set(channel, handler), handle: (channel, handler) => handlers.set(channel, handler) });
  return { service, calls, handlers, main, analyzer, event: window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame }) };
}

test('locale defaults to Chinese, validates exactly, interpolates values without translating them', () => {
  setLocale('zh-CN'); assert.equal(getLocale(), 'zh-CN');
  assert.equal(tr('语言已切换为 {0}', { 0: '保存' }, 'en-US'), 'Language changed to 保存');
  assert.equal(tr('原始设备日志 {0}', { 0: '中文输入' }, 'en-US'), '原始设备日志 中文输入');
  assert.equal(tr('保留 {0} {1}', { 0: '$&' }), '保留 $& {1}');
  assert.throws(() => setLocale('en'), /界面语言/);
  setLocale('en-US'); assert.deepEqual(windowArguments(), ['--app-language=en-US']); setLocale('zh-CN');
});

test('initialize restores language; successful persistence precedes broadcasts to both windows', async () => {
  setLocale('zh-CN'); const h = harness({ readSettings: async () => ({ locale: 'en-US' }) });
  await h.service.initialize(); assert.equal(getLocale(), 'en-US');
  const response = await h.handlers.get('language:set')(h.event(h.main), { locale: 'zh-CN' });
  assert.deepEqual(response, { success: true, locale: 'zh-CN' });
  assert.deepEqual(h.calls, [['save', { locale: 'zh-CN' }], ['language:changed', { locale: 'zh-CN' }], ['language:changed', { locale: 'zh-CN' }]]);
});

test('other window, subframe, malformed arguments and analyzer writes never mutate settings', async () => {
  setLocale('zh-CN'); const h = harness();
  const events = [h.event(h.analyzer), { sender: {}, senderFrame: {} }, { sender: h.main.webContents, senderFrame: {} }];
  for (const event of events) assert.equal((await h.handlers.get('language:set')(event, { locale: 'en-US' })).success, false);
  for (const value of [null, 'en-US', { locale: 'en' }, { locale: 'en-US', extra: true }]) assert.equal((await h.handlers.get('language:set')(h.event(h.main), value)).success, false);
  assert.equal((await h.handlers.get('language:get')(h.event(h.analyzer))).locale, 'zh-CN');
  assert.equal((await h.handlers.get('language:get')({ sender: {}, senderFrame: {} })).success, false);
  assert.deepEqual(h.calls, []);
});

test('synchronous initial locale reads memory only and rejects foreign frames or extra arguments', () => {
  setLocale('en-US'); const h = harness({ readSettings: () => { throw new Error('No disk reads'); } });
  const read = h.handlers.get('language:initial');
  for (const window of [h.main, h.analyzer]) { const event = h.event(window); read(event); assert.deepEqual(event.returnValue, { locale: 'en-US' }); }
  for (const event of [{ sender: {}, senderFrame: {} }, { sender: h.main.webContents, senderFrame: {} }]) { read(event); assert.equal(event.returnValue, null); }
  const event = h.event(h.main); read(event, { locale: 'zh-CN' }); assert.equal(event.returnValue, null);
  assert.deepEqual(h.calls, []); setLocale('zh-CN');
});

test('failed save preserves locale and does not broadcast or expose filesystem errors', async () => {
  setLocale('zh-CN'); const h = harness({ writeSettingsPatch: async () => { throw new Error('secret path'); } });
  const result = await h.handlers.get('language:set')(h.event(h.main), { locale: 'en-US' });
  assert.equal(result.success, false); assert.doesNotMatch(result.error.message, /secret/);
  assert.equal(getLocale(), 'zh-CN'); assert.deepEqual(h.calls, []);
});

test('queued language changes remain ordered and closed owners cannot write', async () => {
  setLocale('zh-CN'); let release; let count = 0;
  const h = harness({ writeSettingsPatch: async () => { if (++count === 1) await new Promise(resolve => { release = resolve; }); } });
  const first = h.handlers.get('language:set')(h.event(h.main), { locale: 'en-US' });
  await new Promise(resolve => setImmediate(resolve));
  const second = h.handlers.get('language:set')(h.event(h.main), { locale: 'zh-CN' });
  h.main.isDestroyed = () => true; release();
  assert.equal((await first).success, true); assert.equal((await second).success, false);
  assert.equal(count, 1); assert.equal(getLocale(), 'en-US'); setLocale('zh-CN');
});

test('migration preserves the selected language, rejects invalid locales, and does not invent missing values', () => {
  const { sanitizeFile } = require('../electron/lib/data-migration-policy.cjs');
  assert.deepEqual(sanitizeFile('settings.json', { locale: 'en-US' }), { locale: 'en-US' });
  assert.deepEqual(sanitizeFile('settings.json', {}), {});
  for (const locale of ['en', '', null, {}, 1]) assert.throws(() => sanitizeFile('settings.json', { locale }));
});

test('preload has synchronous initial locale and payload-only language listeners', () => {
  const fs = require('node:fs'); const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../electron/preload.cjs'), 'utf8');
  let api; let listener; const calls = [];
  const ipcRenderer = { invoke: (...args) => { calls.push(args); }, on: (_name, handler) => { listener = handler; }, off: (...args) => calls.push(args) };
  vm.runInNewContext(source, { process: { argv: ['--app-language=en-US'] }, require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld: (_key, value) => { api = value; } } }) });
  assert.equal(api.initialLanguage, 'en-US'); api.languageSet({ locale: 'zh-CN' });
  assert.equal(calls[0][0], 'language:set'); let value;
  const off = api.onLanguageChanged(payload => { value = payload; });
  listener({ secret: true }, { locale: 'zh-CN' }); assert.deepEqual(value, { locale: 'zh-CN' }); off();
  assert.equal(calls[1][0], 'language:changed');
});

test('same-window reload gets the latest main-process locale instead of stale argv', () => {
  const fs = require('node:fs'); const vm = require('node:vm'); let api;
  vm.runInNewContext(fs.readFileSync(require.resolve('../electron/preload.cjs'), 'utf8'), {
    process: { argv: ['--app-language=zh-CN'] }, require: () => ({ ipcRenderer: { sendSync: channel => { assert.equal(channel, 'language:initial'); return { locale: 'en-US' }; } },
      contextBridge: { exposeInMainWorld: (_key, value) => { api = value; } } }),
  });
  assert.equal(api.initialLanguage, 'en-US'); assert.equal(api.sendSync, undefined);
});

test('new AI requests use the chosen output language without rewriting saved answers or user content', () => {
  const { analysisMessages } = require('../electron/lib/analysis-language.cjs');
  const history = [{ role: 'system', content: '旧系统指令' }, { role: 'user', content: '原始日志：中文值' }, { role: 'assistant', content: '既有中文回答' }];
  const before = structuredClone(history); const prompt = '用户自定义问题：不要修改';
  const english = withLocale('en-US', () => analysisMessages('Trusted instructions', history, prompt));
  assert.match(english[0].content, /Respond in English/); assert.equal(english.at(-1).content, prompt);
  assert.deepEqual(english.slice(1, -1), history.slice(1)); assert.deepEqual(history, before);
  const chinese = withLocale('zh-CN', () => analysisMessages('当前系统指令', history, prompt));
  assert.match(chinese[0].content, /简体中文/); assert.deepEqual(history, before);
});

test('concurrent asynchronous operations retain their own locale without changing raw values', async () => {
  setLocale('zh-CN'); const raw = '用户原始命令：显示日志'; let release;
  const delayed = withLocale('en-US', async () => { await new Promise(resolve => { release = resolve; }); return { text: tr('名称'), raw }; });
  assert.equal(tr('名称'), '名称'); setLocale('zh-CN'); release();
  assert.deepEqual(await delayed, { text: 'Name', raw });
  const handlers = new Map(); const ipc = { handle(name, callback) { handlers.set(name, callback); }, marker() { return this === ipc; } };
  const scoped = scopeIpc(ipc); assert.equal(scoped.marker(), true);
  scoped.handle('test', async value => { await new Promise(resolve => setImmediate(resolve)); return [tr('模型'), value]; });
  setLocale('en-US'); const response = handlers.get('test')(raw); setLocale('zh-CN');
  assert.deepEqual(await response, ['Model', raw]);
});

test('native menu relabels existing roles and preserves hidden main/menu-free analyzer behavior', () => {
  const { installApplicationMenu } = require('../electron/lib/application-menu.cjs');
  const templates = []; const visibility = []; const analyzerMenus = [];
  const dispose = installApplicationMenu({ Menu: { buildFromTemplate: value => { templates.push(value); return value; }, setApplicationMenu() {} },
    platform: 'win32', getMainWindow: () => ({ isDestroyed: () => false, setMenuBarVisibility: value => visibility.push(value) }),
    getLogAnalyzerWindow: () => ({ isDestroyed: () => false, setMenu: value => analyzerMenus.push(value) }) });
  setLocale('en-US'); assert.equal(templates.at(-1)[0].label, 'File');
  assert.ok(templates.at(-1).flatMap(item => item.submenu).some(item => item.role === 'reload'));
  assert.ok(templates.at(-1).flatMap(item => item.submenu).some(item => item.role === 'quit'));
  assert.ok(visibility.every(value => value === false)); assert.ok(analyzerMenus.every(value => value === null));
  dispose(); const length = templates.length; setLocale('zh-CN'); assert.equal(templates.length, length);
});

test('locale listeners see the newly saved language while an in-flight report retains its original scope', () => {
  let observed; const off = onLocaleChanged(() => { observed = [getLocale(), tr('名称')]; });
  withLocale('zh-CN', () => { setLocale('en-US'); assert.equal(tr('名称'), '名称'); });
  assert.deepEqual(observed, ['en-US', 'Name']); off(); setLocale('zh-CN');
});

test('English validation retains protocol values and raw user input', () => {
  const { encodeMessage } = require('../electron/lib/serial-policy.cjs');
  withLocale('en-US', () => {
    assert.throws(() => encodeMessage({ mode: 'ascii', content: '中文', lineEnding: 'none' }), /ASCII.*Character 1/);
    assert.deepEqual(encodeMessage({ mode: 'hex', content: 'ab050adf4e', lineEnding: 'none' }), Buffer.from('ab050adf4e', 'hex'));
    assert.deepEqual(encodeMessage({ mode: 'text', content: '中文\t\u0003', lineEnding: 'none' }), Buffer.from('中文\t\u0003'));
  });
});

test('English serial reports translate headings while preserving text, HEX, paths and session identifiers', () => {
  const { formatSerialSnapshot } = require('../electron/lib/serial-export.cjs');
  const text = '保存'; const hex = Buffer.from(text).toString('hex');
  const snapshot = { workspace: 'terminal', rxBytes: 6, txBytes: 0, evicted: 0, entries: [{
    time: 0, path: 'COM17', direction: 'RX', bytes: 6, sessionId: '原始会话',
    config: { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' }, hex, text,
  }] };
  const before = structuredClone(snapshot);
  const report = withLocale('en-US', () => formatSerialSnapshot(snapshot));
  assert.match(report, /Export scope:/); assert.match(report, /Current.*records/);
  assert.ok(report.includes('COM17')); assert.ok(report.includes('原始会话')); assert.ok(report.includes('TEXT: "保存"'));
  assert.ok(report.includes('E4 BF 9D E5 AD 98')); assert.deepEqual(snapshot, before);
});

test('fixed system startup ownership remains identical in both languages', () => {
  const { LOGIN_ITEM_NAME } = require('../electron/lib/startup-settings-policy.cjs');
  assert.equal(withLocale('en-US', () => LOGIN_ITEM_NAME), '卓控台');
  assert.equal(withLocale('zh-CN', () => LOGIN_ITEM_NAME), '卓控台');
});
