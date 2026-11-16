const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const harness = require('./helpers/log-capture-harness.cjs');
function mcp(entries, analysis = () => {}) {
  const file = path.join(__dirname, '../electron/lib/mcp-server.cjs'), realRequire = createRequire(file), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nmodule.exports.callMcpTool = callMcpTool;', { module, console, Buffer, setTimeout, clearTimeout,
    require(name) {
      if (name === './ai-outbound-transport.cjs') return { withOperation: (_options, run) => run() };
      if (name === './app-context.cjs') return {};
      if (name === './ai-analyze.cjs') return { aiKeys: { AI_MAX_LOG_LINES: 10000, AI_MAPREDUCE_THRESHOLD_BYTES: 1, AI_CHUNK_LINES: 1 }, mapReduceAnalyze: analysis };
      if (name === './log-analyzer.cjs') return { getLogStore: () => ({ file: entries }), getCurrentLogSource: () => 'file', getLogcatProc: () => null };
      if (name === './version.cjs') return { getAppVersion: () => 'fixture' };
      if (['./package-manager.cjs', './performance-monitor.cjs', './inspection.cjs', './vip.cjs'].includes(name)) return {};
      return realRequire(name);
    } }, { filename: file });
  return module.exports.callMcpTool;
}
test('packaged legacy log IPC and MCP no longer require renderer src or execute filter regex on main', async () => {
  for (const name of ['log-analyzer.cjs', 'mcp-server.cjs']) assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../electron/lib', name), 'utf8'), /require\(['"]\.\.\/\.\.\/src\/shared\/filter/);
  const entries = [{ id: '1', raw: 'Crash first', level: 'E' }, { id: '2', raw: 'normal', level: 'I' }, { id: '3', raw: 'Crash last', level: 'W' }];
  const h = harness(); h.api.setLogStoreFileEntries(entries); h.api.setCurrentLogSource('file');
  const page = await h.handlers.get('log:filterInMain')(h.event, { source: 'file', filter: { regex: 'Crash' }, offset: 1, limit: 1 });
  assert.equal(page.total, 2); assert.equal(page.entries[0], entries[2]); assert.equal(page.sourceIdentity, h.api.getSourceIdentity());
  const call = mcp(entries), parse = result => JSON.parse(result.content[0].text);
  const filtered = parse(await call('log_filter', { source: 'file', filter: { regex: 'Crash' }, offset: 1, limit: 1 }));
  assert.equal(filtered.total, 2); assert.deepEqual(filtered.lines, ['Crash last']);
  const stats = parse(await call('log_stats', { source: 'file', filter: { regex: 'Crash' } }));
  assert.equal(stats.total, 2); assert.equal(stats.levels.E, 1); assert.equal(stats.levels.W, 1); assert.equal(stats.levels.I, 0);
  await assert.rejects(call('log_filter', { source: 'file', filter: { regex: '[' } }), error => error.code === 'LOG_FILTER_INVALID_REGEX');
});
test('MCP AI preserves the old chronological 10k tail before its unchanged analysis/outbound path', async () => {
  const entries = Array.from({ length: 10005 }, (_, index) => ({ id: String(index), raw: `raw-${index}`, message: `msg-${index}`, ts: 0, pid: 1, tag: 'Tag', level: 'I' }));
  let observed;
  const call = mcp(entries, async lines => { observed = lines; throw Error('fixture stops before any model/transport'); });
  await assert.rejects(call('ai_analyze', { source: 'file' }), /fixture stops before/);
  assert.equal(observed.length, 10000); assert.ok(observed[0].endsWith('msg-5')); assert.ok(observed.at(-1).endsWith('msg-10004'));
});
