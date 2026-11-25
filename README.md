# 卓控台

> 基于 Electron + React 19 + TailwindCSS 构建的 Android、HarmonyOS / OpenHarmony 设备管理桌面工具，封装 `adb`、`hdc`、投屏、日志分析、性能监控、质量自动化、产物管理、会员授权与 OTA 更新能力。

![设备管理与 APK 管理](docs/readme-device-management.png)

## 核心能力

### HarmonyOS / OpenHarmony

- 与 Android 共用设备列表和功能入口，自动区分 ADB / HDC；USB 调试需在设备上授权。
- Windows 安装包自带 `hdc/hdc.exe` 和 USB 依赖，不要求用户安装 Python、DevEco Studio 或配置 PATH。
- 原生应用管理使用 Bundle / Ability，安装文件为 HAP/HSP；不会把 APK、Android 数字按键或历史脚本直接用于鸿蒙设备。
- 支持 HiLog 日志、原生截图、文件传输、系统采样、AI 排障及平台匹配的测试任务；不可读取的指标显示不可用，不推测为正常。
- 原生投屏与录屏需要设备提供兼容的 UITest 扩展和录屏接口，并保留系统授权。系统版本、ROM 权限或接口不兼容时会说明原因；不把截图轮询当作实时投屏。
- ADB 与 HDC 的终端历史和快捷操作分别保存，默认不会改变现有 Android 配置。

### 设备管理与 APK 管理

自动识别 USB / Wi-Fi ADB 设备，并为每台设备提供投屏、截图、录屏、音量、Root、Remount、重启、Loader、Unlock、终端、巡检和 APK 管理入口。

- USB / Wi-Fi 设备列表、连接历史和一键重连
- `scrcpy` 投屏参数统一配置，支持截图与录屏保存路径设置
- APK 安装、推送、包名搜索、系统应用筛选、批量选择、应用详情和快照
- APK 应用列表支持隐藏/显示搜索区，并持久化用户偏好
- 设备文件浏览、拉取、推送和常用目录快捷入口

### RK / MTK 固件刷机

在「设备与诊断 → 固件刷机」选择平台，也可从设备卡片的「设备维护」打开。刷机 USB 设备独立检测，设备无需保持 ADB 在线。

