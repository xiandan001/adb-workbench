const https = require('node:https');
const { REPOSITORY, fail, issueUrl } = require('./feedback-policy.cjs');

function requestAllowed(value) {
  const url = new URL(value);
  if (url.username || url.password || url.hash) return false;
  return url.origin === 'https://github.com' && !url.search && ['/login/device/code', '/login/oauth/access_token'].includes(url.pathname)
    || url.origin === 'https://api.github.com' && (url.pathname === '/user' && !url.search || url.pathname === `/repos/${REPOSITORY}/issues`);
}
function githubRequest(url, { method = 'GET', body, headers = {}, signal, maxBytes = 2 * 1024 * 1024, timeoutMs = 15000 } = {}) {
  if (!requestAllowed(url)) return Promise.reject(fail('FEEDBACK_URL', '不允许的 GitHub 接口'));
  return new Promise((resolve, reject) => {
    let request; let settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); if (error) { request?.destroy(); reject(error); } else resolve(result); };
    const abort = () => finish(fail('FEEDBACK_CANCELLED', '请求已取消'));
    const timer = setTimeout(() => finish(fail('FEEDBACK_TIMEOUT', 'GitHub 请求超时，请检查网络后重试')), timeoutMs);
    if (signal?.aborted) { abort(); return; } signal?.addEventListener('abort', abort, { once: true });
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    request = https.request(url, { method, headers: { Accept: 'application/json', 'User-Agent': 'adb-workbench-feedback',
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > maxBytes) { response.destroy(); finish(fail('FEEDBACK_RESPONSE_LIMIT', 'GitHub 返回数据过大')); } else chunks.push(chunk); });
      response.on('error', () => finish(fail('FEEDBACK_NETWORK', 'GitHub 连接中断，请检查网络后重试')));
      response.on('end', () => { let parsed = null; try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* Never return raw HTML or remote error text. */ }
        finish(null, { status: response.statusCode, data: parsed, headers: response.headers }); });
    });
    request.on('error', () => finish(fail('FEEDBACK_NETWORK', '无法连接 GitHub，请检查网络后重试')));
    request.end(data);
  });
}
function responseData(reply) {
  if (reply.status === 401) throw fail('FEEDBACK_AUTH_REQUIRED', 'GitHub 授权已失效，请重新登录');
  if (reply.status === 403 || reply.status === 429) throw fail('FEEDBACK_FORBIDDEN', 'GitHub 权限不足或请求过于频繁，请检查授权后稍后重试');
  if (reply.status === 404 || reply.status === 410) throw fail('FEEDBACK_REPOSITORY', 'GitHub 仓库或 Issues 不可用，请检查应用安装权限');
  if (reply.status === 422) throw fail('FEEDBACK_REJECTED', 'GitHub 未接受报告，请检查内容或稍后重试');
  if (reply.status < 200 || reply.status >= 300) throw Object.assign(fail('FEEDBACK_REMOTE', 'GitHub 暂时不可用，请稍后重试'), { uncertain: reply.status >= 500 });
  if (!reply.data || typeof reply.data !== 'object') throw Object.assign(fail('FEEDBACK_RESPONSE', 'GitHub 返回格式异常'), { uncertain: true });
  return reply.data;
}
function issueResult(value) {
  if (!Number.isSafeInteger(value?.number) || value.number <= 0) throw Object.assign(fail('FEEDBACK_RESPONSE', '未能确认 GitHub 问题编号'), { uncertain: true });
  const url = issueUrl(value.html_url); if (!url.endsWith('/' + value.number)) throw fail('FEEDBACK_RESPONSE', 'GitHub 问题编号与链接不一致');
  return { number: value.number, url };
}
function createFeedbackGithub({ request = githubRequest } = {}) {
  const oauth = async (path, body) => responseData(await request(`https://github.com${path}`, { method: 'POST', body, maxBytes: 65536 }));
  const api = (path, accessToken, options = {}) => request(`https://api.github.com${path}`, { ...options,
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', Authorization: `Bearer ${accessToken}` } });
  return {
    startDevice: clientId => oauth('/login/device/code', { client_id: clientId }),
    pollDevice: (clientId, deviceCode) => oauth('/login/oauth/access_token', { client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    refresh: (clientId, refreshToken) => oauth('/login/oauth/access_token', { client_id: clientId, refresh_token: refreshToken, grant_type: 'refresh_token' }),
    async user(accessToken) {
      const result = responseData(await api('/user', accessToken));
      if (typeof result.login !== 'string' || !/^[A-Za-z\d][A-Za-z\d-]{0,38}$/.test(result.login)) throw fail('FEEDBACK_AUTH_RESPONSE', 'GitHub 账号信息无效');
      return { login: result.login };
    },
    async createIssue({ accessToken, title, body }) {
      let reply;
      try { reply = await api(`/repos/${REPOSITORY}/issues`, accessToken, { method: 'POST', body: { title, body }, maxBytes: 256 * 1024 }); }
      catch { throw Object.assign(fail('FEEDBACK_UNCERTAIN', '提交结果尚未确认，请检查结果，不要重复新建报告'), { uncertain: true }); }
      const data = responseData(reply);
      try { return issueResult(data); } catch { throw Object.assign(fail('FEEDBACK_UNCERTAIN', '提交结果尚未确认，请检查结果'), { uncertain: true }); }
    },
    async findIssue({ accessToken, login, reportId, since }) {
      if (!/^[A-Za-z\d][A-Za-z\d-]{0,38}$/.test(login) || !/^[a-f\d-]{36}$/i.test(reportId)) throw fail('FEEDBACK_INPUT', '报告查询参数无效');
      const query = new URLSearchParams({ creator: login, state: 'all', sort: 'created', direction: 'desc', per_page: '30', since });
      const data = responseData(await api(`/repos/${REPOSITORY}/issues?${query}`, accessToken));
      if (!Array.isArray(data)) throw fail('FEEDBACK_RESPONSE', 'GitHub 问题查询格式异常');
      const result = data.find(item => !item.pull_request && item.user?.login?.toLowerCase() === login.toLowerCase() && typeof item.body === 'string' && item.body.includes(`<!-- workbench-report:${reportId} -->`));
      return result ? issueResult(result) : null;
    },
  };
}
module.exports = { createFeedbackGithub, githubRequest, requestAllowed };
