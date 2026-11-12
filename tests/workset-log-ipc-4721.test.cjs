const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createRequire } = require('node:module'), { parse } = require('@babel/parser'), traverse = require('@babel/traverse').default;
const sourceFile = path.resolve(__dirname, '../electron/lib/log-analyzer.cjs'), source = fs.readFileSync(sourceFile, 'utf8');
const ast = parse(source, { sourceType: 'script' }); let normalizer, callback;
traverse(ast, {
  FunctionDeclaration({ node }) { if (node.id?.name === 'normalizeNavigationContext') normalizer = source.slice(node.start, node.end); },
  CallExpression({ node }) { if (node.arguments[0]?.value === 'logAnalyzer:applyContext') callback = source.slice(node.arguments[1].start, node.arguments[1].end); }
});
function fixture() {
  const calls = [], frame = {}, logFrame = {}, main = { isDestroyed: () => false, webContents: { mainFrame: frame } };
  const log = { isDestroyed: () => false, webContents: { mainFrame: logFrame, isLoading: () => false, send: (...args) => calls.push(args) } };
  const normalize = new Function('require', 'tr', `return (${normalizer});`)(createRequire(sourceFile), value => value);
  const api = new Function('ctx', 'normalizeNavigationContext', 'tr', `let navigationContext = null; return { handler: (${callback}), read: () => navigationContext };`)(
    { getMainWindow: () => main, getLogAnalyzerWindow: () => log }, normalize, value => value);
  return { api, calls, main, log, frame, logFrame };
}
test('workset log restoration notifies an existing window without creating, focusing or starting capture', async () => {
  const f = fixture(), context = { deviceId: 'hdc:Board-A', packageName: 'com.demo', worksetLogs: { deviceId: 'hdc:Board-A', filter: { text: 'warning' }, buffers: ['app'] } };
  const response = await f.api.handler({ sender: f.main.webContents, senderFrame: f.frame }, context);
  assert.equal(response.ok, true); assert.deepEqual(f.api.read(), context);
  assert.deepEqual(f.calls, [['logAnalyzer:context', context]]);
});
test('workset log restoration accepts file-only filter metadata but rejects conflicting targets and unknown fields', async () => {
  const f = fixture(), event = { sender: f.main.webContents, senderFrame: f.frame };
  const context = { deviceId: '', packageName: '', worksetLogs: { deviceId: '', filter: { regex: 'error|fatal' }, buffers: ['main'] } };
  assert.equal((await f.api.handler(event, context)).ok, true);
  const previous = f.api.read();
  assert.equal((await f.api.handler(event, { ...context, deviceId: 'another-device' })).ok, false);
  assert.equal((await f.api.handler(event, { ...context, worksetLogs: { ...context.worksetLogs, execute: true } })).ok, false);
  assert.deepEqual(f.api.read(), previous); assert.equal(f.calls.length, 1);
});
test('workset log restoration refuses log window, subframe and destroyed main owners before changing selection', async () => {
  const f = fixture(), context = { deviceId: 'A' };
  for (const event of [{ sender: f.log.webContents, senderFrame: f.logFrame }, { sender: f.main.webContents, senderFrame: {} }, { sender: {}, senderFrame: f.frame }]) assert.equal((await f.api.handler(event, context)).ok, false);
  f.main.isDestroyed = () => true;
  assert.equal((await f.api.handler({ sender: f.main.webContents, senderFrame: f.frame }, context)).ok, false);
  assert.equal(f.api.read(), null); assert.deepEqual(f.calls, []);
});
