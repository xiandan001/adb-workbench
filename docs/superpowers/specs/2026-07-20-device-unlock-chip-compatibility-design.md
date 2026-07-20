# 设备解锁芯片平台兼容设计

日期：2026-07-20

## 目标

为现有设备 Unlock 流程增加 RK 与 MTK 芯片平台兼容：RK 设备在第二步执行 `fastboot oem at-unlock-vboot`，并在解锁后执行两次 `fastboot reboot`；MTK 设备执行 `fastboot flashing unlock`，并保持执行一次 `fastboot reboot`。

## 当前行为

Electron 主进程的 `adb:unlock` 处理器先通过 ADB 将目标设备重启到 bootloader，然后固定执行 `fastboot flashing unlock`。现有流程没有读取或判断芯片平台，因此 RK 设备会执行错误的解锁指令。

## 方案

在设备仍处于 ADB 在线状态时读取以下系统属性：

- `ro.hardware`
- `ro.board.platform`
- `ro.boot.hardware`

将属性值合并并转为小写。只要检测到 `rockchip` 或以 `rk` 加数字开头的芯片标识，就判定为 RK 平台；其余结果均按 MTK 平台处理，包括明确的 MTK 标识、未知平台、空属性和属性读取失败。

平台与 Fastboot 执行计划的映射为：

| 平台判定 | 解锁参数 | 解锁后重启次数 |
| --- | --- | --- |
| RK | `oem at-unlock-vboot` | 2 |
| MTK 或未知 | `flashing unlock` | 1 |

## 执行流程

1. 在 ADB 模式读取芯片平台属性并确定第二步参数。
2. 执行 `adb -s <deviceId> reboot bootloader`。
3. RK 设备执行 `fastboot oem at-unlock-vboot`；其他设备执行 `fastboot flashing unlock`。
4. 沿用现有 `Finished` 输出校验。
5. RK 设备顺序执行并校验两次 `fastboot reboot`；其他设备执行并校验一次。
6. 沿用现有设备列表延迟刷新流程。

平台探测仅决定解锁参数和解锁后重启次数，不改变 IPC 接口、预加载桥接或前端交互。

## 异常处理

- 平台属性读取失败时不中断解锁流程，回退到现有 MTK 指令。
- ADB 重启失败、Fastboot 解锁失败、未检测到 `Finished` 或任意一次 Fastboot 重启失败时，返回失败并停止后续步骤。
- 不在一次流程中依次尝试两种解锁指令，避免第一条指令已部分生效后再次执行解锁操作。

## 修改范围

- 仅修改 `electron/lib/adb.cjs` 中的平台判定、`adb:unlock` 第二步参数选择和解锁后重启次数。
- 不修改前端文案、确认弹窗、IPC 参数或当前版本更新日志。
- 不处理其他芯片平台的专用解锁命令。

## 验收标准

- RK 属性样例会选择 `fastboot oem at-unlock-vboot`。
- RK 属性样例会在解锁后顺序执行两次 `fastboot reboot`。
- MTK 属性样例会选择 `fastboot flashing unlock`。
- MTK、未知、空属性和属性读取失败会在解锁后执行一次 `fastboot reboot`。
- 未知、空属性和属性读取失败会选择 `fastboot flashing unlock`。
- 每次 Fastboot 重启都沿用原有命令结果和 `Finished` 标识校验，前端刷新行为保持不变。
- `node --check electron/lib/adb.cjs`、`npm run lint` 和 `npm run build` 通过。
- 新增及修改文件保持 UTF-8 和 LF 换行。
