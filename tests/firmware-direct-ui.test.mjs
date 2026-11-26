import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { button, changeTarget, copy, flush, modeOptions, mount, nodes, readyFile, text } from './helpers/firmware-direct-ui-harness.mjs';

test('unverified profiles offer only the vendor fallback and no start action', async () => {
  const calls = [];
  const app = mount({
    firmwareDirectState: async () => ({ ok: true, enabled: false, modes: [], job: null }),
    firmwareDirectArm: async () => { calls.push('arm'); },
  });
  await flush();
  const { tree } = app.render();
  assert.match(text(tree), /尚未开放直刷，请使用厂商工具/);
  assert.equal(button(tree, '开始刷机'), undefined);
  assert.deepEqual(calls, []);
  const workspace = readFileSync(new URL('../src/components/FirmwareWorkspace.jsx', import.meta.url), 'utf8');
  assert.match(workspace, /打开厂商工具/);
});

test('pre-write firmware rejections say the flash did not start, not that a write failed', async () => {
  const cases = [
    ['flash-firmware-content-unverified', /整包内容与已验收的直刷版本不一致/],
    ['flash-profile-no-match', /尚未完成应用内直刷验收/],
  ];
  for (const [code, detail] of cases) {
    const calls = [];
    const app = mount({
      firmwareDirectState: async () => ({ ok: true, enabled: true, modes: modeOptions, job: null }),
      firmwareDirectArm: async () => {
        calls.push('arm');
        return { ok: false, job: { id: 'job', firmwareId: readyFile.firmwareId, phase: 'failed', coldStart: true, code } };
      },
    }, { targetHint: null });
    await flush();
    button(app.render().tree, '等待设备上电').props.onClick();
    await flush();
    const tree = app.render().tree;
    assert.match(text(tree), /未开始刷机：固件校验未通过/);
    assert.doesNotMatch(text(tree), /刷机未完成|正在写入固件/);
    assert.match(text(nodes(tree).find(node => node.props.role === 'alert')), detail);
    assert.deepEqual(calls, ['arm']);
  }

  const failedWrite = mount({
    firmwareDirectState: async () => ({
      ok: true, enabled: true, modes: modeOptions,
      job: { id: 'job', firmwareId: readyFile.firmwareId, phase: 'failed', code: 'flash-completion-unconfirmed' },
    }),
  });
  await flush();
  const tree = failedWrite.render().tree;
  assert.match(text(tree), /刷机未完成/);
  assert.doesNotMatch(text(tree), /未开始刷机：固件校验未通过/);
});

test('a new ticket suppresses the old job while revalidation blocks starting until the chosen mode passes', async () => {
  const calls = [];
  const app = mount({
    firmwareDirectState: async () => ({
      ok: true, enabled: true, modes: modeOptions,
      job: { id: 'job', firmwareId: readyFile.firmwareId, phase: 'failed', code: 'flash-platform-mismatch' },
    }),
    firmwareDirectArm: async (platform, payload) => { calls.push([platform, copy(payload)]); return { ok: true }; },
  });
  await flush();
  assert.match(text(app.render().tree), /当前选择与固件或设备的刷机平台不匹配/);

  const replacement = verification => ({ ...readyFile, firmwareId: 'replacement-receipt', verification });
  const widget = (tree, phase) => nodes(tree).find(node => node.props['data-firmware-verification'] === phase);
  const checking = app.render(replacement({ phase: 'checking' })).tree;
  assert.doesNotMatch(text(checking), /当前选择与固件或设备的刷机平台不匹配/);
  assert.match(text(widget(checking, 'checking')), /正在重新校验整包固件，尚未写入设备/);
  assert.equal(button(checking, '开始刷机').props.disabled, true);
  button(checking, '开始刷机').props.onClick();

  const failed = app.render(replacement({ phase: 'failed', code: 'flash-firmware-content-unverified' })).tree;
  assert.match(text(widget(failed, 'failed')), /整包内容与已验收的直刷版本不一致/);
  assert.equal(button(failed, '开始刷机').props.disabled, true);
  button(failed, '开始刷机').props.onClick();
  assert.deepEqual(calls, []);

  const verified = replacement({ phase: 'passed', modes: ['firmware-upgrade'] });
  const invalidMode = app.render(verified).tree;
  assert.match(text(widget(invalidMode, 'passed')), /该固件不支持当前选择的直刷模式/);
  assert.equal(button(invalidMode, '开始刷机').props.disabled, true);
  nodes(invalidMode).find(node => node.props.ariaLabel === '刷机模式').props.onChange('firmware-upgrade');
  const approvedMode = app.render(verified).tree;
  assert.equal(button(approvedMode, '开始刷机').props.disabled, false);
  assert.deepEqual(calls, []);
  button(approvedMode, '开始刷机').props.onClick();
  await flush();
  assert.deepEqual(calls, [['mtk', { firmwareId: 'replacement-receipt', mode: 'firmware-upgrade', targetHint: 'usb1' }]]);
});

