import { tr } from './i18n.js';
export const FEEDBACK_CATEGORIES = [
  { value: 'general', get label() { return tr("通用问题"); } }, { value: 'startup', get label() { return tr("启动与更新"); } }, { value: 'devices', get label() { return tr("设备连接与操作"); } },
  { value: 'serial', get label() { return tr("串口 / RS232"); } }, { value: 'ssh', get label() { return tr("SSH 工作区"); } }, { value: 'ai-tools', get label() { return tr("AI 工具"); } }, { value: 'ui', get label() { return tr("界面与交互"); } },
];
const LIMITS = { title: 120, description: 4000, steps: 4000, expected: 2000 };
const FIELDS = [...Object.keys(LIMITS), 'category', 'includeEnvironment', 'includeLogs'];
export function createFeedbackState(currentPage) {
  return { draft: { title: '', category: FEEDBACK_CATEGORIES.some(item => item.value === currentPage) ? currentPage : 'general', description: '', steps: '', expected: '', includeEnvironment: true, includeLogs: false },
    view: 'edit', preview: null, issue: null, busy: '', error: '', uncertain: false };
}
export function feedbackInput(draft) {
  const result = {};
  for (const [key, limit] of Object.entries(LIMITS)) {
    if (typeof draft[key] !== 'string' || draft[key].length > limit) throw new Error(tr("请检查输入长度：标题最多 120 字，问题描述和步骤最多 4000 字，预期结果最多 2000 字"));
    result[key] = draft[key].trim();
  }
  if (!result.title || !result.description) throw new Error(tr("请填写问题标题和问题描述"));
  if (!FEEDBACK_CATEGORIES.some(item => item.value === draft.category) || typeof draft.includeLogs !== 'boolean' || typeof draft.includeEnvironment !== 'boolean') throw new Error(tr("报告选项无效，请重新选择"));
  return { ...result, category: draft.category, includeEnvironment: draft.includeEnvironment, includeLogs: draft.includeLogs };
}
export function feedbackResponse(value) {
  if (value?.ok === true) return value;
  const message = typeof value?.error?.message === 'string' ? value.error.message.slice(0, 1200) : tr("操作未完成，请稍后重试");
  throw Object.assign(new Error(message), { code: typeof value?.error?.code === 'string' ? value.error.code : '', uncertain: value?.uncertain === true });
}
export function publicFeedbackAuth(value) {
  if (!value || ['configured', 'authenticated', 'persistent', 'pending'].some(key => typeof value[key] !== 'boolean')) throw new Error(tr("GitHub 授权状态格式无效，请重新读取"));
  return { configured: value.configured, authenticated: value.authenticated, persistent: value.persistent, pending: value.pending,
    login: typeof value.login === 'string' ? value.login.slice(0, 100) : '',
    userCode: value.pending && typeof value.userCode === 'string' ? value.userCode.slice(0, 64) : '',
    expiresAt: Number.isFinite(value.expiresAt) ? value.expiresAt : null,
    error: typeof value.error === 'string' ? value.error.slice(0, 1200) : '' };
}
export function canSubmitFeedback(auth, authBusy = '') {
  return Boolean(auth?.configured && auth.authenticated && !auth.pending && !authBusy);
}
export function pollFeedbackAuthorization({ read, onAuth, onError, clock = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) } }) {
  let active = true; let timer;
  const poll = async () => {
    timer = undefined; let pending = true;
    try {
      const auth = publicFeedbackAuth(feedbackResponse(await read()).auth);
      if (active) { pending = auth.pending; onAuth(auth); }
    } catch (failure) { if (active) onError(failure.message || tr("暂时无法读取授权状态")); }
    if (active && pending) timer = clock.setTimeout(poll, 1500);
  };
  timer = clock.setTimeout(poll, 1500);
  return () => { active = false; if (timer !== undefined) clock.clearTimeout(timer); };
}
function reportPreview(value, input, now) {
  const preview = feedbackResponse(value).preview;
  if (!preview || typeof preview.token !== 'string' || !preview.token || preview.token.length > 500 || typeof preview.title !== 'string' || typeof preview.body !== 'string' || preview.body.length > 100000
    || !Number.isFinite(preview.expiresAt) || preview.expiresAt <= now) throw new Error(tr("报告预览无效或已过期，请重新预览"));
  const log = preview.log;
  if (!log || typeof log.included !== 'boolean' || !Number.isSafeInteger(log.bytes) || log.bytes < 0 || log.bytes > 16384 || !Number.isSafeInteger(log.lines) || log.lines < 0
    || typeof log.truncated !== 'boolean' || !input.includeLogs && log.included) throw new Error(tr("日志预览与本次选择不一致，未提交任何内容"));
  return { token: preview.token, reportId: preview.reportId, title: preview.title, body: preview.body, environment: preview.environment, log: { included: log.included, bytes: log.bytes, lines: log.lines, truncated: log.truncated }, expiresAt: preview.expiresAt };
}
function reportIssue(value) {
  const issue = value?.issue;
  if (!Number.isSafeInteger(issue?.number) || issue.number <= 0 || issue.url !== `https://github.com/xiandan001/adb-workbench/issues/${issue.number}`) throw new Error(tr("提交结果尚无法确认，请检查提交结果，勿重复新建报告"));
  return { number: issue.number, url: issue.url };
}

