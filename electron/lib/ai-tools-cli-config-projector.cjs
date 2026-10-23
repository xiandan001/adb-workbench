const { codexCliAssignments } = require('./ai-tools-cli-config.cjs');
const { fail } = require('./ai-tools-file-safety.cjs');
const { isDeepStrictEqual } = require('node:util');

function projectCodexAdvanced(content, provider, expected, { patchTomlSection, change }) {
  const { assignments, httpHeaders } = codexCliAssignments(provider.cliConfig?.codex);
  const groups = new Map(); const changes = [];
  const put = (keys, value, secret = false) => {
    const section = keys.slice(0, -1).join('.'); const field = keys.at(-1);
    let target = expected;
    for (const key of keys.slice(0, -1)) {
      if (target[key] !== undefined && (target[key] === null || typeof target[key] !== 'object' || Array.isArray(target[key]))) throw fail('AI_TOOLS_CONFIG_TOML', '高级配置目标不是 TOML 配置表，未覆盖原值');
      target[key] ||= {}; target = target[key];
    }
    const before = target[field];
    if (isDeepStrictEqual(before, value)) return;
    if (!groups.has(section)) groups.set(section, { before: structuredClone(target), updates: {} });
    groups.get(section).updates[field] = value;
    if (value === undefined) delete target[field]; else target[field] = value;
    changes.push(change(keys.join('.'), before, value, secret));
  };
  for (const assignment of assignments) put(assignment.keys, assignment.value);
  if (httpHeaders !== undefined) {
    const providerId = `awb_${provider.id.replaceAll('-', '')}`;
    const keys = ['model_providers', providerId, 'http_headers']; const current = expected.model_providers[providerId].http_headers;
    if (current !== undefined && (current === null || typeof current !== 'object' || Array.isArray(current))) throw fail('AI_TOOLS_CONFIG_TOML', '原有 http_headers 不是配置表，未覆盖');
    const tableHeader = new RegExp(`^\\s*\\[model_providers\\.${providerId}\\.http_headers\\]`, 'm');
    if (tableHeader.test(content)) {
      if (httpHeaders === null) for (const name of Object.keys(current || {})) put([...keys, name], undefined, true);
      else for (const [name, value] of Object.entries(httpHeaders)) {
        for (const old of Object.keys(current || {})) if (old !== name && old.toLowerCase() === name.toLowerCase()) put([...keys, old], undefined, true);
        put([...keys, name], value === null ? undefined : value, true);
      }
    } else if (httpHeaders === null) put(keys, undefined, true);
    else if (Object.keys(httpHeaders).length) {
      const merged = { ...(current || {}) };
      for (const [name, value] of Object.entries(httpHeaders)) {
        for (const old of Object.keys(merged)) if (old.toLowerCase() === name.toLowerCase()) delete merged[old];
        if (value !== null) merged[name] = value;
      }
      if (Object.keys(merged).length || current !== undefined) put(keys, merged, true);
    }
  }
  let result = content;
  for (const [section, group] of groups) result = patchTomlSection(result, section, group.updates, group.before);
  return { content: result, changes };
}

module.exports = { projectCodexAdvanced };