test('MTK requires an explicit review of the current file and mode before a separate arm click', async () => {
  const calls = [];
  const app = mount({
    firmwareDirectState: async () => ({ ok: true, enabled: true, modes: modeOptions, job: null, sessionReviewRequired: true }),
    firmwareDirectArm: async (platform, payload) => { calls.push(['arm', platform, copy(payload)]); return { ok: true }; },
  }, { targetHint: null, onReviewFirmware: (mode, options) => calls.push(['review', mode, copy(options)]) });
  await flush();
  const restored = app.render().tree;
  assert.equal(button(restored, '核对本次固件').props.disabled, false);
  assert.equal(button(restored, '等待设备上电').props.disabled, true);
  button(restored, '等待设备上电').props.onClick();
  assert.deepEqual(calls, []);

  const verification = { phase: 'review-required', modes: modeOptions, board: 'IFPD-G520', fingerprint: 'a'.repeat(64) };
  const unreviewed = app.render({ ...readyFile, verification }).tree;
  assert.match(text(unreviewed), /目标板卡：IFPD-G520/);
  assert.match(text(unreviewed), /aaaaaaaaaaaa…/);
  assert.doesNotMatch(text(unreviewed), new RegExp('a'.repeat(64)));
  button(unreviewed, '核对本次固件').props.onClick();
  assert.deepEqual(calls, [['review', 'download-only', { refresh: false }]]);
  const approved = { ...readyFile, verification: { ...verification, approvedMode: 'download-only' } };
  const ready = app.render(approved).tree;
  assert.match(text(ready), /已确认本次固件及刷机模式/);
  assert.equal(button(ready, '等待设备上电').props.disabled, false);
  nodes(ready).find(node => node.props.ariaLabel === '刷机模式').props.onChange('format-all-download');
  const switched = app.render(approved).tree;
  assert.match(text(switched), /格式化后下载会先清除存储/);
  assert.equal(button(switched, '等待设备上电').props.disabled, true);
  button(switched, '等待设备上电').props.onClick();
  assert.deepEqual(calls, [['review', 'download-only', { refresh: false }]]);
  nodes(switched).find(node => node.props.ariaLabel === '刷机模式').props.onChange('download-only');

  const replacement = app.render({ ...readyFile, firmwareId: 'new-file-receipt', verification }).tree;
  assert.equal(button(replacement, '等待设备上电').props.disabled, true);
  button(app.render(approved).tree, '等待设备上电').props.onClick();
  await flush();
  assert.deepEqual(calls[1], ['arm', 'mtk', { firmwareId: readyFile.firmwareId, mode: 'download-only', coldStart: true }]);
});

test('stale MTK job evidence prompts rechecking and cannot block the new review of the same ticket', async () => {
  const calls = [];
  const job = { id: 'stale-job', phase: 'failed', firmwareId: readyFile.firmwareId, code: 'flash-firmware-changed' };
  const app = mount({
    firmwareDirectState: async () => ({ ok: true, enabled: true, modes: modeOptions, job, sessionReviewRequired: true }),
  }, { targetHint: null, onReviewFirmware: (mode, options) => calls.push([mode, copy(options)]) });
  await flush();
  const verification = { phase: 'review-required', modes: modeOptions, board: 'IFPD-G520', fingerprint: 'a'.repeat(64), approvedMode: 'download-only' };
  const stale = app.render({ ...readyFile, verification }).tree;
  assert.match(text(stale), /本次核对已失效/);
  assert.equal(button(stale, '等待设备上电').props.disabled, true);
  button(stale, '核对本次固件').props.onClick();
  assert.deepEqual(calls, [['download-only', { refresh: true, jobId: job.id }]]);
  const renewed = app.render({ ...readyFile, verification: { ...verification, reviewedJobId: job.id } }).tree;
  assert.doesNotMatch(text(renewed), /本次核对已失效|刷机未完成/);
  assert.equal(button(renewed, '等待设备上电').props.disabled, false);
});

test('MTK quick check permits an explicit one-step arm without a separate approval click or fingerprint', async () => {
  const calls = [];
  const app = mount({
    firmwareDirectState: async () => ({ ok: true, enabled: true, modes: modeOptions, job: null,
      sessionReviewRequired: true, mtkAutoPowerOn: true, mtkFastReview: true }),
    firmwareDirectArm: async (platform, payload) => {
      calls.push(['arm', platform, copy(payload)]);
      return { ok: true, job: { id: 'stale-quick', phase: 'failed', firmwareId: payload.firmwareId, code: 'flash-firmware-changed' } };
    },
  }, { targetHint: null, onReviewFirmware: (mode, options) => calls.push(['check', mode, copy(options)]) });
  await flush();
  assert.equal(app.render().direct.mtkFastReview, true);
  assert.equal(button(app.render().tree, '检查固件').props.disabled, false);
  assert.equal(button(app.render().tree, '准备上电自动刷机').props.disabled, true);
  const checking = app.render({ ...readyFile, verification: { phase: 'checking' } }).tree;
  assert.match(text(checking), /正在检查固件及依赖文件/);
  assert.doesNotMatch(text(checking), /重新校验整包固件/);
  assert.equal(button(checking, '准备上电自动刷机').props.disabled, true);

  const file = { ...readyFile, verification: { phase: 'review-required', quickReview: true,
    modes: ['download-only', 'format-all-download'], board: 'IFPD-G520' } };
  const checked = app.render(file).tree;
  assert.match(text(checked), /固件结构及依赖已检查/);
  assert.doesNotMatch(text(checked), /SHA-256|整包校验|尚未开始等待上电，请先核对本次固件/);
  assert.equal(button(checked, '核对本次固件'), undefined);
  assert.equal(button(checked, '准备上电自动刷机').props.disabled, false);
  assert.deepEqual(calls, []);

  nodes(checked).find(node => node.props.ariaLabel === '刷机模式').props.onChange('firmware-upgrade');
  assert.equal(button(app.render(file).tree, '准备上电自动刷机').props.disabled, true);
  nodes(checked).find(node => node.props.ariaLabel === '刷机模式').props.onChange('format-all-download');
  const format = app.render(file).tree;
  assert.match(text(format), /格式化后下载会先清除存储/);
  button(format, '准备上电自动刷机').props.onClick();
  await flush();
  assert.deepEqual(calls, [['arm', 'mtk', { firmwareId: file.firmwareId, mode: 'format-all-download', coldStart: true }]]);

  const stale = app.render(file).tree;
  assert.equal(button(stale, '准备上电自动刷机').props.disabled, true);
  assert.match(text(stale), /固件检查已失效/);
  button(stale, '重新检查固件').props.onClick();
  assert.deepEqual(calls[1], ['check', 'format-all-download', { refresh: true, jobId: 'stale-quick', checkOnly: true }]);
  const fresh = app.render({ ...file, verification: { ...file.verification, reviewedJobId: 'stale-quick' } }).tree;
  assert.equal(button(fresh, '准备上电自动刷机').props.disabled, false);
  assert.deepEqual(calls.map(call => call[0]), ['arm', 'check']);
});