// Owns only the editable report/immutable preview lifecycle, not authorization.
export function createFeedbackReportSession({ api, initialState, onChange, now = Date.now }) {
  let state = initialState; let epoch = 0; let operation = null; let active = true;
  const publish = changes => { state = { ...state, ...changes }; if (active) onChange(state); };
  const current = ticket => active && operation === ticket && ticket.epoch === epoch;
  const finish = ticket => { if (current(ticket)) { operation = null; publish({ busy: '' }); } };
  return {
    snapshot: () => state,
    activate() { active = true; },
    deactivate() { active = false; epoch++; operation = null; },
    change(field, value) {
      if (!active || state.busy === 'submit' || state.uncertain || !FIELDS.includes(field)) return false;
      epoch++; operation = null; publish({ draft: { ...state.draft, [field]: value }, view: 'edit', preview: null, issue: null, error: '', busy: '' }); return true;
    },
    back() {
      if (!active || operation || state.uncertain) return false;
      epoch++; publish({ view: 'edit', preview: null, error: '' }); return true;
    },
    async preview() {
      if (!active || operation || state.uncertain) return;
      let input;
      try { input = feedbackInput(state.draft); } catch (failure) { publish({ error: failure.message }); return; }
      const ticket = { epoch }; operation = ticket; publish({ busy: 'preview', error: '' });
      try {
        if (typeof api?.feedbackPreview !== 'function') throw new Error(tr("报告接口尚未连接，请使用新版桌面应用"));
        const result = await api.feedbackPreview(input);
        if (current(ticket)) publish({ preview: reportPreview(result, input, now()), view: 'preview', uncertain: false });
      } catch (failure) { if (current(ticket)) publish({ error: failure.message || tr("预览失败，已保留填写内容") }); }
      finally { finish(ticket); }
    },
    async submit() {
      if (!active || operation || state.view !== 'preview' || !state.preview) return;
      if (!state.uncertain && state.preview.expiresAt <= now()) { publish({ error: tr("报告预览已过期，请返回修改页后重新预览") }); return; }
      const payload = { token: state.preview.token, includeLogs: state.draft.includeLogs, includeEnvironment: state.draft.includeEnvironment };
      const ticket = { epoch }; operation = ticket; publish({ busy: 'submit', error: '' });
      try {
        const result = await api.feedbackSubmit(payload);
        if (!current(ticket)) return;
        if (result?.ok === false) { publish({ error: typeof result?.error?.message === 'string' ? result.error.message : tr("提交未完成，请重试"), uncertain: state.uncertain || result?.uncertain === true }); return; }
        if (result?.ok !== true) throw new Error(tr('提交结果不可用'));
        publish({ issue: reportIssue(result), view: 'success', uncertain: false });
      } catch { if (current(ticket)) publish({ uncertain: true, error: tr("提交结果尚无法确认，请检查提交结果，勿重复新建报告") }); }
      finally { finish(ticket); }
    },
  };
}

export function feedbackEnvironmentRows(environment) {
  const value = item => typeof item === 'string' && item.trim() ? item : typeof item === 'number' && Number.isFinite(item) ? String(item) : '';
  const join = items => items.map(value).filter(Boolean).join(' · ') || tr("不可用");
  const { app = {}, os = {}, computer = {}, displays = [] } = environment || {};
  return [
    { label: tr("应用"), value: join([app.name, app.version]) },
    { label: tr("运行环境"), value: join([app.electron && `Electron ${app.electron}`, app.chrome && `Chrome ${app.chrome}`, app.node && `Node ${app.node}`]) },
    { label: tr("系统"), value: join([os.name, os.version, os.build, os.architecture, os.locale]) },
    { label: tr("电脑"), value: join([computer.manufacturer, computer.model]) },
    { label: tr("处理器"), value: join([computer.cpu, computer.logicalCores > 0 ? tr("{0} 个逻辑核心", { 0: computer.logicalCores }) : null]) },
    { label: tr("内存"), value: Number.isFinite(computer.memoryBytes) && computer.memoryBytes > 0 ? `${(computer.memoryBytes / 1073741824).toFixed(1)} GiB` : tr("不可用") },
    { label: tr("显示器"), value: Array.isArray(displays) && displays.length ? displays.map(display => display.width > 0 && display.height > 0 ? `${display.width} × ${display.height}${display.scaleFactor > 0 ? ` · ${display.scaleFactor}×` : ''}` : tr("不可用")).join('；') : tr("不可用") },
  ];
}
