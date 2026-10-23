const { isDeepStrictEqual } = require('node:util');
const jsonc = require('jsonc-parser');
const toml = require('smol-toml');
const { fail, checksum } = require('./ai-tools-file-safety.cjs');
const { START, END, plain, keyFor, clone } = require('./ai-tools-resources-policy.cjs');

// Native field mappings verified against CC Switch e4873bc8 (MIT), mcp/* and gemini_mcp.rs.
const digest = value => checksum(Buffer.from(JSON.stringify(value)));
const conflict = () => fail('AI_TOOLS_RESOURCE_CONFLICT', '资源对应的原生配置已被外部修改或不属于本应用，未覆盖，请检查目标文件');
function parseJson(content) {
  const errors = [];
  const tree = jsonc.parseTree(content || '{}', errors, { allowTrailingComma: true, disallowComments: false });
  const nodes = tree ? [tree] : [];
  while (nodes.length) {
    const node = nodes.pop();
    if (node.type === 'object') {
      const names = new Set();
      for (const property of node.children || []) {
        const name = property.children?.[0]?.value;
        if (names.has(name)) throw fail('AI_TOOLS_RESOURCE_FORMAT', 'MCP 配置包含重复 JSON 字段，无法确认原始内容，未修改');
        names.add(name);
      }
    }
    for (const child of node.children || []) nodes.push(child);
  }
  const value = tree ? jsonc.getNodeValue(tree) : null;
  if (errors.length || !plain(value)) throw fail('AI_TOOLS_RESOURCE_FORMAT', 'MCP 配置不是有效 JSON/JSONC 对象，未修改');
  return value;
}
function nativeMcp(toolId, resource) {
  if (resource.type === 'stdio') {
    if (toolId === 'opencode') return { type: 'local', command: [resource.command, ...resource.args], ...(Object.keys(resource.env).length ? { environment: resource.env } : {}), enabled: true };
    return { ...(toolId === 'claude' ? { type: 'stdio' } : {}), command: resource.command, args: resource.args, ...(Object.keys(resource.env).length ? { env: resource.env } : {}) };
  }
  if (toolId === 'opencode') return { type: 'remote', url: resource.url, ...(Object.keys(resource.headers).length ? { headers: resource.headers } : {}), enabled: true };
  const urlKey = toolId === 'gemini' && resource.type === 'http' ? 'httpUrl' : 'url';
  const headerKey = toolId === 'codex' ? 'http_headers' : 'headers';
  return { ...(toolId === 'claude' ? { type: resource.type } : {}), [urlKey]: resource.url, ...(Object.keys(resource.headers).length ? { [headerKey]: resource.headers } : {}) };
}
function verifyOwnership(actualHash, expectedHash) {
  if (actualHash !== expectedHash) throw conflict();
}
function findBlock(content, start, end) {
  const startAt = content.indexOf(start); const endAt = content.indexOf(end);
  if (startAt < 0 && endAt < 0) return null;
  if (startAt < 1 || content[startAt - 1] !== '\n' || endAt <= startAt || content.indexOf(start, startAt + 1) >= 0 || content.indexOf(end, endAt + 1) >= 0 || content[endAt + end.length] !== '\n') throw conflict();
  return { from: startAt - 1, to: endAt + end.length + 1, content: content.slice(startAt - 1, endAt + end.length + 1) };
}
function replaceBlock(content, block, replacement) { return block ? content.slice(0, block.from) + replacement + content.slice(block.to) : content + replacement; }
function codex(content, resource, enabled, expectedHash) {
  let parsed;
  try { parsed = toml.parse(content); } catch { throw fail('AI_TOOLS_RESOURCE_FORMAT', 'Codex 配置不是有效 TOML，未修改'); }
  if (parsed.mcp_servers !== undefined && !plain(parsed.mcp_servers)) throw fail('AI_TOOLS_RESOURCE_FORMAT', 'Codex mcp_servers 不是配置表，未修改');
  const key = keyFor(resource.id); const native = nativeMcp('codex', resource);
  const previous = parsed.mcp_servers?.[key]; verifyOwnership(previous === undefined ? null : digest(previous), expectedHash);
  const start = `# adb-workbench:mcp:${key}:start`; const end = `# adb-workbench:mcp:${key}:end`;
  const block = findBlock(content, start, end);
  if (Boolean(block) !== (previous !== undefined)) throw conflict();
  const replacement = enabled ? `\n${start}\n${toml.stringify({ mcp_servers: { [key]: native } })}${end}\n` : '';
  const result = replaceBlock(content, block, replacement);
  let after;
  try { after = toml.parse(result); } catch { throw fail('AI_TOOLS_RESOURCE_FORMAT', 'Codex MCP 表结构无法安全追加，未修改原有配置'); }
  const expected = toml.parse(content);
  if (enabled) { expected.mcp_servers ||= Object.create(null); expected.mcp_servers[key] = toml.parse(toml.stringify(native)); }
  else if (expected.mcp_servers) { delete expected.mcp_servers[key]; if (!Object.keys(expected.mcp_servers).length && after.mcp_servers === undefined) delete expected.mcp_servers; }
  if (!isDeepStrictEqual(after, expected)) throw fail('AI_TOOLS_RESOURCE_FORMAT', 'Codex MCP 修改影响了其他配置字段，已停止');
  return { content: result, hash: enabled ? digest(native) : null, format: 'toml' };
}
function projectMcp(toolId, content, resource, enabled, expectedHash) {
  if (toolId === 'codex') return codex(content, resource, enabled, expectedHash);
  const parsed = parseJson(content); const key = keyFor(resource.id); const field = toolId === 'opencode' ? 'mcp' : 'mcpServers';
  if (parsed[field] !== undefined && !plain(parsed[field])) throw fail('AI_TOOLS_RESOURCE_FORMAT', 'MCP 服务器字段不是对象，未修改');
  const current = parsed[field]?.[key]; verifyOwnership(current === undefined ? null : digest(current), expectedHash);
  const native = nativeMcp(toolId, resource);
  let result = content || '{}\n';
  if (enabled || current !== undefined) result = jsonc.applyEdits(result, jsonc.modify(result, [field, key], enabled ? native : undefined, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } }));
  const after = parseJson(result); const expected = clone(parsed);
  if (enabled) { expected[field] ||= {}; expected[field][key] = native; } else if (expected[field]) delete expected[field][key];
  if (JSON.stringify(after) !== JSON.stringify(expected)) throw fail('AI_TOOLS_RESOURCE_FORMAT', 'MCP 修改影响了其他配置字段，已停止');
  return { content: result, hash: enabled ? digest(native) : null, format: 'jsonc' };
}
function projectPrompt(toolId, content, resource, enabled, expectedHash) {
  const block = findBlock(content, START, END);
  verifyOwnership(block ? checksum(Buffer.from(block.content)) : null, expectedHash);
  const replacement = enabled ? `\n${START}\n${resource.content}\n${END}\n` : '';
  const result = replaceBlock(content, block, replacement);
  if (Buffer.byteLength(result) > (toolId === 'mcode' ? 32 * 1024 : 1024 * 1024)) throw fail('AI_TOOLS_RESOURCE_LIMIT', toolId === 'mcode' ? 'MCode 全局提示词文件不能超过 32 KiB（含原有内容）' : '提示词文件超过容量限制');
  return { content: result, hash: enabled ? checksum(Buffer.from(replacement)) : null, format: 'markdown' };
}

module.exports = { projectMcp, projectPrompt };