test('MTK cold automation needs neither a port nor a device after the waiting job is armed', async () => {
  const calls = [];
  const verification = { phase: 'review-required', modes: modeOptions, board: 'IFPD-G520', fingerprint: 'a'.repeat(64) };
  const reviewed = { ...readyFile, verification: { ...verification, approvedMode: 'download-only' } };
  let job = null;
  const app = mount({
    firmwareDirectState: async () => ({ ok: true, enabled: true, modes: modeOptions, job, sessionReviewRequired: true, mtkAutoPowerOn: true }),
    firmwareDirectArm: async (platform, payload) => {
      calls.push(['arm', platform, copy(payload)]);
      job = { id: 'auto', firmwareId: readyFile.firmwareId, phase: 'preparing', autoPowerOn: true, coldStart: true };
      return { ok: true, job };
    },
    firmwareDirectChoose: async () => calls.push(['choose']),
    firmwareDirectEnterLoader: async () => calls.push(['loader']),
    firmwareDirectRegisterTarget: async () => calls.push(['register']),
  }, { targetHint: null, onReviewFirmware: () => {} });
  await flush();
  const unreviewed = app.render({ ...readyFile, verification }).tree;
  assert.match(text(unreviewed), /尚未开始等待上电，请先核对本次固件/);
  assert.match(text(unreviewed), /不需要预先识别 COM 端口.*保持断电/);
  assert.equal(button(unreviewed, '登记当前 USB 目标'), undefined);
  assert.equal(button(unreviewed, '准备上电自动刷机').props.disabled, true);
  button(unreviewed, '准备上电自动刷机').props.onClick();
  assert.deepEqual(calls, []);
  button(app.render(reviewed).tree, '准备上电自动刷机').props.onClick();
  app.render(reviewed);
  await flush();
  app.render(reviewed);
  await flush();
  for (const phase of ['preparing', 'confirming', 'authorizing']) {
    job = { ...job, phase };
    app.tick();
    await flush();
    const { tree, direct } = app.render(reviewed);
    assert.equal(direct.mtkAutoPowerOn, true);
    assert.match(text(tree), /请保持目标设备断电.*刷机工具提示就绪/);
    assert.doesNotMatch(text(tree), /现在给设备上电/);
  }
  job = { ...job, phase: 'armed', entryAvailable: true };
  app.tick();
  await flush();
  const armed = app.render(reviewed).tree;
  assert.match(text(armed), /刷机工具已就绪.*现在给设备上电.*自动开始刷机/);
  assert.match(text(armed), /只连接这台待刷设备.*不要更换 USB 口/);
  assert.equal(button(armed, '进入刷机模式'), undefined);
  assert.equal(button(armed, '准备上电自动刷机'), undefined);
  assert.deepEqual(calls, [['arm', 'mtk', { firmwareId: readyFile.firmwareId, mode: 'download-only', coldStart: true }]]);

  job = { ...job, phase: 'writing', percent: 23 };
  app.tick();
  await flush();
  const writing = app.render(reviewed).tree;
  assert.doesNotMatch(text(writing), /现在给设备上电/);
  assert.equal(nodes(writing).find(node => node.type === 'progress').props.value, 23);
});

test('MTK rejects already connected flash targets before claiming it is ready to power on', async () => {
  const app = mount({
    firmwareDirectState: async () => ({ ok: true, enabled: true, modes: ['download-only'], mtkAutoPowerOn: true, job: null }),
    firmwareDirectArm: async () => ({ ok: false, code: 'flash-mtk-auto-target-present' }),
  }, { targetHint: null });
  await flush();
  button(app.render().tree, '准备上电自动刷机').props.onClick();
  await flush();
  const tree = app.render().tree;
  assert.match(text(tree), /单设备自动直刷要求其他刷机设备先断开，目标设备先断电/);
  assert.doesNotMatch(text(tree), /刷机工具已就绪|现在给设备上电/);
});

