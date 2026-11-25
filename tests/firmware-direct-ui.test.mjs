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
  const state = phase => async () => ({ ok: true, enabled: true, modes: modeOptions, job: { id: 'job', phase, percent: 100 } });
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
      return { ok: true, job: { id: 'job', phase: 'failed', code: 'flash-mode-mismatch' } };
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

test('RK cold start sends no ADB hint and requires explicit selection of a detected board', async () => {
  const calls = [];
  let job = null;
  const app = mount({
    firmwareDirectState: async () => ({ ok: true, enabled: true, modes: ['upgrade'], job }),
    firmwareDirectArm: async (platform, input) => {
      calls.push(['arm', platform, copy(input)]);
      job = { id: 'job', phase: 'waiting', coldStart: true };
      return { ok: true, job };
    },
    firmwareDirectChoose: async (platform, input) => {
      calls.push(['choose', platform, copy(input)]);
      return { ok: true, job };
    },
  }, { platform: 'rk' });
  await flush();
  assert.match(text(app.render().tree), /当前 USB 设备/);
  changeTarget(app, 'cold');
  assert.match(text(app.render().tree), /未登记的 RK 板卡（无需 ADB，识别后手动选择）/);
  assert.deepEqual(calls, []);
  button(app.render().tree, '开始刷机').props.onClick();
  app.render();
  await flush();
  assert.deepEqual(calls, [['arm', 'rk', { firmwareId: 'private-receipt', mode: 'upgrade', coldStart: true }]]);
  assert.match(text(app.render().tree), /断电上电或长按电源键进入 Loader \/ Maskrom/);
  await flush();
  job = { ...job, phase: 'choice-required', candidates: [{ id: 'rk-port', label: 'RK G520' }] };
  app.tick();
  await flush();
  const choice = app.render().tree;
  assert.match(text(choice), /选定目标并确认前不会写入/);
  assert.equal(calls.length, 1);
  button(choice, 'RK G520').props.onClick();
  await flush();
  assert.deepEqual(calls[1], ['choose', 'rk', { jobId: 'job', targetId: 'rk-port' }]);
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
  assert.equal(button(initial, '开始刷机').props.disabled, true);
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
      ok: false, code: 'flash-platform-mismatch', job: { id: 'job', phase: 'failed', code: 'flash-platform-mismatch' },
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
      return { ok: true, job: { id, phase: 'cancelled' } };
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
