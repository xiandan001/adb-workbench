import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createMessageTranslator } from '../src/shared/messageCatalog.js';
import { tr, getLocale, setLanguage } from '../src/shared/i18n.js';
import { currentDeviceRecording, recordingErrorText } from '../src/shared/recordingWorkspace.js';

const locales = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR'];
const emptyMessages = ['', '   ', '\t\r\n', '\u0000\u001b\u007f', '\u200b\u2060\ufeff'];

test('empty and invisible retained messages stay unchanged in all five languages', () => {
  for (const locale of locales) for (const text of emptyMessages) {
    assert.equal(tr(text, {}, locale), text, `${locale}: ${JSON.stringify(text)}`);
    assert.equal(recordingErrorText(tr(text, {}, locale)), '');
  }
});

test('placeholder-only reverse translations cannot manufacture errors from arbitrary text', () => {
  const translate = createMessageTranslator([
    ['{0} 个', '{0}'], ['{0} ↑', '{0}'], ['失败：{0}', 'Failed: {0}'],
  ]);
  for (const locale of locales) {
    assert.equal(translate('', {}, locale), '');
    assert.equal(translate('raw device output', {}, locale), 'raw device output');
  }
  assert.equal(translate('{0} 个', { 0: 'raw device output' }, 'en-US'), 'raw device output');
  assert.equal(translate('raw device output'), 'raw device output', 'bare interpolation must not poison the retained-message cache');
  assert.equal(translate('Failed: device offline'), '失败：device offline');
  assert.equal(translate('失败：device offline', {}, 'en-US'), 'Failed: device offline');
});

test('recording errors keep meaningful text, including multiline diagnostics', () => {
  for (const value of [null, undefined, false, 0, {}, ...emptyMessages]) assert.equal(recordingErrorText(value), '');
  for (const text of ['device offline', '设备未授权', 'first line\nsecond line', '\tpermission denied\n']) {
    assert.equal(recordingErrorText(text), text);
  }
});

function recordingHookFixture() {
  const source = fs.readFileSync(new URL('../src/components/useDeviceRecording.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export default function useDeviceRecording', 'function useDeviceRecording');
  const state = [], refs = [];
  let stateIndex = 0, refIndex = 0, effect;
  let result = { success: false, error: 'device offline' };
  const useHook = new Function('useState', 'useEffect', 'useRef', 'currentDeviceRecording', 'watchDeviceRecordings', 'recordingErrorText', 'tr', 'useLocale', `${source}\nreturn useDeviceRecording;`)(
    initial => {
      const index = stateIndex++;
      if (!(index in state)) state[index] = initial;
      return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next; }];
    }, callback => { effect ||= callback; },
    initial => refs[refIndex++] ||= { current: initial },
    currentDeviceRecording,
    (_api, _id, update) => {
      update({ sessions: [], loaded: true, error: '' });
      return { refresh: async () => {}, dispose() {} };
    }, recordingErrorText, tr, () => {},
  );
  return {
    render() { stateIndex = 0; refIndex = 0; return useHook('fixture-device', async () => result, async () => result); },
    mount() { return effect(); },
    setResult(value) { result = value; },
  };
}

test('real recording hook shows meaningful failures, clears them on collapse, and stays clear after rerender', async () => {
  const previousLocale = getLocale();
  const previousWindow = globalThis.window;
  globalThis.window = { electronAPI: {} };
  try {
    for (const locale of locales) {
      await setLanguage(locale);
      const fixture = recordingHookFixture();
      assert.equal(fixture.render().requestError, '');
      const dispose = fixture.mount();
      try {
        assert.equal(fixture.render().requestError, '');
        await fixture.render().start({ withLogs: false });
        assert.equal(fixture.render().requestError, 'device offline');
        fixture.render().dismissRequestError();
        assert.equal(fixture.render().requestError, '');
        assert.equal(fixture.render().requestError, '');
        fixture.setResult({ success: true });
        await fixture.render().start({ withLogs: false });
        assert.equal(fixture.render().requestError, '');
        fixture.setResult({ success: false, error: '\u0000 \t' });
        await fixture.render().start({ withLogs: false });
        assert.equal(fixture.render().requestError, tr('录屏操作失败'));
      } finally { dispose(); }
    }
  } finally {
    globalThis.window = previousWindow;
    await setLanguage(previousLocale);
  }
});
