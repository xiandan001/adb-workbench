const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('public startup uses the synchronous locale before first copy and localizes only owned declared nodes', () => {
  const timers = []; const actions = []; const foreign = { textContent: '用户原始中文日志' };
  const node = (id, attributes = {}) => ({ id, dataset: {}, hidden: false, textContent: '',
    getAttribute: key => attributes[key], setAttribute: (key, value) => { attributes[key] = value; },
    removeAttribute() {}, addEventListener() {}, focus() {}, remove() {} });
  const nodes = Object.fromEntries(['app-startup', 'root', 'startup-status', 'startup-detail', 'startup-retry'].map(id => [id, node(id)]));
  const tagline = node('tagline', { 'data-i18n': '连接设备 · 专注调试' });
  nodes['app-startup'].querySelectorAll = () => [tagline]; nodes['app-startup'].querySelector = () => tagline;
  const document = { documentElement: { dataset: {} }, getElementById: id => nodes[id] };
  const window = { electronAPI: { initialLanguage: 'en-US' }, localStorage: { getItem: () => null }, matchMedia: () => ({ matches: false }),
    addEventListener() {}, removeEventListener() {}, location: { reload: () => actions.push('reload') } };
  const context = { window, document, performance: { mark() {} }, setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; }, clearTimeout() {} };
  for (const name of ['startup-preferences.js', 'startup.js']) vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public', name), 'utf8'), context);
  assert.equal(document.documentElement.lang, 'en-US'); assert.equal(nodes['startup-status'].textContent, 'Preparing your workspace');
  assert.equal(nodes['startup-retry'].textContent, 'Try again'); assert.equal(tagline.textContent, 'Connect devices · Focus on debugging');
  timers.find(timer => timer.ms === 6000).callback(); assert.match(nodes['startup-detail'].textContent, /longer than usual/);
  window.__workbenchStartup.fail('用户原文不翻译'); assert.equal(nodes['startup-detail'].textContent, '用户原文不翻译');
  assert.equal(foreign.textContent, '用户原始中文日志'); assert.deepEqual(actions, []);
});
