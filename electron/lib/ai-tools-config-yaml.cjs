const { tr } = require('./localization.cjs');
const YAML = require('yaml');
const { isDeepStrictEqual } = require('node:util');
const { fail } = require('./ai-tools-file-safety.cjs');
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function parseYaml(content) {
  const doc = YAML.parseDocument(content.trim() ? content : '{}\n', { uniqueKeys: true, keepSourceTokens: true });
  if (doc.errors.length || doc.warnings.length || !YAML.isMap(doc.contents)) throw fail('AI_TOOLS_CONFIG_YAML', tr("YAML 配置格式无效或包含不支持的标签，未修改"));
  let original;
  try { original = doc.toJS({ maxAliasCount: 100 }); } catch { throw fail('AI_TOOLS_CONFIG_YAML', tr("YAML 配置引用过多或无效，未修改")); }
  return { doc, original };
}

function patchYaml({ doc, original }, assignments, change) {
  const expected = structuredClone(original); const changes = [];
  for (const { keys, value, secret } of assignments) {
    let target = expected;
    for (let i = 0; i < keys.length - 1; i += 1) {
      const node = doc.getIn(keys.slice(0, i + 1), true); const sequence = typeof keys[i + 1] === 'number';
      if (YAML.isAlias(node)) throw fail('AI_TOOLS_CONFIG_YAML', tr("受管理的 YAML 字段使用别名引用，未修改"));
      if (node !== undefined && !(sequence ? YAML.isSeq(node) : YAML.isMap(node))) throw fail('AI_TOOLS_CONFIG_YAML', tr("受管理的 YAML 字段不是预期映射或列表，未修改"));
      if (!Object.hasOwn(target, keys[i])) target[keys[i]] = sequence ? [] : {};
      if (!(sequence ? Array.isArray(target[keys[i]]) : object(target[keys[i]]))) throw fail('AI_TOOLS_CONFIG_YAML', tr("受管理的 YAML 字段格式无效，未修改"));
      target = target[keys[i]];
    }
    const key = keys.at(-1); changes.push(change(keys.join('.'), target[key], value, secret));
    target[key] = value; doc.setIn(keys, value);
  }
  const result = doc.toString({ lineWidth: 0 }); let actual;
  try { actual = YAML.parse(result, { maxAliasCount: 100 }); } catch { throw fail('AI_TOOLS_CONFIG_YAML', tr("YAML 配置无法安全保留，未修改")); }
  if (!isDeepStrictEqual(actual, expected)) throw fail('AI_TOOLS_CONFIG_YAML', tr("YAML 修改会影响其他引用字段，未修改"));
  return { content: result, format: 'yaml', changes };
}

module.exports = { parseYaml, patchYaml };
