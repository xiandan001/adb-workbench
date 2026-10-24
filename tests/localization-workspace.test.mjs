import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const directory = new URL('../src/components/', import.meta.url);
const catalog = JSON.parse(fs.readFileSync(new URL('../electron/locales/en-workspace.json', import.meta.url), 'utf8'));
const files = fs.readdirSync(directory).filter(file => file.endsWith('.jsx') && file !== 'LanguagePreferences.jsx');
const source = name => fs.readFileSync(new URL(name, directory), 'utf8');
const tokens = message => [...message.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();

test('workspace translations have complete English copy and unchanged interpolation slots', () => {
  assert.ok(Object.keys(catalog).length > 1800);
  for (const [key, value] of Object.entries(catalog)) {
    assert.equal(typeof value, 'string', key); assert.ok(value.trim(), key);
    assert.deepEqual(tokens(value), tokens(key), key);
    assert.doesNotMatch(value.replaceAll('卓控台', ''), /[\u3400-\u9fff]/, key);
  }
});

test('every explicit component message is catalogued and no parameter is passed as a translation key', () => {
  for (const file of files) {
    const text = source(file); assert.ok(!text.includes('\r'), file);
    let messages = 0;
    traverse(parse(text, { sourceType: 'module', plugins: ['jsx'] }), {
      CallExpression({ node }) {
        if (node.callee.name !== 'tr') return;
        messages++;
        if (node.arguments[0]?.type !== 'StringLiteral') {
          const argument = text.slice(node.arguments[0].start, node.arguments[0].end);
          if (/^(?:error|notice|motionNotice|[a-zA-Z]+Error|[a-zA-Z]+\.error)$/.test(argument) || file === 'LogAnalyzer.jsx' && argument === 'note') return;
          if (['DeviceNavigationControls.jsx', 'DeviceShortcutEditor.jsx'].includes(file) && /^(?:builtin\.label|item\.label|check\.reason|selectedCheck\.reason)$/.test(argument)) return;
          if (file === 'StartupPreferences.jsx' && argument === 'state.message') return;
          if (file === 'GlobalCommandPalette.jsx' && argument === 'command.group') return;
          assert.ok(['TaskCenter.jsx', 'TaskCenterQuickStart.jsx'].includes(file), file);
          assert.match(argument, /^script\.(name|description)$/);
          assert.match(text.slice(Math.max(0, node.start - 130), node.start), /script\.id === 'default-smoke-test' && script\.createdAt === 'builtin' && script\.updatedAt === 'builtin' \? $/);
          return;
        }
        assert.ok(Object.hasOwn(catalog, node.arguments[0].value), `${file}: ${node.arguments[0].value}`);
      },
    });
    if (messages) assert.match(text, /useLocale\(\)/, file);
    assert.doesNotMatch(text, /key=\{(?:locale|getLocale\(\))\}/, file);
  }
});

test('raw terminal, file and feedback content remains outside translation', () => {
  assert.match(source('SerialDataView.jsx'), /: entry\.text/);
  assert.match(source('SerialTerminal.jsx'), /value=\{paste\.content\}/);
  assert.match(source('FeedbackSection.jsx'), /\{report\.preview\.body\}/);
  assert.doesNotMatch(source('FeedbackSection.jsx'), /tr\(report\.(?:draft|preview|issue)\b/);
  assert.match(source('LogEvidence.jsx'), /\{selected\.raw\}/);
});

test('language changes update static options and terminal labels without recreating a connection', () => {
  assert.match(source('SerialConnectionSettings.jsx'), /const STATUS_TEXT = \(\) =>/);
  assert.match(source('SerialPanel.jsx'), /const WORKSPACE_LABELS = \(\) =>/);
  assert.match(source('SerialTerminal.jsx'), /termRef\.current\?\.textarea\?\.setAttribute\('aria-label', tr\("串口终端输入"\)\); \}, \[locale\]\)/);
  assert.match(source('SerialDataView.jsx'), /timeFormats\.get\(getLocale\(\)\)/);
  assert.match(source('SelectMenu.jsx'), /aria-label=\{ariaLabel\}/);
});

test('membership availability and tutorial dismiss behavior use stable values, not translated labels', () => {
  assert.match(source('MemberCenter.jsx'), /const isAvailable = value === true/);
  assert.match(source('MemberCenter.jsx'), /const isUnavailable = value === false/);
  assert.match(source('MemberCenter.jsx'), /plan\.id === selectedPlanId/);
  assert.match(source('TaskCenterOnboarding.jsx'), /dismissMode === 'close'/);
  assert.doesNotMatch(source('TaskCenterOnboarding.jsx'), /dismissLabel ===/);
});

test('only unchanged canonical built-in shortcuts translate; aliases and executable commands remain original', () => {
  const spec = JSON.parse(fs.readFileSync(new URL('../electron/lib/device-shortcuts-spec.json', import.meta.url), 'utf8'));
  for (const file of ['DeviceNavigationControls.jsx', 'DeviceShortcutEditor.jsx']) {
    const text = source(file); let helper;
    traverse(parse(text, { sourceType: 'module', plugins: ['jsx'] }), { FunctionDeclaration({ node }) { if (node.id?.name === 'deviceShortcutDisplayLabel') helper = node; } });
    assert.ok(helper);
    const translate = runInNewContext(`(${text.slice(helper.start, helper.end)})`, { BUILTIN_SHORTCUTS: spec.actions, tr: key => catalog[key] });
    for (const action of spec.actions) {
      assert.ok(catalog[action.label], action.label);
      const original = { type: 'builtin', action: action.id, label: action.label };
      assert.equal(translate(original), catalog[action.label]);
      assert.equal(translate({ ...original, label: '我的操作' }), '我的操作');
      assert.equal(translate({ ...original, type: 'shell' }), action.label);
      assert.deepEqual(original, { type: 'builtin', action: action.id, label: action.label });
    }
  }
  assert.match(source('DeviceNavigationControls.jsx'), /shortcut: action, confirmShell/);
  assert.match(source('DeviceNavigationControls.jsx'), /aria-label=\{displayLabel\}/);
  assert.doesNotMatch(source('DeviceNavigationControls.jsx'), /\/(?:未安装|入口)\//);
  assert.match(source('DeviceShortcutEditor.jsx'), /value=\{slot\.label\}/);
  assert.match(source('DeviceShortcutEditor.jsx'), /BUILTIN_SHORTCUTS\.map\(item => \(\{ value: item\.id, label: tr\(item\.label\) \}\)\)/);
});
