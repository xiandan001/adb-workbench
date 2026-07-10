// 版本更新说明（changelog）- 每次发版时在这里添加对应版本的更新内容
// 格式：{ title, date, items: [{ type: 'feature'|'fix'|'improve', text }] }
// type 对应不同颜色标签：feature(绿色新增) fix(红色修复) improve(蓝色优化)
const CHANGELOGS = {
  '4.1.2': {
    title: 'v4.1.2',
    date: '2026-07-10',
    items: [
      { type: 'improve', text: '优化应用性能' },
      { type: 'fix', text: '修复部分错误' }
    ]
  },
  '4.1.1': {
    title: 'v4.1.1',
    date: '2026-07-09',
    items: [
      { type: 'feature', text: '产物中心新增单个删除、多选删除和一键清理' },
      { type: 'improve', text: '产物删除改为移入系统回收站' },
      { type: 'improve', text: '优化产物列表删除按钮布局' }
    ]
  },
  '4.1.0': {
    title: 'v4.1.0',
    date: '2026-07-09',
    items: [
      { type: 'feature', text: 'APK 管理新增应用列表隐藏开关' },
      { type: 'improve', text: '优化偏好设置分组导航与固定导航展示' },
      { type: 'improve', text: '优化会员中心页面布局与权益对比展示' },
      { type: 'improve', text: '优化性能监控顶部工具栏布局' },
      { type: 'improve', text: '优化应用性能' },
      { type: 'fix', text: '修复部分错误' }
    ]
  },
  '4.0.1': {
    title: 'v4.0.1',
    date: '2026-07-08',
    items: [
      { type: 'feature', text: '新增质量中心保存路径设置' },
      { type: 'improve', text: '优化会员中心功能对比展示' },
      { type: 'improve', text: '优化质量中心刷新体验' },
      { type: 'fix', text: '修复部分错误' }
    ]
  },
  '4.0.0': {
    title: 'v4.0.0',
    date: '2026-07-08',
    items: [
      { type: 'feature', text: '新增质量中心：支持回归差异报告、一键验收套餐和设备守护' },
      { type: 'improve', text: '连接历史入口调整到设备列表，并支持从历史页返回设备列表' },
      { type: 'improve', text: '应用更名为“卓控台”，安装包和更新包更名为 adb-workbench' },
      { type: 'fix', text: '修复部分错误' }
    ]
  },
  '3.8.7': {
    title: 'v3.8.7',
    date: '2026-07-07',
    items: [
      { type: 'improve', text: '优化投屏启动体验：音频不兼容设备会自动使用无音频模式启动' },
      { type: 'improve', text: '开始投屏按钮新增启动中状态，避免重复点击' },
      { type: 'fix', text: '修复部分错误' }
    ]
  },
  '3.8.6': {
    title: 'v3.8.6',
    date: '2026-07-06',
    items: [
      { type: 'feature', text: '新增设备解锁 Unlock：在设备列表中支持 OEM 解锁确认后执行设备解锁流程' },
      { type: 'improve', text: '优化 Unlock 解锁流程：按设备完成状态推进并自动重启' }
    ]
  },
  '3.8.5': {
    title: 'v3.8.5',
    date: '2026-07-02',
    items: [
      { type: 'improve', text: '优化自动化压测录制回放：设备画面点击、长按和刷新状态响应更及时' },
      { type: 'improve', text: '终端与 APK 管理同时打开时，会按照打开顺序排列' },
      { type: 'fix', text: '修复部分错误' }
    ]
  },
  '3.8.4': {
    title: 'v3.8.4',
    date: '2026-07-02',
    items: [
      { type: 'improve', text: '优化设备操作确认流程：Root、Remount、安装 APK 和推送文件改为直接执行' },
      { type: 'feature', text: '确认弹窗新增独立记忆：可为每个弹窗单独勾选下次不再提示，并可在偏好设置中重置' }
    ]
  },
  '3.8.3': {
    title: 'v3.8.3',
    date: '2026-07-02',
    items: [
      { type: 'feature', text: '自动化压测新增长按操作：支持控件选择器、手动坐标和脚本编排执行' },
      { type: 'improve', text: '优化录制回放：设备画面支持按住生成长按步骤' }
    ]
  },
  '3.8.2': {
    title: 'v3.8.2',
    date: '2026-07-01',
    items: [
      { type: 'feature', text: '问题排查报告新增可选 AI 总结，勾选后会在报告末尾追加分析结论' },
      { type: 'improve', text: '优化问题排查执行进度：AI 总结和巡检证据包会根据勾选状态动态显示' }
    ]
  },
  '3.8.1': {
    title: 'v3.8.1',
    date: '2026-06-29',
    items: [
      { type: 'feature', text: '终端新增 ROOT 模式开关：自动检测设备提权方式（su/adb root），命令自动以 root 身份执行' },
      { type: 'fix', text: '修复终端执行交互式命令（如 su）一直"执行中"无法中断的问题' },
      { type: 'improve', text: '优化用户体验' }
    ]
  },
  '2.0.0': {
    title: 'v2.0.0 重大更新',
    date: '2026-06-18',
    items: [
      { type: 'feature', text: 'AI 日志助手：支持自然语言智能搜索、自动诊断异常、多缓冲区日志抓取' },
      { type: 'feature', text: 'MCP 服务集成：支持 Trae / Claude / Codex 等 AI 客户端调用日志分析工具' },
      { type: 'feature', text: 'OTA 自动更新：支持差分增量更新，无需重复下载完整安装包' },
      { type: 'feature', text: '终端全屏模式：Ctrl+滚轮缩放字体，结构化输出排版' },
      { type: 'improve', text: '全新深色系配色方案（#202124），统一边框/阴影/点击反馈' },
      { type: 'improve', text: '版本号统一管理，修改 package.json 一处即可同步全局' },
      { type: 'fix', text: '修复自动诊断状态丢失、智能搜索事件污染等多个问题' }
    ]
  },
  '2.0.1': {
    title: 'v2.0.1',
    date: '2026-06-18',
    items: [
      { type: 'fix', text: '修复部分错误' }
    ]
  },
  '2.0.2': {
    title: 'v2.0.2',
    date: '2026-06-18',
    items: [
      { type: 'fix', text: '修复部分错误' }
    ]
  },
  '2.0.3': {
    title: 'v2.0.3',
    date: '2026-06-18',
    items: [
      { type: 'improve', text: '优化用户体验' }
    ]
  },
  '2.0.4': {
    title: 'v2.0.4',
    date: '2026-06-18',
    items: [
      { type: 'feature', text: '新增侧边栏快捷安装更新入口，更新下载完成后左下角提示一键安装重启' }
    ]
  },
  '2.0.5': {
    title: 'v2.0.5',
    date: '2026-06-22',
    items: [
      { type: 'fix', text: '修复部分错误' },
      { type: 'improve', text: '优化用户体验' }
    ]
  },
  '2.0.6': {
    title: 'v2.0.6',
    date: '2026-06-22',
    items: [
      { type: 'fix', text: '修复更新说明弹窗未弹出的问题' },
      { type: 'fix', text: '修复检查更新未提示"当前已是最新版本"的问题' },
      { type: 'feature', text: '开启自动更新后，检测到新版本将自动下载并在左下角显示安装入口' }
    ]
  },
  '2.0.7': {
    title: 'v2.0.7',
    date: '2026-06-22',
    items: [
      { type: 'fix', text: '修复部分错误' },
      { type: 'improve', text: '优化用户体验' }
    ]
  },
  '2.0.8': {
    title: 'v2.0.8',
    date: '2026-06-22',
    items: [
      { type: 'fix', text: '修复更新说明弹窗未弹出的问题（改用拉取模式，渲染进程主动查询）' },
      { type: 'fix', text: '修复检查更新未提示"当前已是最新版本"的问题（直接使用 checkForUpdates 返回值）' },
      { type: 'fix', text: '修复自动更新下载后左下角安装入口未显示的问题（增强下载链路日志）' },
      { type: 'improve', text: '优化版本号语义比较，避免误判' }
    ]
  },
  '2.0.9': {
    title: 'v2.0.9',
    date: '2026-06-22',
    items: [
      { type: 'fix', text: '修复更新说明弹窗未弹出的问题（弹窗原在设置页条件块内，现移至组件顶层）' },
      { type: 'fix', text: '修复检查更新误显示"发现新版本"的问题（事件回调中加入版本号校验，防止事件覆盖）' },
      { type: 'fix', text: '修复自动下载链路状态同步问题，增强下载失败错误处理' }
    ]
  },
  '2.0.10': {
    title: 'v2.0.10',
    date: '2026-06-22',
    items: [
      { type: 'fix', text: '修复更新说明弹窗未弹出的问题（main 进程先设置标志再创建窗口，并增加 localStorage fallback）' },
      { type: 'fix', text: '修复检查更新后无提示的问题（检查状态由 IPC 返回值直接管理，避免事件覆盖）' },
      { type: 'fix', text: '修复自动检查更新完成后不显示"当前已是最新版本"的问题' }
    ]
  },
  '2.0.11': {
    title: 'v2.0.11',
    date: '2026-06-22',
    items: [
      { type: 'fix', text: '修复部分错误' },
      { type: 'improve', text: '优化用户体验' }
    ]
  },
  '2.0.12': {
    title: 'v2.0.12',
    date: '2026-06-22',
    items: [
      { type: 'fix', text: '修复部分错误' },
      { type: 'improve', text: '优化用户体验' }
    ]
  },
  '2.0.13': {
    title: 'v2.0.13',
    date: '2026-06-22',
    items: [
      { type: 'fix', text: '修复部分错误' },
      { type: 'improve', text: '优化用户体验' }
    ]
  },
  '2.1.0': {
    title: 'v2.1.0 架构升级',
    date: '2026-06-22',
    items: [
      { type: 'improve', text: '架构重构：后端 main.cjs 按领域拆分为 14 个独立模块，前端 App.jsx 拆分为 data/hooks/components，大幅提升可维护性' },
      { type: 'improve', text: '代码解耦：主题配置、更新日志、设备管理、ADB 操作、APK 管理、终端逻辑分离为独立模块' }
    ]
  },
  '3.0.0': {
    title: 'v3.0.0 会员体系',
    date: '2026-06-22',
    items: [
      { type: 'feature', text: '新增会员中心：基础版 / 会员版双档位，Ed25519 离线签名激活码激活' },
      { type: 'feature', text: '机器码绑定激活（CPU+主板+磁盘+MachineGuid 四源融合），防伪造防分享' },
      { type: 'feature', text: '基础版限额：设备列表最多 1 台、连接历史最多 5 条、仅保留自动诊断' },
      { type: 'feature', text: '会员版解锁：不限设备/历史、AI 分析、自然语言搜索、MCP 服务' },
      { type: 'improve', text: '多点 fail-closed 校验，永不信任单独布尔标志，提升防破解强度' }
    ]
  },
  '3.0.1': {
    title: 'v3.0.1',
    date: '2026-06-22',
    items: [
      { type: 'fix', text: '修复已激活会员仍显示"完成支付后解锁机器码"的问题' },
      { type: 'improve', text: '会员状态异步加载时自动同步机器码解锁状态' }
    ]
  },
  '3.0.2': {
    title: 'v3.0.2',
    date: '2026-06-22',
    items: [
      { type: 'improve', text: '优化应用性能' },
      { type: 'fix', text: '修复部分错误' }
    ]
  },
  '3.0.3': {
    title: 'v3.0.3',
    date: '2026-06-22',
    items: [
      { type: 'fix', text: '修复会员中心首次打开闪现基础版的问题（增加 loading 骨架屏）' },
      { type: 'fix', text: '修复 OTA 更新安装时提示"应用未关闭"的问题（退出时清理 MCP 服务和子窗口）' },
      { type: 'improve', text: '机器码采集优化：4 个 PowerShell 合并为 1 个进程，启动耗时从 12 秒降至 4 秒' },
      { type: 'improve', text: '设备列表和连接历史在会员状态加载期间不应用限制，避免闪现锁定' }
    ]
  },
  '3.0.4': {
    title: 'v3.0.4',
    date: '2026-06-22',
    items: [
      { type: 'fix', text: '修复会员中心一直显示"正在加载会员信息"无法进入的问题' }
    ]
  },
  '3.0.5': {
    title: 'v3.0.5',
    date: '2026-06-22',
    items: [
      { type: 'fix', text: '修复终端执行含管道符的 adb shell 命令时报错乱码的问题（如 dumpsys window | grep）' }
    ]
  },
  '3.1.0': {
    title: 'v3.1.0',
    date: '2026-06-23',
    items: [
      { type: 'feature', text: '新增设备巡检：支持巡检报告与证据包导出' },
      { type: 'feature', text: '新增巡检保存路径设置，可自定义报告和证据包导出目录' },
      { type: 'improve', text: '优化设备巡检会员状态加载体验' },
      { type: 'fix', text: '修复部分错误' }
    ]
  },
  // v3.5.0 发版更新说明：仅保留用户可感知变化和泛化修复措辞。
  '3.5.0': {
    title: 'v3.5.0',
    date: '2026-06-23',
    items: [
      { type: 'feature', text: '新增 App 包管理增强：支持应用检索、详情查看和常用管理操作' },
      { type: 'feature', text: '新增日志诊断规则库：支持自动诊断规则管理、测试与重置' },
      { type: 'feature', text: '新增性能监控面板：支持设备资源采样、阈值设置与数据导出' },
      { type: 'feature', text: '新增激活码管理增强：支持激活记录、备注和复制历史' },
      { type: 'improve', text: '优化用户体验' },
      { type: 'fix', text: '修复部分错误' }
    ]
  },
  // v3.5.1 发版更新说明：同步会员中心功能对比并保留泛化优化措辞。
  '3.5.1': {
    title: 'v3.5.1',
    date: '2026-06-23',
    items: [
      { type: 'improve', text: '优化会员中心功能对比展示' },
      { type: 'improve', text: '优化应用性能' },
      { type: 'improve', text: '优化用户体验' },
      { type: 'fix', text: '修复部分错误' }
    ]
  },
  // v3.5.2 发版更新说明：同步性能监控体验优化，保留泛化措辞。
  '3.5.2': {
    title: 'v3.5.2',
    date: '2026-06-24',
    items: [
      { type: 'improve', text: '优化性能监控体验' },
      { type: 'improve', text: '优化应用性能' },
      { type: 'fix', text: '修复部分错误' }
    ]
  },
  // v3.5.3 发版更新说明：APK 管理修复按规范使用泛化措辞。
  '3.5.3': {
    title: 'v3.5.3',
    date: '2026-06-24',
    items: [
      { type: 'fix', text: '修复部分错误' }
    ]
  },
  '3.8.0': {
    title: 'v3.8.0',
    date: '2026-06-27',
    items: [
      { type: 'feature', text: '新增问题排查：支持按场景采集诊断证据并搜索选择目标包名' },
      { type: 'feature', text: '新增环境自检弹窗：集中检查 ADB、scrcpy 和设备授权状态' },
      { type: 'feature', text: '新增产物中心：集中查看问题排查、任务和分析产物' },
      { type: 'improve', text: '优化偏好设置：支持自定义全局命令按键' },
      { type: 'improve', text: '优化用户体验' },
      { type: 'fix', text: '修复部分错误' }
    ]
  },
  '3.7.1': {
    title: 'v3.7.1',
    date: '2026-06-25',
    items: [
      { type: 'feature', text: '新增任务中心普通模式：支持场景模板、录制流程和简化运行设置' },
      { type: 'improve', text: '优化任务中心步骤展示，使用自然语言摘要降低脚本编排门槛' },
      { type: 'improve', text: '优化用户体验' },
      { type: 'fix', text: '修复部分错误' }
    ]
  },
  '3.7.0': {
    title: 'v3.7.0',
    date: '2026-06-25',
    items: [
      { type: 'feature', text: '新增自动化压测：支持录制回放、截图比对和外部脚本步骤' },
      { type: 'improve', text: '优化自动化压测：增强控件选择器、坐标回放和曲线滑动支持' },
      { type: 'improve', text: '优化用户体验' },
      { type: 'fix', text: '修复部分错误' }
    ]
  },
  '3.6.2': {
    title: 'v3.6.2',
    date: '2026-06-24',
    items: [
      { type: 'feature', text: '新增任务中心保存路径设置，支持自定义任务产物目录' },
      { type: 'improve', text: '优化任务中心运行历史展示和目录打开体验' },
      { type: 'improve', text: '优化用户体验' },
      { type: 'fix', text: '修复部分错误' }
    ]
  },
  '3.6.1': {
    title: 'v3.6.1',
    date: '2026-06-24',
    items: [
      { type: 'improve', text: '优化应用更新稳定性' },
      { type: 'fix', text: '修复部分错误' }
    ]
  },
  '3.6.0': {
    title: 'v3.6.0',
    date: '2026-06-24',
    items: [
      { type: 'feature', text: '新增任务中心：支持复现步骤编排与后台执行进度展示' },
      { type: 'feature', text: '新增设备巡检和性能报告 AI 分析，可按需勾选生成' },
      { type: 'feature', text: '新增巡检报告和性能报告保存路径设置与打开入口' },
      { type: 'feature', text: '新增 MCP 服务工具：支持应用包查询、性能采样和设备巡检' },
      { type: 'improve', text: '优化性能监控体验' },
      { type: 'improve', text: '优化应用性能' },
      { type: 'improve', text: '优化用户体验' },
      { type: 'fix', text: '修复部分错误' }
    ]
  }
};

function getChangelog(version) {
  return CHANGELOGS[version] || null;
}

// 语义化版本比较：v1 > v2 返回 1，v1 < v2 返回 -1，相等返回 0
function compareVersions(v1, v2) {
  const parts1 = String(v1 || '').split('.').map(n => parseInt(n, 10) || 0);
  const parts2 = String(v2 || '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const a = parts1[i] || 0;
    const b = parts2[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

export { CHANGELOGS, getChangelog, compareVersions };