test('RK whole-package upgrade also needs session review before starting', async () => {
  const calls = [];
  const app = mount({
    firmwareDirectState: async () => ({ ok: true, enabled: true, modes: ['upgrade'], job: null, sessionReviewRequired: true }),
    firmwareDirectArm: async (platform, payload) => { calls.push(['arm', platform, copy(payload)]); return { ok: true }; },
  }, { platform: 'rk', targetHint: null, onReviewFirmware: (mode, options) => calls.push(['review', mode, copy(options)]) });
  await flush();
  const verification = { phase: 'review-required', modes: ['upgrade'], board: 'RK board', fingerprint: 'e'.repeat(64) };
  const unreviewed = app.render({ ...readyFile, verification }).tree;
  assert.match(text(unreviewed), /整包升级/);
  assert.equal(button(unreviewed, '等待设备上电').props.disabled, true);
  button(unreviewed, '核对本次固件').props.onClick();
  assert.deepEqual(calls, [['review', 'upgrade', { refresh: false }]]);
  const ready = app.render({ ...readyFile, verification: { ...verification, approvedMode: 'upgrade' } }).tree;
  assert.equal(button(ready, '等待设备上电').props.disabled, false);
  assert.equal(button(ready, '核对本次固件'), undefined);
  button(ready, '等待设备上电').props.onClick();
  await flush();
  assert.deepEqual(calls[1], ['arm', 'rk', { firmwareId: readyFile.firmwareId, mode: 'upgrade', coldStart: true }]);
});

test('unverified content shows only current-file handoff actions; every action is explicit', async () => {
  const calls = [];
  const mismatch = 'flash-firmware-content-unverified';
  const previous = { id: 'job', firmwareId: 'previous-receipt', phase: 'failed', code: mismatch };
  const app = mount({
    firmwareDirectState: async () => ({ ok: true, enabled: true, modes: modeOptions, job: previous }),
    firmwareDirectArm: async () => { calls.push('arm'); return { ok: true }; },
  }, {
    onCopyFirmwarePath: () => calls.push('path'),
    onCopyFirmwareFingerprint: () => calls.push('fingerprint'),
    onOpenVendor: () => calls.push('vendor'),
    handoffFeedback: 'Fixture handoff feedback',
  });
  const actions = tree => nodes(tree).find(node => Object.hasOwn(node.props, 'data-firmware-mismatch-actions'));
  const file = { ...readyFile, filePath: 'C:/fixture/flash.xml' };
  const fingerprint = '0123456789abcdef'.repeat(4);
  const rejected = { ...file, verification: { phase: 'failed', code: mismatch, fingerprint } };
  await flush();
  assert.equal(actions(app.render(file).tree), undefined, 'an old receipt must not expose actions for a new file');
  assert.equal(actions(app.render({ ...rejected, ok: false }).tree), undefined);

  const tree = app.render(rejected).tree;
  const shown = actions(tree);
  assert.match(text(shown), /同一路径重新下载的固件不会继承旧包/);
  assert.match(text(shown), /0123456789ab…/);
  assert.doesNotMatch(text(shown), new RegExp(fingerprint));
  assert.match(text(shown), /打开工具不会开始刷机/);
  assert.match(text(shown), /Fixture handoff feedback/);
  assert.equal(button(tree, '开始刷机').props.disabled, true);
  assert.deepEqual(calls, [], 'rendering a rejection does not launch, copy or arm');
  for (const label of ['复制固件路径', '复制完整指纹', '打开厂商工具']) button(shown, label).props.onClick();
  assert.deepEqual(calls, ['path', 'fingerprint', 'vendor']);

  const blocked = actions(app.render(rejected, true).tree);
  for (const label of ['复制固件路径', '复制完整指纹', '打开厂商工具']) {
    assert.equal(button(blocked, label).props.disabled, true);
    button(blocked, label).props.onClick();
  }
  assert.equal(calls.length, 3);
  assert.equal(button(actions(app.render({ ...rejected, verification: { ...rejected.verification, fingerprint: 'bad' } }).tree), '复制完整指纹'), undefined);

  const terminal = app.render({ ...file, firmwareId: previous.firmwareId }).tree;
  assert.ok(button(actions(terminal), '打开厂商工具'));
  assert.equal(button(actions(terminal), '复制完整指纹'), undefined);
  assert.equal(button(terminal, '开始刷机').props.disabled, true);
});

test('only a click arms the selected firmware, explicit mode and optional USB hint', async () => {
  const calls = [];
  const options = { targetHint: 'usb1' };
  const app = mount({
    firmwareDirectState: async () => ({ ok: true, enabled: true, modes: modeOptions, job: null, savedTarget: { label: 'Older registration' } }),
    firmwareDirectArm: async (platform, input) => {
      calls.push([platform, copy(input)]);
      return { ok: true, job: { id: 'job', phase: 'waiting' } };
    },
  }, options);
  await flush();
  assert.equal(button(app.render({ ok: true }).tree, '开始刷机').props.disabled, true);
  const select = nodes(app.render().tree).find(node => node.type === 'selection');
  assert.equal(select.props.value, 'download-only');
  assert.match(text(app.render().tree), /当前 USB 设备/);
  assert.doesNotMatch(text(app.render().tree), /Older registration/);
  changeTarget(app, 'saved');
  assert.match(text(app.render().tree), /Older registration/);
  options.targetHint = 'usb2';
  assert.match(text(app.render().tree), /当前 USB 设备/);
  assert.doesNotMatch(text(app.render().tree), /先备份|清除存储/);
  select.props.onChange('firmware-upgrade');
  const upgrade = app.render().tree;
  const arm = button(upgrade, '开始刷机');
  const note = nodes(upgrade).find(node => node.props.id === arm.props['aria-describedby']);
  assert.match(text(note), /固件升级可能改写分区并清除数据，请先备份/);
  assert.equal(arm.props.disabled, false);
  assert.deepEqual(calls, []);
  arm.props.onClick();
  await flush();
  assert.deepEqual(calls, [['mtk', { firmwareId: 'private-receipt', mode: 'firmware-upgrade', targetHint: 'usb2' }]]);
  assert.match(text(app.render().tree), /请手动让目标设备进入刷机模式/);
});

