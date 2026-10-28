import { tr } from '../shared/i18n.js';
// 版本更新说明（changelog）- 每次发版时在这里添加对应版本的更新内容
// 格式：{ title, date, items: [{ type: 'feature'|'fix'|'improve', text }] }
// type 对应不同颜色标签：feature(绿色新增) fix(红色修复) improve(蓝色优化)
const CHANGELOGS = {
  '4.7.10': {
    title: 'v4.7.10',
    date: '2026-10-28',
    items: [
      { type: 'feature', get text() { return tr('设备卡片新增设备日志快捷入口'); } },
      { type: 'improve', get text() { return tr('精简常用工具，移除固定音量按钮，音量操作可通过自定义快捷操作配置'); } },
      { type: 'fix', get text() { return tr('修复部分错误'); } },
      { type: 'improve', get text() { return tr('优化用户体验'); } },
    ],
  },
  '4.7.9': {
    title: 'v4.7.9',
    date: '2026-10-28',
    items: [
      { type: 'feature', get text() { return tr('新增复现采证会话，统一保存录屏、日志、性能及选定终端证据'); } },
      { type: 'feature', get text() { return tr('支持在日志、终端、错误和运行结果旁直接准备 AI 分析'); } },
      { type: 'feature', get text() { return tr('新增应用专项排障与本地已验证案例库'); } },
      { type: 'feature', get text() { return tr('AI 测试可引用已选控件，支持失败设备安全复跑与结果回流'); } },
      { type: 'improve', get text() { return tr('统一内置 AI 发送预览、脱敏、取消及用量提示'); } },
      { type: 'improve', get text() { return tr('质量验证草稿按设备保留，后台活动集中查看'); } },
      { type: 'fix', get text() { return tr('修复部分错误'); } },
      { type: 'improve', get text() { return tr('优化应用性能'); } },
    ],
  },
  '4.7.8': {
    title: 'v4.7.8',
    date: '2026-10-26',
    items: [
      { type: 'feature', get text() { return tr('新增与安装器一致的自定义卸载界面，支持五种语言'); } },
      { type: 'feature', get text() { return tr('AI 工作区支持证据筛选、分析历史与报告导出'); } },
      { type: 'feature', get text() { return tr('支持连续追问、基于分析结论生成回归测试任务'); } },
      { type: 'feature', get text() { return tr('新增日志行级引用与修复前后对比分析'); } },
      { type: 'improve', get text() { return tr('近期设备日志采集提升至 2,000 行，完善证据容量提示'); } },
      { type: 'fix', get text() { return tr('修复部分错误'); } },
      { type: 'improve', get text() { return tr('优化用户体验'); } },
    ],
  },
  '4.7.7': {
    title: 'v4.7.7',
    date: '2026-10-26',
    items: [
      { type: 'improve', get text() { return tr('设备日志支持保留 50,000 条，串口记录与终端回滚支持 10,000 条/行'); } },
      { type: 'fix', get text() { return tr('修复部分错误'); } },
      { type: 'improve', get text() { return tr('优化应用性能'); } },
      { type: 'improve', get text() { return tr('优化用户体验'); } },
    ],
  },
  '4.7.6': {
    title: 'v4.7.6',
    date: '2026-10-26',
    items: [
      { type: 'fix', get text() { return tr('修复部分错误'); } },
      { type: 'improve', get text() { return tr('优化用户体验'); } },
    ],
  },
  '4.7.5': {
    title: 'v4.7.5',
    date: '2026-10-26',
    items: [
      { type: 'improve', get text() { return tr('全新黑底翠绿 V 品牌图标，统一应用与安装器视觉'); } },
      { type: 'feature', get text() { return tr('新增紧凑黑色安装界面，支持行星环绕动画与自定义安装路径'); } },
      { type: 'feature', get text() { return tr('安装器支持五种语言，首次默认英语；所选语言自动应用于首次启动'); } },
      { type: 'improve', get text() { return tr('AI 工具管理新增配置范围说明：仅用于外部 AI 工具，不影响应用内置 AI'); } },
      { type: 'fix', get text() { return tr('修复部分错误'); } },
      { type: 'improve', get text() { return tr('优化用户体验'); } },
    ],
  },
  '4.7.4': {
    title: 'v4.7.4',
    date: '2026-10-26',
    items: [
      { type: 'feature', get text() { return tr('新增 AI 排障助手：根据问题推荐只读检查，预览证据后生成分析结论'); } },
      { type: 'feature', get text() { return tr('新增 AI 多源联合分析：关联设备日志、串口和 SSH 终端证据'); } },
      { type: 'feature', get text() { return tr('新增 AI 生成测试任务：将测试目标生成可审阅步骤，保存到任务中心后执行'); } },
      { type: 'improve', get text() { return tr('新增 AI 功能沿用内置 AI 和会员权益，支持脱敏预览、独立取消与五种语言'); } },
      { type: 'fix', get text() { return tr('修复部分错误'); } },
      { type: 'improve', get text() { return tr('优化用户体验'); } },
    ],
  },
  '4.7.3': {
    title: 'v4.7.3',
    date: '2026-10-24',
    items: [
      { type: 'feature', get text() { return tr('新增繁体中文、日语和韩语，支持五种界面语言'); } },
      { type: 'feature', get text() { return tr('首次安装可选择应用语言，更新说明随所选语言显示'); } },
      { type: 'improve', get text() { return tr('应用品牌名称随界面语言显示，优化多语言启动与窗口体验'); } },
      { type: 'improve', get text() { return tr('优化用户体验'); } },
    ],
  },
  '4.7.2': {
    title: 'v4.7.2',
    date: '2026-10-24',
    items: [
      { type: 'feature', get text() { return tr('自动更新支持启动后每两小时定时检查新版本'); } },
      { type: 'feature', get text() { return tr("新增简体中文与 English 语言切换，支持保存选择并同步应用窗口"); } },
      { type: 'improve', get text() { return tr("优化多语言界面与提示信息的展示体验"); } },
      { type: 'improve', get text() { return tr("优化用户体验"); } }
    ]
  },
  '4.7.1': {
    title: 'v4.7.1',
    date: '2026-10-23',
    items: [
      { type: 'feature', get text() { return tr("新增问题反馈：首次通过浏览器授权 GitHub 后，可在软件内预览并提交问题到项目 Issues"); } },
      { type: 'feature', get text() { return tr("问题反馈自动整理电脑、系统和软件环境信息，可按需取消附带"); } },
      { type: 'feature', get text() { return tr("支持勾选后自动附带最近的卓控台诊断日志，无需手动寻找文件，提交前可预览公开内容"); } },
      { type: 'feature', get text() { return tr("侧边栏新增问题反馈快捷入口，无需切换页面即可反馈"); } },
      { type: 'improve', get text() { return tr("顶部菜单默认收起，按 Alt 可唤出，原有快捷键保持可用"); } },
      { type: 'improve', get text() { return tr("设备断开后自动清空当前设备；有其他在线设备时自动切换，保留连接历史"); } },
      { type: 'improve', get text() { return tr("粒子启动期间提前准备主界面，动画结束后渐入工作区"); } },
      { type: 'improve', get text() { return tr("优化用户体验"); } },
      { type: 'fix', get text() { return tr("修复部分错误"); } }
    ]
  },
  '4.7.0': {
    title: 'v4.7.0',
    date: '2026-10-23',
    items: [
      { type: 'feature', get text() { return tr("新增全屏透明粒子启动动画，标识化为粒子聚合成主界面轮廓，播放约 4.4 秒后进入工作区"); } },
      { type: 'feature', get text() { return tr("偏好设置新增减少动态效果、启动动画和开机自启开关，支持保存个人选择"); } },
      { type: 'improve', get text() { return tr("串口终端样式在重启后保留，数据迁移包含终端样式及动效偏好"); } },
      { type: 'improve', get text() { return tr("优化应用性能"); } },
      { type: 'fix', get text() { return tr("修复部分错误"); } }
    ]
  },
  '4.6.5': {
    title: 'v4.6.5',
    date: '2026-10-23',
    items: [
      { type: 'improve', get text() { return tr("当前设备断开时自动选用在线设备并刷新，返回窗口即时更新；进行中的操作仍绑定原设备"); } },
      { type: 'improve', get text() { return tr("统一新增确认弹窗的明暗主题和操作样式，连接测试保留短暂结果提示，不再常驻显示结果详情"); } },
      { type: 'feature', get text() { return tr("新增 AI 工具管理，沿用软件现有会员机制，支持供应商配置、模型列表和服务商额度查询"); } },
      { type: 'feature', get text() { return tr("支持多种 AI 工具配置应用，以及 MCP、Skills 和提示词管理，修改前可预览并保留恢复备份"); } },
      { type: 'feature', get text() { return tr("新增 AI 会话查看、本机用量统计、项目入口和 CLI 启动预览"); } },
      { type: 'feature', get text() { return tr("新增本地路由，支持同协议供应商、流式转发和可选故障切换"); } },
      { type: 'feature', get text() { return tr("偏好设置支持统一密码加密迁移，包含 AI 供应商及密钥、MCP、提示词、Skills、项目、路由和可选会话归档，兼容旧版备份"); } },
      { type: 'improve', get text() { return tr("侧边栏偏好设置移至会员中心下方"); } },
      { type: 'improve', get text() { return tr("优化应用性能"); } },
      { type: 'improve', get text() { return tr("优化用户体验"); } },
      { type: 'fix', get text() { return tr("修复部分错误"); } }
    ]
  },
  '4.6.1': {
    title: 'v4.6.1',
    date: '2026-10-22',
    items: [
      { type: 'feature', get text() { return tr("SSH 传输完成后可打开所在目录：下载打开本地文件夹，上传定位对应主机的远端目录"); } },
      { type: 'feature', get text() { return tr("SSH 传输队列支持单条清除和一键清除已结束记录，仅移除记录，不删除文件、不影响正在传输的任务"); } },
      { type: 'improve', get text() { return tr("优化用户体验"); } }
    ]
  },
  '4.6.0': {
    title: 'v4.6.0',
    date: '2026-10-22',
    items: [
      { type: 'feature', get text() { return tr("新增 SSH 工作区，支持保存连接、密码或私钥登录、多主机连接及每台主机多个独立终端"); } },
      { type: 'feature', get text() { return tr("远端文件树、文件编辑器与终端同屏显示，支持分区调整和经典深色主题"); } },
      { type: 'feature', get text() { return tr("支持 SFTP 文件和文件夹上传下载、拖拽上传、进度查看、取消和重试"); } },
      { type: 'feature', get text() { return tr("支持远端文件查看、编辑保存及冲突保护，文件区新增常用右键操作"); } },
      { type: 'feature', get text() { return tr("SSH 命令记忆默认开启，支持按主机关闭记忆、本机加密保存、搜索、删除和清空历史"); } },
      { type: 'feature', get text() { return tr("支持终端选区复制、快捷键粘贴和右键操作，多行粘贴前可预览确认"); } },
      { type: 'improve', get text() { return tr("新建 Bash 4.4+ 终端自动准备命令识别与历史候选；Tab 仅补入，Enter 执行"); } },
      { type: 'improve', get text() { return tr("主动断开 SSH 后退出当前会话，保留未保存内容提示；切换页面不影响其他连接"); } },
      { type: 'fix', get text() { return tr("修复部分错误"); } },
      { type: 'improve', get text() { return tr("优化用户体验"); } }
    ]
  },
  '4.5.2': {
    title: 'v4.5.2',
    date: '2026-10-22',
    items: [
      { type: 'feature', get text() { return tr("串口终端与 RS232 调试使用独立连接和参数，可同时连接不同 COM，切换界面不影响后台接收"); } },
      { type: 'feature', get text() { return tr("串口终端支持逐键输入、Tab、方向键、Ctrl+C 等控制键，以及终端回显、复制粘贴和清屏"); } },
      { type: 'feature', get text() { return tr("终端支持当前主题与经典黑底样式切换，默认保持当前样式"); } },
      { type: 'improve', get text() { return tr("串口 AB 与 FE / XBHCMD 报文按完整内容分行，支持连续多包分别显示与分段接收补齐"); } },
      { type: 'improve', get text() { return tr("发送数据区域新增清空输入按钮，不影响收发记录、常用命令及发送历史"); } },
      { type: 'improve', get text() { return tr("两侧收发记录、统计和保存互相独立，终端按键不再出现在 RS232 记录中"); } }
    ]
  },
  '4.5.1': {
    title: 'v4.5.1',
    date: '2026-10-22',
    items: [
      { type: 'improve', get text() { return tr("串口 HEX 收发记录统一为大写、字节间空格，列表、详情、复制及导出显示一致"); } },
      { type: 'improve', get text() { return tr("串口连续接收片段每行最多合并两段，后续片段另起一行，保留毫秒时间和中文收发标识"); } },
      { type: 'feature', get text() { return tr("新增独立 ASCII 收发模式，支持不可见字节显示及非 ASCII 输入校验"); } },
      { type: 'improve', get text() { return tr("新增 HEX 整理、发送字节预览与连接步骤提示，优化串口上手体验"); } },
      { type: 'improve', get text() { return tr("点击常用命令或发送历史后高亮提示并定位发送框，明确显示已填入但尚未发送"); } }
    ]
  },
  '4.5.0': {
    title: 'v4.5.0',
    date: '2026-10-21',
    items: [
      { type: 'feature', get text() { return tr("侧边栏新增独立的串口 / RS232 页面，动态发现电脑串口，支持含 921600 在内的常用波特率与热插拔提示"); } },
      { type: 'feature', get text() { return tr("支持文本和 HEX 数据收发、时间戳与字节统计，以及收发记录保存"); } },
      { type: 'feature', get text() { return tr("新增串口常用命令与发送历史，连接参数和常用命令可随数据迁移保存"); } },
      { type: 'improve', get text() { return tr("串口切换页面不断连，断线保留当前记录，退出前提示保存未保存的数据"); } }
    ]
  },
  '4.3.6': {
    title: 'v4.3.6',
    date: '2026-10-21',
    items: [
      { type: 'improve', get text() { return tr("录屏日志选项更名为“录屏同时抓取日志”"); } },
      { type: 'improve', get text() { return tr("最近文件自动移除已删除的截图和录屏，关联日志删除后不再显示无效入口"); } },
      { type: 'feature', get text() { return tr("设备快捷操作提前检查支持情况，不可用时说明原因并支持编辑替换"); } },
      { type: 'feature', get text() { return tr("设备列表支持按名称、型号、序列号或 IP 搜索，常用设备可置顶并保存"); } }
    ]
  },
  '4.3.5': {
    title: 'v4.3.5',
    date: '2026-10-21',
    items: [
      { type: 'improve', get text() { return tr("设备录屏支持计时、跨页面状态同步、自动结束保存及失败后重新保存"); } },
      { type: 'feature', get text() { return tr("设备第一排四个快捷按钮支持替换、排序和改名，可选择系统操作、应用及需确认的 ADB 命令"); } },
      { type: 'feature', get text() { return tr("设备卡片新增最近截图和录屏，可快速打开文件、目录或复制截图"); } },
      { type: 'feature', get text() { return tr("录屏可选择同时抓取日志，视频与日志关联保存，不自动调用 AI"); } },
      { type: 'improve', get text() { return tr("统一剩余下拉菜单样式，支持键盘操作和深色主题"); } },
      { type: 'improve', get text() { return tr("退出前提示保存录屏，快捷按钮配置支持本地保存和数据迁移"); } }
    ]
  },
  '4.3.2': {
    title: 'v4.3.2',
    date: '2026-10-21',
    items: [
      { type: 'feature', get text() { return tr("偏好设置新增数据导出与导入，方便在不同电脑间迁移使用数据"); } },
      { type: 'feature', get text() { return tr("导入前可预览备份内容，确认后保留恢复备份并重启生效"); } },
      { type: 'improve', get text() { return tr("设备别名、当前主题和投屏偏好支持本地保存与迁移"); } }
    ]
  },
  '4.3.1': {
    title: 'v4.3.1',
    date: '2026-10-21',
    items: [
      { type: 'fix', get text() { return tr("修复 AI 日志助手开始抓取和长时间抓取时卡顿、无响应的问题"); } },
      { type: 'improve', get text() { return tr("合并高频日志刷新，优化日志缓存、过滤和自动诊断，保持停止抓取等操作及时响应"); } },
      { type: 'improve', get text() { return tr("历史 Wi-Fi 连接成功后自动进入设备页面并选中该设备，连接失败时保留错误提示"); } }
    ]
  },
  '4.3.0': {
    title: 'v4.3.0',
    date: '2026-10-21',
    items: [
      { type: 'improve', get text() { return tr("截图后可直接预览、复制图片和打开保存位置，预览 10 秒后自动关闭"); } },
      { type: 'improve', get text() { return tr("精简已连接状态下的首页布局，历史设备支持直接重连并显示连接结果"); } },
      { type: 'feature', get text() { return tr("新增最近使用的 APK 和常用应用收藏，方便重复安装和日常调试"); } },
      { type: 'improve', get text() { return tr("日志历史会话支持搜索、日期筛选、重命名和回收站删除，提升历史记录加载效率"); } },
      { type: 'feature', get text() { return tr("日志新增问题标记，可添加备注、查看当时上下文并随会话保存"); } },
      { type: 'feature', get text() { return tr("任务中心新增两次回放对比，核对脚本和设备后查看失败变化、耗时和证据"); } },
      { type: 'improve', get text() { return tr("产物中心支持查询更早记录、按日期或容量排序、查看所选容量及直接预览报告、数据和图片"); } },
      { type: 'fix', get text() { return tr("修复弹窗内自定义下拉菜单的显示和点击问题"); } }
    ]
  },
  '4.2.5': {
    title: 'v4.2.5',
    date: '2026-10-20',
    items: [
      { type: 'improve', get text() { return tr("日志过滤预设与设备选择统一为自定义下拉菜单"); } },
      { type: 'feature', get text() { return tr("新增日志过滤预设与分析会话保存、恢复，方便继续排查同一问题"); } },
      { type: 'feature', get text() { return tr("产物中心新增证据包导出，集中打包报告、日志和截图"); } },
      { type: 'improve', get text() { return tr("任务中心支持恢复未保存草稿、查看运行详情和定位失败步骤"); } },
      { type: 'improve', get text() { return tr("优化设备连接状态更新与跨页面操作，应用可直接进入日志和问题排查"); } },
      { type: 'improve', get text() { return tr("AI 分析支持查看关联日志依据，批量应用操作保留失败明细"); } },
      { type: 'improve', get text() { return tr("优化界面布局、深色主题、回归验收流程和性能图表"); } }
    ]
  },
  '4.2.1': {
    title: 'v4.2.1',
    date: '2026-09-12',
    items: [
      { type: 'improve', get text() { return tr("优化 AI 部分"); } }
    ]
  },
  '4.2.0': {
    title: 'v4.2.0',
    date: '2026-09-11',
    items: [
      { type: 'feature', get text() { return tr("设备卡片新增回到桌面、打开侧边栏、打开系统设置、打开白板四个快捷按钮"); } },
      { type: 'improve', get text() { return tr("设备操作按导航、常用工具和设备维护分组，统一按钮布局并适配不同卡片宽度"); } }
    ]
  },
  '4.1.9': {
    title: 'v4.1.9',
    date: '2026-08-03',
    items: [
      { type: 'feature', get text() { return tr("任务中心新增点击式新手教程，引导选择设备、读取真实界面、录制点击并完成一次回放"); } },
      { type: 'improve', get text() { return tr("任务中心首页简化为“录制操作”和“导入脚本”两个主要入口"); } },
      { type: 'improve', get text() { return tr("录制操作新增简化页面，复杂设置收纳到更多录制方式和高级编排"); } }
    ]
  },
  '4.1.8': {
    title: 'v4.1.8',
    date: '2026-07-23',
    items: [
      { type: 'feature', get text() { return tr("任务中心支持直接导入 Python 和 Shell 外部脚本，并可按脚本要求填写执行参数"); } },
      { type: 'improve', get text() { return tr("Python 和 Shell 外部脚本执行不受任务超时限制，可随时手动取消"); } }
    ]
  },
  '4.1.7': {
    title: 'v4.1.7',
    date: '2026-07-21',
    items: [
      { type: 'improve', get text() { return tr("APK 安装和文件推送完成后，在各自操作区域下方持续显示成功或失败结果"); } }
    ]
  },
  '4.1.6': {
    title: 'v4.1.6',
    date: '2026-07-20',
    items: [
      { type: 'feature', get text() { return tr("设备 Unlock 解锁新增 RK/MTK 芯片平台兼容，适配 RK 双重启流程"); } }
    ]
  },
  '4.1.5': {
    title: 'v4.1.5',
    date: '2026-07-13',
    items: [
      { type: 'improve', get text() { return tr("优化自动化压测：设备重启后自动识别新的设备 ID"); } },
      { type: 'fix', get text() { return tr("修复部分错误"); } }
    ]
  },
  '4.1.4': {
    title: 'v4.1.4',
    date: '2026-07-11',
    items: [
      { type: 'fix', get text() { return tr("修复设备重启、进入 Loader 模式或 Unlock 解锁后设备列表未自动刷新的问题"); } },
      { type: 'improve', get text() { return tr("优化 OTA 更新检测，修复部分设备无法获取更新信息的问题"); } }
    ]
  },
  '4.1.3': {
    title: 'v4.1.3',
    date: '2026-07-10',
    items: [
      { type: 'feature', get text() { return tr("AI 日志助手新增思考模式：支持查看 AI 推理过程，每轮对话独立展示思考面板"); } },
      { type: 'feature', get text() { return tr("新增快速/思考模式切换，快速模式响应更快，思考模式分析更深入"); } },
      { type: 'improve', get text() { return tr("优化流式输出体验：渲染更流畅，文字逐字平滑显示"); } },
      { type: 'improve', get text() { return tr("优化上下文管理：追问时日志未变化不再重复发送，减少 token 消耗"); } },
      { type: 'improve', get text() { return tr("上下文使用量实时显示，自动压缩历史对话防止超限"); } },
      { type: 'fix', get text() { return tr("修复上下文超限时报错的问题，现在会自动截断并重试"); } }
    ]
  },
  '4.1.2': {
    title: 'v4.1.2',
    date: '2026-07-10',
    items: [
      { type: 'improve', get text() { return tr("优化应用性能"); } },
      { type: 'fix', get text() { return tr("修复部分错误"); } }
    ]
  },
  '4.1.1': {
    title: 'v4.1.1',
    date: '2026-07-09',
    items: [
      { type: 'feature', get text() { return tr("产物中心新增单个删除、多选删除和一键清理"); } },
      { type: 'improve', get text() { return tr("产物删除改为移入系统回收站"); } },
      { type: 'improve', get text() { return tr("优化产物列表删除按钮布局"); } }
    ]
  },
  '4.1.0': {
    title: 'v4.1.0',
    date: '2026-07-09',
    items: [
      { type: 'feature', get text() { return tr("APK 管理新增应用列表隐藏开关"); } },
      { type: 'improve', get text() { return tr("优化偏好设置分组导航与固定导航展示"); } },
      { type: 'improve', get text() { return tr("优化会员中心页面布局与权益对比展示"); } },
      { type: 'improve', get text() { return tr("优化性能监控顶部工具栏布局"); } },
      { type: 'improve', get text() { return tr("优化应用性能"); } },
      { type: 'fix', get text() { return tr("修复部分错误"); } }
    ]
  },
  '4.0.1': {
    title: 'v4.0.1',
    date: '2026-07-08',
    items: [
      { type: 'feature', get text() { return tr("新增质量中心保存路径设置"); } },
      { type: 'improve', get text() { return tr("优化会员中心功能对比展示"); } },
      { type: 'improve', get text() { return tr("优化质量中心刷新体验"); } },
      { type: 'fix', get text() { return tr("修复部分错误"); } }
    ]
  },
  '4.0.0': {
    title: 'v4.0.0',
    date: '2026-07-08',
    items: [
      { type: 'feature', get text() { return tr("新增质量中心：支持回归差异报告、一键验收套餐和设备守护"); } },
      { type: 'improve', get text() { return tr("连接历史入口调整到设备列表，并支持从历史页返回设备列表"); } },
      { type: 'improve', get text() { return tr("应用更名为“卓控台”，安装包和更新包更名为 adb-workbench"); } },
      { type: 'fix', get text() { return tr("修复部分错误"); } }
    ]
  },
  '3.8.7': {
    title: 'v3.8.7',
    date: '2026-07-07',
    items: [
      { type: 'improve', get text() { return tr("优化投屏启动体验：音频不兼容设备会自动使用无音频模式启动"); } },
      { type: 'improve', get text() { return tr("开始投屏按钮新增启动中状态，避免重复点击"); } },
      { type: 'fix', get text() { return tr("修复部分错误"); } }
    ]
  },
  '3.8.6': {
    title: 'v3.8.6',
    date: '2026-07-06',
    items: [
      { type: 'feature', get text() { return tr("新增设备解锁 Unlock：在设备列表中支持 OEM 解锁确认后执行设备解锁流程"); } },
      { type: 'improve', get text() { return tr("优化 Unlock 解锁流程：按设备完成状态推进并自动重启"); } }
    ]
  },
  '3.8.5': {
    title: 'v3.8.5',
    date: '2026-07-02',
    items: [
      { type: 'improve', get text() { return tr("优化自动化压测录制回放：设备画面点击、长按和刷新状态响应更及时"); } },
      { type: 'improve', get text() { return tr("终端与 APK 管理同时打开时，会按照打开顺序排列"); } },
      { type: 'fix', get text() { return tr("修复部分错误"); } }
    ]
  },
  '3.8.4': {
    title: 'v3.8.4',
    date: '2026-07-02',
    items: [
      { type: 'improve', get text() { return tr("优化设备操作确认流程：Root、Remount、安装 APK 和推送文件改为直接执行"); } },
      { type: 'feature', get text() { return tr("确认弹窗新增独立记忆：可为每个弹窗单独勾选下次不再提示，并可在偏好设置中重置"); } }
    ]
  },
  '3.8.3': {
    title: 'v3.8.3',
    date: '2026-07-02',
    items: [
      { type: 'feature', get text() { return tr("自动化压测新增长按操作：支持控件选择器、手动坐标和脚本编排执行"); } },
      { type: 'improve', get text() { return tr("优化录制回放：设备画面支持按住生成长按步骤"); } }
    ]
  },
  '3.8.2': {
    title: 'v3.8.2',
    date: '2026-07-01',
    items: [
      { type: 'feature', get text() { return tr("问题排查报告新增可选 AI 总结，勾选后会在报告末尾追加分析结论"); } },
      { type: 'improve', get text() { return tr("优化问题排查执行进度：AI 总结和巡检证据包会根据勾选状态动态显示"); } }
    ]
  },
  '3.8.1': {
    title: 'v3.8.1',
    date: '2026-06-29',
    items: [
      { type: 'feature', get text() { return tr("终端新增 ROOT 模式开关：自动检测设备提权方式（su/adb root），命令自动以 root 身份执行"); } },
      { type: 'fix', get text() { return tr("修复终端执行交互式命令（如 su）一直\"执行中\"无法中断的问题"); } },
      { type: 'improve', get text() { return tr("优化用户体验"); } }
    ]
  },
  '2.0.0': {
    get title() { return tr("v2.0.0 重大更新"); },
    date: '2026-06-18',
    items: [
      { type: 'feature', get text() { return tr("AI 日志助手：支持自然语言智能搜索、自动诊断异常、多缓冲区日志抓取"); } },
      { type: 'feature', get text() { return tr("MCP 服务集成：支持 Trae / Claude / Codex 等 AI 客户端调用日志分析工具"); } },
      { type: 'feature', get text() { return tr("OTA 自动更新：支持差分增量更新，无需重复下载完整安装包"); } },
      { type: 'feature', get text() { return tr("终端全屏模式：Ctrl+滚轮缩放字体，结构化输出排版"); } },
      { type: 'improve', get text() { return tr("全新深色系配色方案（#202124），统一边框/阴影/点击反馈"); } },
      { type: 'improve', get text() { return tr("版本号统一管理，修改 package.json 一处即可同步全局"); } },
      { type: 'fix', get text() { return tr("修复自动诊断状态丢失、智能搜索事件污染等多个问题"); } }
    ]
  },
  '2.0.1': {
    title: 'v2.0.1',
    date: '2026-06-18',
    items: [
      { type: 'fix', get text() { return tr("修复部分错误"); } }
    ]
  },
  '2.0.2': {
    title: 'v2.0.2',
    date: '2026-06-18',
    items: [
      { type: 'fix', get text() { return tr("修复部分错误"); } }
    ]
  },
  '2.0.3': {
    title: 'v2.0.3',
    date: '2026-06-18',
    items: [
      { type: 'improve', get text() { return tr("优化用户体验"); } }
    ]
  },
  '2.0.4': {
    title: 'v2.0.4',
    date: '2026-06-18',
    items: [
      { type: 'feature', get text() { return tr("新增侧边栏快捷安装更新入口，更新下载完成后左下角提示一键安装重启"); } }
    ]
  },
  '2.0.5': {
    title: 'v2.0.5',
    date: '2026-06-22',
    items: [
      { type: 'fix', get text() { return tr("修复部分错误"); } },
      { type: 'improve', get text() { return tr("优化用户体验"); } }
    ]
  },
  '2.0.6': {
    title: 'v2.0.6',
    date: '2026-06-22',
    items: [
      { type: 'fix', get text() { return tr("修复更新说明弹窗未弹出的问题"); } },
      { type: 'fix', get text() { return tr("修复检查更新未提示\"当前已是最新版本\"的问题"); } },
      { type: 'feature', get text() { return tr("开启自动更新后，检测到新版本将自动下载并在左下角显示安装入口"); } }
    ]
  },
  '2.0.7': {
    title: 'v2.0.7',
    date: '2026-06-22',
    items: [
      { type: 'fix', get text() { return tr("修复部分错误"); } },
      { type: 'improve', get text() { return tr("优化用户体验"); } }
    ]
  },
  '2.0.8': {
    title: 'v2.0.8',
    date: '2026-06-22',
    items: [
      { type: 'fix', get text() { return tr("修复更新说明弹窗未弹出的问题（改用拉取模式，渲染进程主动查询）"); } },
      { type: 'fix', get text() { return tr("修复检查更新未提示\"当前已是最新版本\"的问题（直接使用 checkForUpdates 返回值）"); } },
      { type: 'fix', get text() { return tr("修复自动更新下载后左下角安装入口未显示的问题（增强下载链路日志）"); } },
      { type: 'improve', get text() { return tr("优化版本号语义比较，避免误判"); } }
    ]
  },
  '2.0.9': {
    title: 'v2.0.9',
    date: '2026-06-22',
    items: [
      { type: 'fix', get text() { return tr("修复更新说明弹窗未弹出的问题（弹窗原在设置页条件块内，现移至组件顶层）"); } },
      { type: 'fix', get text() { return tr("修复检查更新误显示\"发现新版本\"的问题（事件回调中加入版本号校验，防止事件覆盖）"); } },
      { type: 'fix', get text() { return tr("修复自动下载链路状态同步问题，增强下载失败错误处理"); } }
    ]
  },
  '2.0.10': {
    title: 'v2.0.10',
    date: '2026-06-22',
    items: [
      { type: 'fix', get text() { return tr("修复更新说明弹窗未弹出的问题（main 进程先设置标志再创建窗口，并增加 localStorage fallback）"); } },
      { type: 'fix', get text() { return tr("修复检查更新后无提示的问题（检查状态由 IPC 返回值直接管理，避免事件覆盖）"); } },
      { type: 'fix', get text() { return tr("修复自动检查更新完成后不显示\"当前已是最新版本\"的问题"); } }
    ]
  },
  '2.0.11': {
    title: 'v2.0.11',
    date: '2026-06-22',
    items: [
      { type: 'fix', get text() { return tr("修复部分错误"); } },
      { type: 'improve', get text() { return tr("优化用户体验"); } }
    ]
  },
  '2.0.12': {
    title: 'v2.0.12',
    date: '2026-06-22',
    items: [
      { type: 'fix', get text() { return tr("修复部分错误"); } },
      { type: 'improve', get text() { return tr("优化用户体验"); } }
    ]
  },
  '2.0.13': {
    title: 'v2.0.13',
    date: '2026-06-22',
    items: [
      { type: 'fix', get text() { return tr("修复部分错误"); } },
      { type: 'improve', get text() { return tr("优化用户体验"); } }
    ]
  },
  '2.1.0': {
    get title() { return tr("v2.1.0 架构升级"); },
    date: '2026-06-22',
    items: [
      { type: 'improve', get text() { return tr("架构重构：后端 main.cjs 按领域拆分为 14 个独立模块，前端 App.jsx 拆分为 data/hooks/components，大幅提升可维护性"); } },
      { type: 'improve', get text() { return tr("代码解耦：主题配置、更新日志、设备管理、ADB 操作、APK 管理、终端逻辑分离为独立模块"); } }
    ]
  },
  '3.0.0': {
    get title() { return tr("v3.0.0 会员体系"); },
    date: '2026-06-22',
    items: [
      { type: 'feature', get text() { return tr("新增会员中心：基础版 / 会员版双档位，Ed25519 离线签名激活码激活"); } },
      { type: 'feature', get text() { return tr("机器码绑定激活（CPU+主板+磁盘+MachineGuid 四源融合），防伪造防分享"); } },
      { type: 'feature', get text() { return tr("基础版限额：设备列表最多 1 台、连接历史最多 5 条、仅保留自动诊断"); } },
      { type: 'feature', get text() { return tr("会员版解锁：不限设备/历史、AI 分析、自然语言搜索、MCP 服务"); } },
      { type: 'improve', get text() { return tr("多点 fail-closed 校验，永不信任单独布尔标志，提升防破解强度"); } }
    ]
  },
  '3.0.1': {
    title: 'v3.0.1',
    date: '2026-06-22',
    items: [
      { type: 'fix', get text() { return tr("修复已激活会员仍显示\"完成支付后解锁机器码\"的问题"); } },
      { type: 'improve', get text() { return tr("会员状态异步加载时自动同步机器码解锁状态"); } }
    ]
  },
  '3.0.2': {
    title: 'v3.0.2',
    date: '2026-06-22',
    items: [
      { type: 'improve', get text() { return tr("优化应用性能"); } },
      { type: 'fix', get text() { return tr("修复部分错误"); } }
    ]
  },
  '3.0.3': {
    title: 'v3.0.3',
    date: '2026-06-22',
    items: [
      { type: 'fix', get text() { return tr("修复会员中心首次打开闪现基础版的问题（增加 loading 骨架屏）"); } },
      { type: 'fix', get text() { return tr("修复 OTA 更新安装时提示\"应用未关闭\"的问题（退出时清理 MCP 服务和子窗口）"); } },
      { type: 'improve', get text() { return tr("机器码采集优化：4 个 PowerShell 合并为 1 个进程，启动耗时从 12 秒降至 4 秒"); } },
      { type: 'improve', get text() { return tr("设备列表和连接历史在会员状态加载期间不应用限制，避免闪现锁定"); } }
    ]
  },
  '3.0.4': {
    title: 'v3.0.4',
    date: '2026-06-22',
    items: [
      { type: 'fix', get text() { return tr("修复会员中心一直显示\"正在加载会员信息\"无法进入的问题"); } }
    ]
  },
  '3.0.5': {
    title: 'v3.0.5',
    date: '2026-06-22',
    items: [
      { type: 'fix', get text() { return tr("修复终端执行含管道符的 adb shell 命令时报错乱码的问题（如 dumpsys window | grep）"); } }
    ]
  },
  '3.1.0': {
    title: 'v3.1.0',
    date: '2026-06-23',
    items: [
      { type: 'feature', get text() { return tr("新增设备巡检：支持巡检报告与证据包导出"); } },
      { type: 'feature', get text() { return tr("新增巡检保存路径设置，可自定义报告和证据包导出目录"); } },
      { type: 'improve', get text() { return tr("优化设备巡检会员状态加载体验"); } },
      { type: 'fix', get text() { return tr("修复部分错误"); } }
    ]
  },
  // v3.5.0 发版更新说明：仅保留用户可感知变化和泛化修复措辞。
  '3.5.0': {
    title: 'v3.5.0',
    date: '2026-06-23',
    items: [
      { type: 'feature', get text() { return tr("新增 App 包管理增强：支持应用检索、详情查看和常用管理操作"); } },
      { type: 'feature', get text() { return tr("新增日志诊断规则库：支持自动诊断规则管理、测试与重置"); } },
      { type: 'feature', get text() { return tr("新增性能监控面板：支持设备资源采样、阈值设置与数据导出"); } },
      { type: 'feature', get text() { return tr("新增激活码管理增强：支持激活记录、备注和复制历史"); } },
      { type: 'improve', get text() { return tr("优化用户体验"); } },
      { type: 'fix', get text() { return tr("修复部分错误"); } }
    ]
  },
  // v3.5.1 发版更新说明：同步会员中心功能对比并保留泛化优化措辞。
  '3.5.1': {
    title: 'v3.5.1',
    date: '2026-06-23',
    items: [
      { type: 'improve', get text() { return tr("优化会员中心功能对比展示"); } },
      { type: 'improve', get text() { return tr("优化应用性能"); } },
      { type: 'improve', get text() { return tr("优化用户体验"); } },
      { type: 'fix', get text() { return tr("修复部分错误"); } }
    ]
  },
  // v3.5.2 发版更新说明：同步性能监控体验优化，保留泛化措辞。
  '3.5.2': {
    title: 'v3.5.2',
    date: '2026-06-24',
    items: [
      { type: 'improve', get text() { return tr("优化性能监控体验"); } },
      { type: 'improve', get text() { return tr("优化应用性能"); } },
      { type: 'fix', get text() { return tr("修复部分错误"); } }
    ]
  },
  // v3.5.3 发版更新说明：APK 管理修复按规范使用泛化措辞。
  '3.5.3': {
    title: 'v3.5.3',
    date: '2026-06-24',
    items: [
      { type: 'fix', get text() { return tr("修复部分错误"); } }
    ]
  },
  '3.8.0': {
    title: 'v3.8.0',
    date: '2026-06-27',
    items: [
      { type: 'feature', get text() { return tr("新增问题排查：支持按场景采集诊断证据并搜索选择目标包名"); } },
      { type: 'feature', get text() { return tr("新增环境自检弹窗：集中检查 ADB、scrcpy 和设备授权状态"); } },
      { type: 'feature', get text() { return tr("新增产物中心：集中查看问题排查、任务和分析产物"); } },
      { type: 'improve', get text() { return tr("优化偏好设置：支持自定义全局命令按键"); } },
      { type: 'improve', get text() { return tr("优化用户体验"); } },
      { type: 'fix', get text() { return tr("修复部分错误"); } }
    ]
  },
  '3.7.1': {
    title: 'v3.7.1',
    date: '2026-06-25',
    items: [
      { type: 'feature', get text() { return tr("新增任务中心普通模式：支持场景模板、录制流程和简化运行设置"); } },
      { type: 'improve', get text() { return tr("优化任务中心步骤展示，使用自然语言摘要降低脚本编排门槛"); } },
      { type: 'improve', get text() { return tr("优化用户体验"); } },
      { type: 'fix', get text() { return tr("修复部分错误"); } }
    ]
  },
  '3.7.0': {
    title: 'v3.7.0',
    date: '2026-06-25',
    items: [
      { type: 'feature', get text() { return tr("新增自动化压测：支持录制回放、截图比对和外部脚本步骤"); } },
      { type: 'improve', get text() { return tr("优化自动化压测：增强控件选择器、坐标回放和曲线滑动支持"); } },
      { type: 'improve', get text() { return tr("优化用户体验"); } },
      { type: 'fix', get text() { return tr("修复部分错误"); } }
    ]
  },
  '3.6.2': {
    title: 'v3.6.2',
    date: '2026-06-24',
    items: [
      { type: 'feature', get text() { return tr("新增任务中心保存路径设置，支持自定义任务产物目录"); } },
      { type: 'improve', get text() { return tr("优化任务中心运行历史展示和目录打开体验"); } },
      { type: 'improve', get text() { return tr("优化用户体验"); } },
      { type: 'fix', get text() { return tr("修复部分错误"); } }
    ]
  },
  '3.6.1': {
    title: 'v3.6.1',
    date: '2026-06-24',
    items: [
      { type: 'improve', get text() { return tr("优化应用更新稳定性"); } },
      { type: 'fix', get text() { return tr("修复部分错误"); } }
    ]
  },
  '3.6.0': {
    title: 'v3.6.0',
    date: '2026-06-24',
    items: [
      { type: 'feature', get text() { return tr("新增任务中心：支持复现步骤编排与后台执行进度展示"); } },
      { type: 'feature', get text() { return tr("新增设备巡检和性能报告 AI 分析，可按需勾选生成"); } },
      { type: 'feature', get text() { return tr("新增巡检报告和性能报告保存路径设置与打开入口"); } },
      { type: 'feature', get text() { return tr("新增 MCP 服务工具：支持应用包查询、性能采样和设备巡检"); } },
      { type: 'improve', get text() { return tr("优化性能监控体验"); } },
      { type: 'improve', get text() { return tr("优化应用性能"); } },
      { type: 'improve', get text() { return tr("优化用户体验"); } },
      { type: 'fix', get text() { return tr("修复部分错误"); } }
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
