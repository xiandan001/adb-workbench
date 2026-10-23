const http = require('node:http');
const https = require('node:https');
const { timingSafeEqual } = require('node:crypto');
const { parentPort, workerData } = require('node:worker_threads');

const config = workerData.config; const requests = new Set(); const sockets = new Set(); const grants = new Map(); const metrics = new Map();
let count = 0; let authSequence = 0; let closing = false; let inFlight = 0;
const equal = (a, b) => { const first = Buffer.from(a); const second = Buffer.from(b); return first.length === second.length && timingSafeEqual(first, second); };
const reject = (response, code, message) => { if (!response.headersSent) response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); if (!response.destroyed) response.end(JSON.stringify({ error: { message, type: 'awb_router' } })); };
function member() {
  if (grants.size >= 8 || closing) return Promise.resolve(false);
  return new Promise(resolve => { const id = ++authSequence; const timer = setTimeout(() => { grants.delete(id); resolve(false); }, 15000); grants.set(id, { resolve, timer }); parentPort.postMessage({ type: 'authorize', id }); });
}
function report(route, provider, status, startedAt) {
  const key = `${route.id}:${provider.id}`; const row = metrics.get(key) || { routeId: route.id, providerId: provider.id, requests: 0, errors: 0 };
  row.requests++; if (status >= 400) row.errors++; row.lastStatus = status; row.lastLatencyMs = Date.now() - startedAt; row.updatedAt = Date.now(); metrics.set(key, row);
  parentPort.postMessage({ type: 'metrics', metrics: [...metrics.values()], requests: count });
}
function target(provider, endpoint) {
  const url = new URL(provider.baseUrl); let base = url.pathname.replace(/\/$/, '');
  if (provider.protocol === 'gemini') { if (!base || base === '/') base = '/v1beta'; url.pathname = `${base}/models/${encodeURIComponent(provider.model.replace(/^models\//, ''))}:${endpoint.endsWith('streamGenerateContent') ? 'streamGenerateContent' : 'generateContent'}`; if (endpoint.endsWith('streamGenerateContent')) url.search = '?alt=sse'; }
  else { if (!base || base === '/') base = '/v1'; url.pathname = `${base}/${provider.protocol === 'anthropic' ? 'messages' : provider.protocol === 'openai-responses' ? 'responses' : 'chat/completions'}`; }
  return url;
}
function forward(route, body, endpoint, response, index = 0, nativeHeaders = {}) {
  if (closing || response.destroyed || response.writableEnded) return;
  const provider = route.providers[index]; const url = target(provider, endpoint); const startedAt = Date.now();
  const payload = Buffer.from(JSON.stringify({ ...body, ...(provider.protocol !== 'gemini' ? { model: provider.model } : {}) }));
  const headers = { 'content-type': 'application/json', 'content-length': payload.length, 'accept-encoding': 'identity' };
  if (provider.protocol === 'anthropic') { headers['x-api-key'] = provider.apiKey; headers['anthropic-version'] = '2023-06-01'; }
  else if (provider.protocol === 'gemini') headers['x-goog-api-key'] = provider.apiKey;
  else headers.authorization = `Bearer ${provider.apiKey}`;
  if (provider.protocol === 'anthropic' && nativeHeaders['anthropic-beta']) headers['anthropic-beta'] = nativeHeaders['anthropic-beta'];
  if (provider.protocol.startsWith('openai-') && nativeHeaders['openai-beta']) headers['openai-beta'] = nativeHeaders['openai-beta'];
  let upstream; let timer; let completed = false;
  const disconnect = () => { cleanup(); upstream?.destroy(); };
  function cleanup() { completed = true; clearTimeout(timer); requests.delete(upstream); response.off('close', disconnect); }
  try { upstream = (url.protocol === 'https:' ? https : http).request(url, { method: 'POST', headers }, incoming => {
    if (completed || response.destroyed) { incoming.destroy(); cleanup(); return; }
    const status = incoming.statusCode || 502; report(route, provider, status, startedAt);
    // Retry only explicit pre-body overload/unavailable responses. Never repeat a
    // timed-out request, a network-ambiguous request, or an already started stream.
    if (route.failover && index + 1 < route.providers.length && [429, 502, 503, 504].includes(status)) {
      cleanup(); incoming.destroy(); forward(route, body, endpoint, response, index + 1, nativeHeaders); return;
    }
    if (status >= 300) { incoming.destroy(); cleanup(); reject(response, status >= 400 && status < 600 ? status : 502, '上游未完成请求；请检查供应商状态。未转发上游错误正文。'); return; }
    response.writeHead(status, { 'content-type': incoming.headers['content-type'] || 'application/json', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    incoming.on('error', () => { cleanup(); response.destroy(); }); incoming.on('end', cleanup);
    incoming.pipe(response);
  }); } catch { cleanup(); reject(response, 502, '无法创建上游请求，请检查地址和密钥格式'); return; }
  requests.add(upstream);
  timer = setTimeout(() => { cleanup(); upstream.destroy(); if (!response.headersSent) reject(response, 504, '上游请求超时，未自动重试'); else response.destroy(); }, 300000);
  response.once('close', disconnect);
  upstream.setTimeout(60000, () => { cleanup(); upstream.destroy(); if (!response.headersSent) reject(response, 504, '上游长时间无响应，未自动重试'); else response.destroy(); });
  upstream.on('error', () => { if (completed) return; report(route, provider, 502, startedAt); cleanup(); if (!response.headersSent) reject(response, 502, '无法完成上游请求；为避免重复计费，未自动重试'); else response.destroy(); });
  upstream.end(payload);
}

const server = http.createServer(async (request, response) => {
  // Bound the whole lifecycle, including authorization and body upload. Socket
  // limits alone do not bound HTTP/1.1 pipelining on a single connection.
  if (inFlight >= 8) { request.socket.destroy(); return; }
  inFlight++; let released = false;
  const release = () => { if (!released) { released = true; inFlight--; } };
  response.once('finish', release); response.once('close', release);
  if (closing) { reject(response, 503, '路由正在停止'); return; }
  const key = String(request.headers.authorization || '').replace(/^Bearer /, '') || String(request.headers['x-api-key'] || request.headers['x-goog-api-key'] || '');
  if (request.headers.origin || !equal(key, config.key)) { reject(response, 401, '本机路由密钥无效'); return; }
  if (requests.size >= 8) { reject(response, 429, '并发请求过多，请稍后重试'); return; }
  if (!await member() || response.destroyed) { reject(response, 403, '请检查卓控台现有会员状态'); return; }
  if (request.method === 'GET' && request.url === '/v1/models') { response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ object: 'list', data: config.routes.map(route => ({ id: `awb-${route.id}`, object: 'model', owned_by: 'awb-local-router' })) })); return; }
  const endpoint = String(request.url || '').split('?')[0];
  const nativeHeaders = {};
  for (const name of ['anthropic-beta', 'openai-beta']) {
    const value = request.headers[name];
    if (typeof value === 'string' && value.length <= 2048 && !/[^\x20-\x7e]/.test(value)) nativeHeaders[name] = value;
  }
  const protocol = endpoint === '/v1/chat/completions' ? 'openai-chat' : endpoint === '/v1/responses' ? 'openai-responses' : endpoint === '/v1/messages' ? 'anthropic' : /^\/v1beta\/models\/awb-[a-f0-9-]{36}:(?:streamGenerateContent|generateContent)$/.test(endpoint) ? 'gemini' : null;
  if (request.method !== 'POST' || !protocol) { reject(response, 404, '此路由端点不受支持'); return; }
  if (request.headers['content-encoding'] || !/^application\/json(?:;|$)/i.test(String(request.headers['content-type'] || ''))) { reject(response, 415, '仅支持未压缩 JSON 请求'); return; }
  let size = 0; const chunks = [];
  request.on('data', chunk => { size += chunk.length; if (size > 4 * 1024 * 1024) { reject(response, 413, '请求超过 4 MiB'); request.destroy(); } else chunks.push(chunk); });
  request.on('error', () => { if (!response.headersSent) reject(response, 400, '请求未完整传输'); });
  request.on('end', () => {
    if (response.writableEnded || response.destroyed) return;
    let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error(); } catch { reject(response, 400, '请求 JSON 无效'); return; }
    const model = protocol === 'gemini' ? endpoint.split('/models/')[1].split(':')[0] : body.model;
    const route = config.routes.find(row => `awb-${row.id}` === model && row.protocol === protocol);
    if (!route) { reject(response, 400, '请选择相同协议的本地路由模型'); return; }
    if (requests.size >= 8) { reject(response, 429, '并发请求过多，请稍后重试'); return; }
    count++; forward(route, body, endpoint, response, 0, nativeHeaders);
  });
});
server.requestTimeout = 30000; server.headersTimeout = 15000; server.maxConnections = 32; server.maxRequestsPerSocket = 100;
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
server.on('error', () => { parentPort.postMessage({ type: 'error', code: 'AI_TOOLS_ROUTER_LISTEN', message: '本机路由端口无法监听，请确认端口未被占用' }); });
parentPort.on('message', message => {
  if (message.type === 'authorization') { const grant = grants.get(message.id); if (grant) { grants.delete(message.id); clearTimeout(grant.timer); grant.resolve(message.allowed === true); } }
  if (message.type === 'stop') { closing = true; for (const request of requests) request.destroy(); for (const socket of sockets) socket.destroy(); for (const grant of grants.values()) { clearTimeout(grant.timer); grant.resolve(false); } grants.clear(); server.close(() => { parentPort.postMessage({ type: 'stopped' }); parentPort.close(); }); }
});
server.listen(config.port, '127.0.0.1', () => parentPort.postMessage({ type: 'started', port: server.address().port }));