for (const platform of ['rk', 'mtk']) test(`${platform} tool setup is explicit and never starts a write`, async () => {
  let toolReady = false;
  const calls = [];
  const app = mount({
    firmwareDirectState: async () => ({ ok: true, enabled: true, modes: [platform === 'rk' ? 'upgrade' : 'download-only'], toolReady }),
    firmwareDirectPrepareTool: async (...args) => {
      calls.push(['setup', ...copy(args)]);
      if (calls.length === 1) return { ok: false, cancelled: true };
      toolReady = true;
      return { ok: true, toolReady };
    },
    firmwareDirectArm: async () => { calls.push(['arm']); return { ok: true }; },
  }, { platform });
  await flush();
  const primary = platform === 'rk' ? '下载 RK 直刷工具' : '准备刷机工具';
  assert.equal(button(app.render().tree, '开始刷机'), undefined);
  assert.deepEqual(calls, []);
  button(app.render().tree, primary).props.onClick();
  await flush();
  assert.deepEqual(calls, [['setup', platform]]);
  assert.equal(nodes(app.render().tree).find(node => node.props.role === 'alert'), undefined);
  button(app.render().tree, platform === 'rk' ? '选择本机工具' : primary).props.onClick();
  await flush();
  assert.deepEqual(calls[1], ['setup', platform, ...(platform === 'rk' ? [{ local: true }] : [])]);
  assert.equal(calls.length, 2);
  button(app.render().tree, '开始刷机').props.onClick();
  await flush();
  assert.deepEqual(calls.at(-1), ['arm']);
});

test('hardware-confirmed MTK writes show success without claiming boot verification', async () => {
  const state = phase => async () => ({ ok: true, enabled: true, modes: modeOptions, job: { id: 'job', firmwareId: readyFile.firmwareId, phase, percent: 100 } });
  const mtk = mount({ firmwareDirectState: state('written') });
  const rk = mount({ firmwareDirectState: state('written') }, { platform: 'rk' });
  await flush();
  assert.match(text(mtk.render().tree), /固件写入成功/);
  assert.doesNotMatch(text(mtk.render().tree), /已完成并验证/);
  assert.match(text(rk.render().tree), /固件已写入，设备启动未验证/);
});

test('a restricted destructive mode is opt-in and stays blocked during other actions', async () => {
  const calls = [];
  const app = mount({
    firmwareDirectState: async () => ({ ok: true, enabled: true, modes: ['format-all-download'], job: null }),
    firmwareDirectArm: async (platform, input) => {
      calls.push([platform, copy(input)]);
      return { ok: true, job: { id: 'job', firmwareId: readyFile.firmwareId, phase: 'failed', code: 'flash-mode-mismatch' } };
    },
  });
  await flush();
  const initial = app.render().tree;
  const select = nodes(initial).find(node => node.type === 'selection');
  assert.equal(select.props.value, undefined);
  assert.equal(button(initial, '开始刷机').props.disabled, true);
  button(initial, '开始刷机').props.onClick();
  select.props.onChange('format-all-download');

  const blocked = app.render(readyFile, true).tree;
  const blockedStart = button(blocked, '开始刷机');
  assert.equal(blockedStart.props.disabled, true);
  assert.equal(nodes(blocked).find(node => node.type === 'selection').props.disabled, true);
  const note = nodes(blocked).find(node => node.props.id === blockedStart.props['aria-describedby']);
  assert.match(text(note), /格式化后下载会先清除存储，可能影响设备配置和校准数据/);
  blockedStart.props.onClick();
  assert.deepEqual(calls, []);

  button(app.render().tree, '开始刷机').props.onClick();
  await flush();
  assert.deepEqual(calls, [['mtk', { firmwareId: 'private-receipt', mode: 'format-all-download', targetHint: 'usb1' }]]);
  assert.match(text(app.render().tree), /刷机工具执行模式与所选模式不一致，未确认刷写结果/);
});

test('a saved MTK target is ready without extra setup when no explicit device is selected', async () => {
  const calls = [];
  const app = mount({
    firmwareDirectState: async () => ({
      ok: true, enabled: true, modes: modeOptions, job: null, savedTarget: { label: 'Recorded G520', port: 'COM4' },
    }),
    firmwareDirectArm: async (platform, input) => {
      calls.push([platform, copy(input)]);
      return { ok: true, job: { id: 'job', phase: 'authorizing' } };
    },
  }, { targetHint: null });
  await flush();
  const { tree } = app.render();
  assert.match(text(tree), /Recorded G520\s*·\s*COM4/);
  assert.equal(button(tree, '更换目标').props['aria-expanded'], false);
  assert.ok(button(tree, '改为等待上电'));
  assert.deepEqual(calls, []);
  button(app.render().tree, '开始刷机').props.onClick();
  await flush();
  assert.deepEqual(calls, [['mtk', { firmwareId: 'private-receipt', mode: 'download-only', useSavedTarget: true }]]);
  assert.equal(button(app.render().tree, '更换目标'), undefined);
});

