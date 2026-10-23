const https = require('node:https');
const { validateArguments } = require('./ai-tools-policy.cjs');

const MAX_BYTES = 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });
function loopback(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || ['0.0.0.0', '::', '::1'].includes(host) || host.startsWith('::ffff:7f') || host.startsWith('::ffff:127.');
}
function validateNetworkUrl(value, { allowLoopback = false } = {}) {
  let url;
  try { if (typeof value !== 'string' || value.length > 8192 || value.trim() !== value || Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw Error(); url = new URL(value); }
  catch { throw fail('AI_TOOLS_NETWORK_URL', '查询地址无效'); }
  const local = loopback(url.hostname);
  if (url.username || url.password || url.hash || url.port === '0' || (url.protocol !== 'https:' && !(allowLoopback && local && url.protocol === 'http:')) || local && !allowLoopback) throw fail('AI_TOOLS_NETWORK_URL', '查询地址必须使用 HTTPS，且不能包含用户信息、片段或未经许可的本机地址');
  for (const key of url.searchParams.keys()) if (/api[_-]?key|token|secret|password|authorization|cookie|^auth$|^key$/i.test(key)) throw fail('AI_TOOLS_NETWORK_URL', '查询凭据不能放在 URL 中');
  return url;
}
function normalizeHeaders(value) {
  let headers;
  try { headers = validateArguments(value, { maxBytes: 16 * 1024, maxObjectKeys: 32, maxStringBytes: 8192 }); }
  catch { throw fail('AI_TOOLS_NETWORK_HEADERS', '查询请求头无效或过大'); }
  for (const [name, content] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(name) || typeof content !== 'string' || Array.from(content).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) > 126)
      || ['host', 'content-length', 'transfer-encoding', 'connection', 'cookie', 'proxy-authorization'].includes(name.toLowerCase())) throw fail('AI_TOOLS_NETWORK_HEADERS', '查询请求头含不允许的字段或字符');
  }
  return headers;
}
function createAiToolsNetwork({ transport, allowLoopback = false, timeoutMs = 10000, maxBytes = MAX_BYTES } = {}) {
  if (allowLoopback && typeof transport !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw fail('AI_TOOLS_NETWORK_CONFIG', '网络安全限制无效');
  const send = transport || https.request;
  async function requestJson({ url: input, method = 'GET', headers: inputHeaders = {}, body, signal, credentialOrigins = [] } = {}) {
    const url = validateNetworkUrl(input, { allowLoopback });
    if (!['GET', 'POST'].includes(method)) throw fail('AI_TOOLS_NETWORK_METHOD', '额度查询仅支持 GET 或 POST');
    const headers = normalizeHeaders(inputHeaders);
    const secretBearing = Object.keys(headers).some(name => /authorization|api[-_]?key|token|secret/i.test(name));
    if (!Array.isArray(credentialOrigins) || credentialOrigins.length > 8) throw fail('AI_TOOLS_NETWORK_ORIGIN', '查询凭据的目标域名无效');
    const origins = credentialOrigins.map(value => {
      const origin = validateNetworkUrl(value, { allowLoopback });
      if (origin.pathname !== '/' || origin.search) throw fail('AI_TOOLS_NETWORK_ORIGIN', '凭据仅能绑定明确的 origin');
      return origin.origin;
    });
    if (secretBearing && !origins.includes(url.origin)) throw fail('AI_TOOLS_NETWORK_ORIGIN', '此凭据未获准发送到该查询域名');
    let bytes;
    if (body !== undefined) {
      try {
        const checked = validateArguments({ body }, { maxBytes: 64 * 1024, maxStringBytes: 64 * 1024 });
        bytes = Buffer.from(typeof checked.body === 'string' ? checked.body : JSON.stringify(checked.body), 'utf8');
      } catch { throw fail('AI_TOOLS_NETWORK_BODY', '查询请求体无效或超过 64 KiB'); }
      if (method === 'GET') throw fail('AI_TOOLS_NETWORK_BODY', 'GET 查询不能携带请求体');
    }
    if (signal?.aborted) throw fail('AI_TOOLS_CANCELLED', '查询已取消');
    return new Promise((resolve, reject) => {
      let request; let response; let settled = false; let chunks = []; let size = 0;
      const finish = (error, result) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); chunks = [];
        if (error) { response?.destroy(); request?.destroy(); reject(error); } else resolve(result);
      };
      const abort = () => finish(fail('AI_TOOLS_CANCELLED', '查询已取消'));
      const timer = setTimeout(() => finish(fail('AI_TOOLS_NETWORK_TIMEOUT', '查询超时，请稍后重试')), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        request = send(url, { method, headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', ...headers, ...(bytes ? { 'Content-Length': bytes.length } : {}) } }, incoming => {
          response = incoming;
          if (settled) { incoming.destroy(); return; }
          const status = incoming.statusCode || 0;
          if (status >= 300 && status < 400) return finish(fail('AI_TOOLS_NETWORK_REDIRECT', '查询端点发生重定向，已停止以保护凭据'));
          if (Number(incoming.headers['content-length']) > maxBytes) return finish(fail('AI_TOOLS_NETWORK_TOO_LARGE', '查询响应超过 1 MiB 限制'));
          incoming.on('data', chunk => {
            if (settled) return; const part = Buffer.from(chunk); size += part.length;
            if (size > maxBytes) finish(fail('AI_TOOLS_NETWORK_TOO_LARGE', '查询响应超过 1 MiB 限制')); else chunks.push(part);
          });
          incoming.on('aborted', () => finish(fail('AI_TOOLS_NETWORK_FAILED', '查询连接中断')));
          incoming.on('error', () => finish(fail('AI_TOOLS_NETWORK_FAILED', '查询响应读取失败')));
          incoming.on('end', () => {
            if (settled) return;
            const responseHeaders = {};
            for (const name of ['retry-after', 'content-type', 'content-length', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
              const value = incoming.headers[name]; if (typeof value === 'string') responseHeaders[name] = value.slice(0, 1024);
            }
            let content;
            try { content = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
            catch { return finish(fail('AI_TOOLS_NETWORK_RESPONSE', '查询响应不是有效 UTF-8 文本')); }
            finish(null, { status, headers: responseHeaders, body: content });
          });
        });
        request.on('error', () => finish(fail('AI_TOOLS_NETWORK_FAILED', '查询网络连接失败')));
        if (bytes) request.write(bytes); request.end();
      } catch { finish(fail('AI_TOOLS_NETWORK_FAILED', '无法启动查询请求')); }
    });
  }
  return Object.freeze({ requestJson });
}

const { requestJson } = createAiToolsNetwork();
module.exports = { createAiToolsNetwork, requestJson, validateNetworkUrl, MAX_BYTES };
