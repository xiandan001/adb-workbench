# 项目记忆 - adb-workbench

## 更新日志（changelog）措辞规范

写给用户看的更新说明，遵循以下规则：

| 改动类型 | changelog 写法 |
|----------|---------------|
| 新增功能 | 具体描述功能，如"新增会员中心：基础版/会员版双档位" |
| 修改功能 | 具体描述变更，如"设备列表非会员限制为 1 台" |
| Bug 修复（内部细节） | 统一写"修复部分错误"，不暴露技术细节 |
| 性能优化（内部细节） | 统一写"优化应用性能"，不暴露技术细节 |
| 体验优化（内部细节） | 统一写"优化用户体验"，不暴露技术细节 |

**核心原则**：只有用户能感知的功能变化才具体描述；代码内部细节（重构、异步化、缓存、算法等）一律用泛化措辞。

## 发布流程（Release + OTA 产物上传）

每次发版必须完整执行以下步骤，缺一不可：

### 1. 构建安装包
```powershell
# 先清理旧产物，避免 NSIS "Can't open output file" 错误
Get-Process -Name "卓控台*" -ErrorAction SilentlyContinue | Stop-Process -Force
if (Test-Path release) { Remove-Item release -Recurse -Force }
npm run electron:build
```

### 2. 上传 OTA 产物到 GitHub Release
构建后在 `release/` 目录生成 3 个文件，**全部必须上传**，否则 OTA 自动更新不生效：
- `adb-workbench-setup-X.X.X.exe` — 安装包（约 114MB）
- `adb-workbench-setup-X.X.X.exe.blockmap` — 差分更新块映射（OTA 增量更新必需）
- `latest.yml` — OTA 元数据（electron-updater 据此检查版本和下载路径）

上传方式（PowerShell + GitHub API）：
```powershell
$headers = @{ Authorization = "Bearer $env:GH_TOKEN"; Accept = "application/vnd.github+json" }
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/xiandan001/adb-workbench/releases/tags/vX.X.X" -Headers $headers
$uploadUrl = $release.upload_url -replace '\{.*\}', ''

# 上传文件名需与 electron-builder 产物保持一致
# adb-workbench-setup-3.0.0.exe
foreach ($f in $files) {
  $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $f.path))
  Invoke-RestMethod -Uri "$uploadUrl`?name=$($f.name)" -Method POST -Headers @{
    Authorization = "Bearer $env:GH_TOKEN"; "Content-Type" = $f.mime
  } -Body $bytes
}
```

### 3. Release 产物命名规范
上传时文件名必须用连字符格式（参考历史版本 v2.0.13、v2.1.0）：
- `adb-workbench-setup-3.0.0.exe`
- `adb-workbench-setup-3.0.0.exe.blockmap`
- `latest.yml`

### 4. Git 操作
- 版本号改 `package.json` 一处即可（version.cjs 通过 `app.getVersion()` 同步全局）
- 打 tag：`git tag -f vX.X.X HEAD && git push origin vX.X.X --force`
- 推送分支（develop-vip 或对应开发分支），**不要直接推 main**

## 版本号管理
- 版本号统一管理：修改 `package.json` 的 `version` 字段一处即可
- `electron/lib/version.cjs` 通过 `app.getVersion()` 自动读取，无需多处修改
- changelog 需手动在 `src/data/changelogs.js` 添加对应版本条目