test('a failed attempt to register does not switch a device card to a previous target', async () => {
  const calls = [];
  const app = mount({
    firmwareDirectState: async () => ({ ok: true, enabled: true, modes: modeOptions, savedTarget: { label: 'Old target' } }),
    firmwareDirectRegisterTarget: async () => ({ ok: false, code: 'flash-anchor-required' }),
    firmwareDirectArm: async (_platform, input) => { calls.push(copy(input)); return { ok: true }; },
  }, { targetHint: 'current-board' });
  await flush();
  button(app.render().tree, '更换目标').props.onClick();
  button(app.render().tree, '登记当前 USB 目标').props.onClick();
  await flush();
  button(app.render().tree, '开始刷机').props.onClick();
  await flush();
  assert.deepEqual(calls, [{ firmwareId: 'private-receipt', mode: 'download-only', targetHint: 'current-board' }]);
});

for (const platform of ['rk', 'mtk']) test(`${platform} defaults to cold with no USB hint or registration and requires explicit selection`, async () => {
  const rk = platform === 'rk';
  const mode = rk ? 'upgrade' : 'download-only';
  const calls = [];
  let job = null;
  const app = mount({
    firmwareDirectState: async () => ({ ok: true, enabled: true, modes: [mode], job }),
    firmwareDirectArm: async (platform, input) => {
      calls.push(['arm', platform, copy(input)]);
      job = { id: 'job', phase: 'preparing', coldStart: true };
      return { ok: true, job };
    },
    firmwareDirectChoose: async (platform, input) => {
      calls.push(['choose', platform, copy(input)]);
      return { ok: true, job };
    },
    firmwareDirectEnterLoader: async () => assert.fail('Cold flow must never offer ADB reboot'),
  }, { platform, targetHint: null });
  await flush();
  assert.match(text(app.render().tree), /等待设备上电（无需 ADB 或登记）/);
  assert.deepEqual(calls, []);
  button(app.render().tree, '等待设备上电').props.onClick();
  app.render();
  await flush();
  assert.deepEqual(calls, [['arm', platform, { firmwareId: 'private-receipt', mode, coldStart: true }]]);
  assert.match(text(app.render().tree), /等到界面提示等待刷机设备后，再给断电的设备上电/);
  await flush();
  job = { ...job, phase: 'waiting' };
  app.tick();
  await flush();
  assert.match(text(app.render().tree), rk ? /断电上电或长按电源键进入 Loader \/ Maskrom/ : /连接 Touch 线.*上电进入 Download/);
  job = { ...job, phase: 'choice-required', candidates: [{ id: 'usb-port', label: 'Detected board' }] };
  app.tick();
  await flush();
  const choice = app.render().tree;
  assert.match(text(choice), /选定目标并确认前不会写入/);
  assert.equal(calls.length, 1);
  button(choice, 'Detected board').props.onClick();
  await flush();
  assert.deepEqual(calls[1], ['choose', platform, { jobId: 'job', targetId: 'usb-port' }]);
  if (!rk) {
    job = { ...job, phase: 'armed', entryAvailable: true };
    app.tick();
    await flush();
    assert.match(text(app.render().tree), /下载端口已消失.*同一台设备.*USB 口.*重新上电/);
    assert.equal(button(app.render().tree, '进入刷机模式'), undefined);
  }
});

test('the cold shortcut is visible with a device-card hint but only changes the selection', async () => {
  const calls = [];
  const app = mount({
    firmwareDirectState: async () => ({ ok: true, enabled: true, modes: ['download-only'], job: null, savedTarget: { label: 'Saved' } }),
    firmwareDirectArm: async (_platform, input) => { calls.push(copy(input)); return { ok: true }; },
  }, { targetHint: 'usb1' });
  await flush();
  assert.ok(button(app.render().tree, '开始刷机'));
  button(app.render().tree, '改为等待上电').props.onClick();
  assert.deepEqual(calls, []);
  assert.match(text(app.render().tree), /等待设备上电（无需 ADB 或登记）/);
  button(app.render().tree, '等待设备上电').props.onClick();
  await flush();
  assert.deepEqual(calls, [{ firmwareId: 'private-receipt', mode: 'download-only', coldStart: true }]);
});

test('cold MTK port failure shows same-port retry instead of demanding registration', async () => {
  const app = mount({
    firmwareDirectState: async () => ({
      ok: true, enabled: true, modes: ['download-only'],
      job: { id: 'job', firmwareId: readyFile.firmwareId, phase: 'failed', coldStart: true, code: 'flash-mtk-port-unknown' },
    }),
  });
  await flush();
  const output = text(app.render().tree);
  assert.match(output, /未能确认 MTK 下载端口.*同一 USB 口.*重试等待上电/);
  assert.doesNotMatch(output, /回到 Android/);
});

