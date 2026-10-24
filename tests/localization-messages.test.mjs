import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageTranslator } from '../src/shared/messageCatalog.js';
import { tr as applicationMessage } from '../src/shared/i18n.js';

test('interpolation preserves user values and supports reordered parameters', () => {
  const tr = createMessageTranslator([['{0}，剩余 {1} 项', '{1} items remaining for {0}'], ['在线', 'Online']]);
  assert.equal(tr('{0}，剩余 {1} 项', { 0: '在线', 1: 3 }, 'en-US'), '3 items remaining for 在线');
  assert.equal(tr('{0}，剩余 {1} 项', { 0: '用户 {2}', 1: 0 }, 'en-US'), '0 items remaining for 用户 {2}');
});

test('known retained messages change language without replacing interpolated original text', () => {
  const tr = createMessageTranslator([['已保存 {0}', 'Saved {0}']]);
  const chinese = tr('已保存 {0}', { 0: '我的日志.txt' });
  assert.equal(tr(chinese, {}, 'en-US'), 'Saved 我的日志.txt');
  assert.equal(tr('Saved 我的日志.txt'), '已保存 我的日志.txt');
});

test('unknown content and repeated multiline parameters remain original', () => {
  const tr = createMessageTranslator([['名称 {0} / {0}', 'Name {0} / {0}']]);
  assert.equal(tr('真实日志：设备正在连接', {}, 'en-US'), '真实日志：设备正在连接');
  assert.equal(tr('名称 中文\n日志 / 中文\n日志', {}, 'en-US'), 'Name 中文\n日志 / 中文\n日志');
  assert.equal(tr('名称 A / B', {}, 'en-US'), '名称 A / B');
});

test('shared action labels cannot be overwritten by boolean switch wording', () => {
  for (const [source, english] of [['关闭', 'Close'], ['取消', 'Cancel'], ['保存', 'Save'], ['刷新', 'Refresh'], ['删除', 'Delete'], ['已启用', 'Enabled'], ['已禁用', 'Disabled']]) {
    assert.equal(applicationMessage(source, {}, 'en-US'), english);
  }
});
