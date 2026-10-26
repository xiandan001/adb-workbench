import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import { tr } from '../src/shared/i18n.js';

const message = '此处的供应商与模型配置仅用于外部 AI 工具，不影响卓控台内置 AI。';
const source = readFileSync(new URL('../src/components/ai-tools/AiToolsWorkspace.jsx', import.meta.url), 'utf8');

test('AI tools scope notice is permanent, before all tabs, loading and membership branches', () => {
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  const workspace = ast.program.body.find(node => node.type === 'ExportDefaultDeclaration').declaration;
  const section = workspace.body.body.find(node => node.type === 'ReturnStatement').argument;
  const content = section.children.filter(node => node.type !== 'JSXText');
  const notice = content[1];
  assert.equal(notice.type, 'JSXElement');
  assert.equal(notice.openingElement.name.name, 'p');
  assert.equal(notice.openingElement.attributes.find(attribute => attribute.name?.name === 'role')?.value?.value, 'note');
  const markup = source.slice(notice.start, notice.end);
  assert.ok(markup.includes(`tr("${message}")`));
  assert.match(markup, /<Info[^>]+aria-hidden="true"/);
  assert.match(markup, /isDark/);
  assert.doesNotMatch(markup, /onClick|role="alert"|className="hidden|dismiss/);
});

test('AI tools scope notice uses all five app languages and the localized brand', () => {
  assert.equal(tr(message, {}, 'zh-CN'), message);
  const expected = {
    'en-US': 'Provider and model settings here apply only to external AI tools, not to Veylo’s built-in AI.',
    'zh-TW': '此處的供應商與模型設定僅用於外部 AI 工具，不影響卓控臺內建 AI。',
    'ja-JP': 'ここでのプロバイダーとモデルの設定は外部 AI ツールのみに適用され、Veylo 内蔵の AI には影響しません。',
    'ko-KR': '여기의 제공업체 및 모델 설정은 외부 AI 도구에만 적용되며, Veylo 내장 AI에는 영향을 주지 않습니다.',
  };
  for (const [locale, translation] of Object.entries(expected)) assert.equal(tr(message, {}, locale), translation, locale);
});