for (const platform of ['mtk', 'rk']) test(`registering a ${platform} target needs no firmware and does not arm until explicitly selected`, async () => {
  const calls = [];
  const rk = platform === 'rk';
  const mode = rk ? 'upgrade' : 'download-only';
  let savedTarget = null;
  let finishRegistration;
  const registration = new Promise(resolve => { finishRegistration = resolve; });
  const app = mount({
    firmwareDirectState: async () => ({ ok: true, enabled: true, modes: [mode], job: null, savedTarget }),
    firmwareDirectRegisterTarget: async (...args) => {
      calls.push(['register', ...args]);
      return registration;
    },
    firmwareDirectArm: async (platform, input) => {
      calls.push(['arm', platform, copy(input)]);
      return { ok: true, job: { id: 'job', phase: rk ? 'waiting' : 'authorizing' } };
    },
  }, { platform, targetHint: null });
  await flush();
  const initial = app.render({ ok: false }).tree;
  assert.deepEqual(calls, []);
  assert.equal(button(initial, '等待设备上电').props.disabled, true);
  assert.doesNotMatch(text(initial), /使用已保存的 USB 目标/);
  assert.match(text(initial), /先通过 USB 调试连接目标设备，再登记/);
  const register = button(initial, '登记当前 USB 目标');
  assert.equal(register.props.disabled, false);
  register.props.onClick();
  register.props.onClick();
  const pending = app.render({ ok: false }).tree;
  assert.equal(button(pending, '登记当前 USB 目标').props['aria-busy'], true);
  assert.doesNotMatch(text(pending), /正在核对刷机固件/);

  savedTarget = rk ? { label: 'Verified G520' } : { label: 'Verified G520', port: 'COM5' };
  finishRegistration({ ok: true, savedTarget });
  await flush();
  const ready = app.render().tree;
  assert.match(text(ready), rk ? /Verified G520/ : /Verified G520\s*·\s*COM5/);
  assert.deepEqual(calls, [['register', platform]]);
  if (rk) {
    changeTarget(app, 'cold');
    changeTarget(app, 'saved');
  }
  button(app.render().tree, '开始刷机').props.onClick();
  await flush();
  assert.deepEqual(calls, [['register', platform], ['arm', platform, { firmwareId: 'private-receipt', mode, useSavedTarget: true }]]);
  const waiting = app.render().tree;
  assert.equal(button(waiting, '登记当前 USB 目标'), undefined);
  if (rk) {
    assert.match(text(waiting), /保持同一 USB 口.*进入 Loader \/ Maskrom/);
    assert.doesNotMatch(text(waiting), /识别后选定目标/);
  }
});

test('environment checks and firmware staging are distinct from device write progress', async () => {
  let job = { id: 'job', phase: 'preparing', preparation: 'checking-environment' };
  const app = mount({ firmwareDirectState: async () => ({ ok: true, enabled: true, modes: modeOptions, job }) });
  await flush();
  const checking = app.render().tree;
  assert.match(text(checking), /正在检查工具、USB 和磁盘空间/);
  assert.equal(nodes(checking).find(node => node.type === 'progress'), undefined);
  job = { ...job, preparation: 'staging-firmware', preparationPercent: 48.7 };
  app.tick();
  await flush();
  const staging = app.render().tree;
  const progress = nodes(staging).find(node => node.type === 'progress');
  assert.equal(progress.props['aria-label'], '固件准备进度');
  assert.equal(progress.props.value, 48);
  assert.match(text(staging), /正在准备文件，尚未写入设备/);
  assert.match(text(staging), /工具就绪前请保持 USB 连接和供电，不要重启或断电/);
  job = { ...job, phase: 'writing', percent: 10 };
  app.tick();
  await flush();
  const writing = app.render().tree;
  assert.equal(nodes(writing).find(node => node.type === 'progress').props['aria-label'], '刷机进度');
  assert.doesNotMatch(text(writing), /尚未写入设备|48%/);
});

test('a cross-platform rejection shows one no-write alert and no write progress', async () => {
  const app = mount({
    firmwareDirectState: async () => ({ ok: true, enabled: true, modes: ['upgrade'], job: null }),
    firmwareDirectArm: async () => ({
      ok: false, code: 'flash-platform-mismatch', job: { id: 'job', firmwareId: readyFile.firmwareId, phase: 'failed', code: 'flash-platform-mismatch' },
    }),
  }, { platform: 'rk' });
  await flush();
  button(app.render().tree, '开始刷机').props.onClick();
  await flush();
  const failed = app.render().tree;
  const notices = nodes(failed).filter(node => node.props.role === 'alert');
  assert.equal(notices.length, 1);
  assert.match(text(notices[0]), /固件或设备的刷机平台不匹配，未启动写入/);
  assert.equal(nodes(failed).find(node => node.type === 'progress'), undefined);
});

test('one waiting job can be polled and chosen without another arm or automatic selection', async () => {
  const calls = [];
  let state = { id: 'job', phase: 'waiting' };
  const app = mount({
    firmwareDirectState: async platform => {
      calls.push(['state', platform]);
      return { ok: true, enabled: true, modes: modeOptions, job: state };
    },
    firmwareDirectChoose: async (platform, input) => {
      calls.push(['choose', platform, copy(input)]);
      state = { ...state, phase: 'checking' };
      return { ok: true, job: state };
    },
  });
  await flush();
  assert.ok(button(app.render().tree, '取消'));
  assert.equal(button(app.render().tree, '开始刷机'), undefined);
  state = { id: 'job', phase: 'choice-required', candidates: [{ id: 'a', label: 'USB A' }, { id: 'b', label: 'USB B' }] };
  app.tick();
  await flush();
  const choiceView = app.render().tree;
  assert.equal(button(choiceView, 'USB A').type, 'button');
  assert.deepEqual(calls.map(entry => entry[0]), ['state', 'state']);
  button(choiceView, 'USB B').props.onClick();
  await flush();
  assert.ok(calls.some(entry => entry[0] === 'choose' && entry[2].targetId === 'b'));
  assert.equal(button(app.render().tree, '取消'), undefined);
});

