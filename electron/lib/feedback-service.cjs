const { tr } = require('./localization.cjs');
const { randomUUID } = require('node:crypto');
const { REPOSITORY, LOG_LIMIT, fail, exact, normalizeForm, environmentForReport, buildReport, issueUrl } = require('./feedback-policy.cjs');

function createFeedbackService({ diagnostics, logger, auth, github, openExternal, now = Date.now, uuid = randomUUID }) {
  const previews = new Map(); let disposed = false; let environment; let collectedAt = 0;
  const check = guard => { if (disposed || guard && guard() === false) throw fail('FEEDBACK_CANCELLED', tr("操作已取消，请重新打开问题上报")); };
  async function collect(guard) {
    check(guard);
    if (!environment || now() - collectedAt > 60000) { const value = await diagnostics.collect(); check(guard); environment = environmentForReport(value); collectedAt = now(); }
    return structuredClone(environment);
  }
  async function context(guard) {
    check(guard); const [value, state] = await Promise.all([collect(guard), auth.status()]); check(guard);
    return { environment: value, auth: state, repository: REPOSITORY, logPolicy: { automatic: true, maxBytes: LOG_LIMIT } };
  }
  async function preview(value, guard) {
    check(guard); const form = normalizeForm(value);
    const data = form.includeEnvironment ? await collect(guard) : null; check(guard);
    // No filesystem snapshot at all unless this particular report opts into logs.
    const log = form.includeLogs ? await logger.snapshot() : null; check(guard);
    for (const [key, entry] of previews) if (entry.expiresAt <= now() && entry.state === 'prepared' && !entry.pending) previews.delete(key);
    if (previews.size >= 5) {
      const oldest = [...previews].find(([, entry]) => !entry.pending && entry.state !== 'uncertain');
      if (!oldest) throw fail('FEEDBACK_PENDING', tr("尚有未确认的报告，请先检查提交结果"));
      previews.delete(oldest[0]);
    }
    const reportId = uuid(); const token = uuid(); const report = buildReport(form, data, log, reportId);
    const entry = { token, reportId, ...report, createdAt: new Date(now()).toISOString(), expiresAt: now() + 15 * 60000,
      includeLogs: form.includeLogs, includeEnvironment: form.includeEnvironment, state: 'prepared' };
    previews.set(token, entry);
    return { preview: structuredClone({ token, reportId, ...report, expiresAt: entry.expiresAt }) };
  }
  async function deliver(entry, guard) {
    check(guard);
    const session = await auth.getAccessSession(guard); check(guard);
    const current = () => { check(guard); if (!auth.isSessionCurrent(session)) throw fail('FEEDBACK_AUTH_CHANGED', tr("GitHub 授权已变化，请重新检查后提交")); };
    current(); const { accessToken, login } = session;
    if (entry.state === 'uncertain') {
      if (entry.creator !== login) throw fail('FEEDBACK_AUTH_ACCOUNT', tr("请使用原提交账号检查结果，避免重复创建问题"));
      const found = await github.findIssue({ accessToken, login, reportId: entry.reportId, since: entry.createdAt });
      current();
      if (!found) throw Object.assign(fail('FEEDBACK_UNCERTAIN', tr("暂未查到提交结果。请稍后再次检查，或在 GitHub 查看；不会重复发送报告")), { uncertain: true });
      entry.issue = found; entry.state = 'sent'; return { issue: found, reused: true };
    }
    entry.creator = login;
    try {
      current();
      const issue = await github.createIssue({ accessToken, title: entry.title, body: entry.body });
      // Save the acknowledged result even if the original window closed during the request.
      entry.issue = { number: issue.number, url: issueUrl(issue.url) }; entry.state = 'sent';
      check(guard); return { issue: { ...entry.issue } };
    } catch (error) {
      if (error.uncertain) entry.state = 'uncertain';
      // A late 401 from an older request must not clear a newer user authorization.
      throw error;
    }
  }
  async function submit(value, guard) {
    check(guard);
    if (!exact(value, ['token', 'includeLogs', 'includeEnvironment']) || typeof value.token !== 'string' || value.token.length > 80
      || typeof value.includeLogs !== 'boolean' || typeof value.includeEnvironment !== 'boolean') throw fail('FEEDBACK_INPUT', tr("提交参数无效"));
    const entry = previews.get(value.token);
    if (!entry || entry.expiresAt <= now() && entry.state === 'prepared') throw fail('FEEDBACK_PREVIEW_EXPIRED', tr("预览已过期，请重新预览后提交"));
    if (value.includeLogs !== entry.includeLogs || value.includeEnvironment !== entry.includeEnvironment) throw fail('FEEDBACK_CONSENT_CHANGED', tr("附带信息的选择已变化，请重新生成预览"));
    if (entry.issue) return { issue: { ...entry.issue }, reused: true };
    if (!entry.pending) entry.pending = deliver(entry, guard).finally(() => { entry.pending = null; });
    const result = await entry.pending; check(guard); return structuredClone(result);
  }
  async function openIssue(value, guard) {
    check(guard); if (!exact(value, ['url'])) throw fail('FEEDBACK_INPUT', tr("问题链接参数无效"));
    const url = issueUrl(value.url); check(guard); await openExternal(url); return {};
  }
  return { context, preview, submit, openIssue, dispose() { disposed = true; previews.clear(); } };
}
module.exports = { createFeedbackService };