- 首次点击「打开厂商工具」时选择本机工具目录。可选择同时包含 `RK` 和 `MTK` 的目录，也可为各平台分别选择，之后会记住。支持已核对的 RKDevTool 3.28 和 SP Flash Tool V6 6.2444，由用户在本机提供。
- 应用启动后在后台检测一次驱动包及刷机 USB 设备，可手动刷新。安装时可选择本机的签名 `rockusb.inf` 或 `cdc-acm.inf`，并保留配套 CAT、SYS 文件的目录结构。Windows 管理员确认后会自动复查。公开安装包不包含未获分发许可的厂商驱动或工具。
- RK 直刷使用 `upgrade_tool` 2.46，不是 RKDevTool 图形程序。缺工具时可在直刷面板主动下载经 SHA-256 校验的 [ArmSoM 工具包](https://blog.armsom.org/zh/articles/rockchip-tool-upgrade-tool/)，也可选择本机对应目录。MTK 会复用已配置且通过校验的 V6 工具。工具只需准备一次，「开始刷机」不会弹出目录选择。
- RK 预检完整 `update.img`，MTK 预检 `flash.xml` 及配套文件。文件结构通过不代表适配任意板卡。应用内直刷限已登记固件和板型：IFPD3576_Pro 的 RK 整包升级，以及 IFPD-G520 的 MTK V6。MTK 默认仅下载，也支持固件升级和格式化后下载；格式化需要单独确认清除数据。MTK 由厂商工具确认写入成功后即完成，RK 保留刷后启动验证。其他组合仍可使用厂商工具。
- MTK 和 RK 都可以先用 USB ADB 只读登记一次目标；MTK 登记也会核对同一 USB 口在 Windows 已记录的下载端口。之后默认复用登记目标，按界面提示就绪后再接线、断电上电或长按开机键。从某个设备卡进入时，则优先选该设备。只接受登记的 USB 位置和匹配的平台。RK 未登记也可冷启动，识别后须选择目标并确认板型。准备时不要断电或换机；应用不会自动重启设备。
- 每个平台单独记住上次通过预检的固件，重开页面时重新检查，不会自动开始刷机。常用操作集中在主卡，工具、驱动和厂商工具可按需展开。进度显示工具报告的总百分比，或注明当前分区／阶段；没有准确数据时用不定进度表示。

### 性能监控、质量与产物

![性能监控](docs/readme-performance.png)

- 实时采样 CPU、内存、存储、温度、前台 FPS 和合成 FPS
- 支持采样间隔、阈值、导出、AI 分析报告和产物目录打开
- 质量中心提供回归基线、验收任务、设备巡检和证据包能力
- 任务中心支持复现脚本、多设备批量执行和运行历史
- 产物中心统一查看问题排查、巡检、性能和任务报告

### AI 日志助手与 MCP 服务

![AI 日志助手与 MCP 服务](docs/readme-ai-log-mcp.png)

- 独立日志分析窗口支持实时 logcat、文件加载、多维过滤和导出
- 内置 Crash / ANR / OOM / Native Crash 自动诊断和规则库
- AI 深度分析支持流式输出、Markdown 渲染、多轮追问和报告导出
- MCP 服务默认运行在 `http://127.0.0.1:49321/mcp`
- 外部 AI 工具可调用设备列表、包列表、性能采样、巡检和日志分析等工具

### 偏好设置与 OTA 更新

![偏好设置](docs/readme-settings.png)

- 偏好设置按快捷命令、投屏、保存路径、外观、更新和高危操作分组
- 固定分组导航支持阴影分层和页内快速跳转
- 支持截图、录屏、巡检、性能、任务中心和质量中心保存路径配置
- 内置自动更新检查、下载进度、安装重启和更新说明弹窗
- 高危操作确认支持记忆选择和统一重置

### 会员中心

![会员中心](docs/readme-member-center.png)

- 权益对比默认显示基础版和会员版的差异，也可查看全部
- 基础版可查看最近 5 条设备连接记录，会员版可查看本机保留的最近 20 条
- 基础版提供回归差异报告和本地规则诊断，会员版增加巡检证据包、自定义规则和内置 AI 分析
- 已有激活码可直接粘贴。从功能入口进入会员中心后，激活或取消均会返回原设备和任务并保留输入

## 环境要求

安装版已内置运行环境及设备工具，双击安装即可使用，不要求安装 Node.js 或修改 PATH。源码开发需要 Node.js；Android 调试使用内置 `scrcpy-win64`，鸿蒙调试使用内置 `hdc`：

1. [Node.js](https://nodejs.org/)
2. [ADB (Android Debug Bridge)](https://developer.android.com/studio/releases/platform-tools)
3. [scrcpy](https://github.com/Genymobile/scrcpy)

Windows 用户可直接使用项目内置的 `scrcpy-win64` 目录，或安装官方 scrcpy 并配置环境变量。

## 安装与运行

### 下载安装包

从 [GitHub Releases](https://github.com/xiandan001/adb-workbench/releases) 下载最新版安装包，双击安装即可使用。

### 源码运行

```bash
npm install
npm run electron:dev
```

### 构建安装包

内置 AI 的 Windows x64 原生模块需要 Visual Studio 2022 C++ Build Tools、Python 和与项目 Electron 版本匹配的本地构建头文件及 `node.lib`。构建时可使用已从 Git 排除的 `electron/api-keys.cjs`（参考模板），或由构建环境注入 `AGNES_API_KEYS`。安装包不包含这些输入。仅做本地源码开发时，先运行 `npm run build:builtin-ai` 即可在 `npm run electron:dev` 中使用内置 AI。

```bash
npm run electron:build
```

构建完成后，安装包、`.blockmap` 和 `latest.yml` 会输出到 `release/` 目录，用于桌面安装与 OTA 更新。

## 技术栈

| 类别 | 技术 |
| --- | --- |
| 框架 | Electron + React 19 |
| 构建 | Vite + electron-builder |
| 样式 | TailwindCSS 4 |
| 设备能力 | adb、scrcpy |
| 更新 | electron-updater |
| 协议 | MCP（Model Context Protocol） |

## 项目结构

```text
adb-workbench/
├── electron/              # Electron 主进程、IPC、自动更新、ADB 能力
├── src/                   # React 渲染进程
│   ├── App.jsx            # 主窗口
│   ├── components/        # 设备、日志、性能、质量、任务、会员等模块
│   ├── data/              # 主题、命令、更新日志
│   └── shared/            # 共享工具
├── docs/                  # README 截图与文档资产
├── scrcpy-win64/          # Windows 内置 scrcpy + adb
└── electron-builder.json  # 打包配置
```

## License

MIT