test('cancelling while waiting addresses only the visible job', async () => {
  const calls = [];
  const app = mount({
    firmwareDirectState: async () => ({ ok: true, enabled: true, modes: modeOptions, job: { id: 'job', phase: 'waiting' } }),
    firmwareDirectCancel: async (platform, id) => {
      calls.push([platform, id]);
      return { ok: true, job: { id, firmwareId: readyFile.firmwareId, phase: 'cancelled' } };
    },
  });
  await flush();
  button(app.render().tree, '取消').props.onClick();
  await flush();
  assert.deepEqual(calls, [['mtk', 'job']]);
  assert.match(text(app.render().tree), /等待已取消/);
});

test('the target must stay powered until armed, then entering flashing mode is an explicit action', async () => {
  const calls = [];
  let job = { id: 'job', phase: 'preparing', entryAvailable: true };
  const app = mount({
    firmwareDirectState: async () => ({ ok: true, enabled: true, modes: modeOptions, job }),
    firmwareDirectEnterLoader: async (platform, id) => {
      calls.push([platform, id]);
      job = { ...job, entryRequested: true };
      return { ok: true, job };
    },
  });
  await flush();
  for (const phase of ['preparing', 'confirming', 'authorizing']) {
    job = { ...job, phase };
    app.tick();
    await flush();
    const { tree } = app.render();
    assert.match(text(tree), /工具就绪前请保持 USB 连接和供电，不要重启或断电/);
    assert.equal(button(tree, '进入刷机模式'), undefined);
  }

  job = { ...job, phase: 'armed', entryAvailable: false };
  app.tick();
  await flush();
  assert.match(text(app.render().tree), /工具就绪后，将 Touch 线接到已登记的电脑 USB 口，再给目标设备断电上电/);
  assert.equal(button(app.render().tree, '进入刷机模式'), undefined);

  job = { ...job, entryAvailable: true };
  app.tick();
  await flush();
  const armed = app.render().tree;
  assert.match(text(armed), /无需手动重启设备/);
  assert.deepEqual(calls, []);
  button(armed, '进入刷机模式').props.onClick();
  await flush();
  const requested = app.render().tree;
  assert.match(text(requested), /已请求进入刷机模式，正在等待设备出现/);
  assert.doesNotMatch(text(requested), /断电上电/);
  assert.equal(button(requested, '进入刷机模式').props.disabled, true);
  button(requested, '进入刷机模式').props.onClick();
  assert.deepEqual(calls, [['mtk', 'job']]);
});

test('writing has progress, no cancel action, and no reads while the workspace is hidden', async () => {
  let reads = 0;
  const app = mount({
    firmwareDirectState: async () => {
      reads++;
      return { ok: true, enabled: true, modes: modeOptions, job: { id: 'job', phase: 'writing', percent: 35 } };
    },
  });
  await flush();
  const { tree } = app.render();
  assert.equal(nodes(tree).find(node => node.type === 'progress').props.value, 35);
  assert.equal(button(tree, '取消'), undefined);
  app.active(false);
  app.render();
  app.tick();
  assert.equal(reads, 1);
  app.active(true);
  app.render();
  await flush();
  assert.equal(reads, 2);
});

test('MTK reports local progress honestly and keeps a full write bar while verifying', async () => {
  let job = { id: 'job', phase: 'writing', progressStage: 'formatting', stagePercent: 62.7 };
  const app = mount({ firmwareDirectState: async () => ({ ok: true, enabled: true, modes: modeOptions, job }) });
  const progress = tree => nodes(tree).find(node => node.type === 'progress').props.value;
  await flush();
  const formatting = app.render().tree;
  assert.equal(progress(formatting), 62);
  assert.match(text(formatting), /正在格式化设备存储/);
  assert.match(text(formatting), /当前阶段 62%/);

  job = { ...job, progressStage: 'writing', part: 2, total: 7, partPercent: 48 };
  app.tick();
  await flush();
  const partition = nodes(app.render().tree).find(node => node.type === 'progress');
  assert.equal(partition.props.value, 48);
  assert.equal(partition.props['aria-label'], '当前分区 2/7 · 48%');

  job = { ...job, progressStage: 'writing', part: 2, total: 7, partPercent: 48, percent: 35 };
  app.tick();
  await flush();
  const writing = app.render().tree;
  assert.equal(progress(writing), 35);
  assert.match(text(writing), /当前分区 2\/7 · 48%/);
  assert.doesNotMatch(text(writing), /未报告准确总进度|当前阶段 62%/);

  job = { ...job, phase: 'verifying' };
  app.tick();
  await flush();
  const verifying = app.render().tree;
  assert.equal(progress(verifying), 100);
  assert.match(text(verifying), /正在验证刷机结果/);
  assert.doesNotMatch(text(verifying), /当前分区|固件写入成功/);
});
