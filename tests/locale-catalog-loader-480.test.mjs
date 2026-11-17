import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocaleCatalogLoader } from '../src/shared/localeCatalogLoader.js';
import { createMessageTranslator } from '../src/shared/messageCatalog.js';

test('language catalogs load only on demand, coalesce calls and retain already-used message translations', async () => {
  const calls = [], loaders = {
    'en-US': async () => { calls.push('en'); return [{ '已保存 {0}': 'Saved {0}', '取消': 'Cancel' }]; },
    'ja-JP': async () => { calls.push('ja'); return [{ '已保存 {0}': '保存済み {0}', '取消': 'キャンセル' }]; },
  };
  const catalogs = createLocaleCatalogLoader({ loaders, makeTranslator: createMessageTranslator });
  assert.deepEqual(calls, []); assert.equal(catalogs.translate('已保存 {0}', { 0: 'raw{1}' }, 'zh-CN'), '已保存 raw{1}');
  await Promise.all([catalogs.load('en-US'), catalogs.load('en-US')]); assert.deepEqual(calls, ['en']);
  const retained = catalogs.translate('已保存 {0}', { 0: '原文' }, 'en-US'); assert.equal(retained, 'Saved 原文');
  await catalogs.load('ja-JP'); assert.equal(catalogs.translate(retained, {}, 'ja-JP'), '保存済み 原文');
  await catalogs.load('en-US'); assert.deepEqual(calls, ['en', 'ja']);
  assert.equal(catalogs.translate('arbitrary log {0}', {}, 'ja-JP'), 'arbitrary log {0}');
});
test('a rejected import can be retried without discarding an earlier language', async () => {
  let attempts = 0;
  const catalogs = createLocaleCatalogLoader({ makeTranslator: createMessageTranslator, loaders: {
    'en-US': async () => [{ '取消': 'Cancel' }],
    'ko-KR': async () => { if (++attempts === 1) throw Error('synthetic import'); return [{ '取消': '취소' }]; },
  } });
  await catalogs.load('en-US'); await assert.rejects(catalogs.load('ko-KR'));
  assert.equal(catalogs.translate('取消', {}, 'en-US'), 'Cancel');
  await catalogs.load('ko-KR'); assert.equal(catalogs.translate('取消', {}, 'ko-KR'), '취소');
  await assert.rejects(catalogs.load('untrusted-locale'));
});
