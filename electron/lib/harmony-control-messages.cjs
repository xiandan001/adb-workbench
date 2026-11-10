const { tr } = require('./localization.cjs');
function controlMessages() {
  return {
    INPUT_BUSY: tr('上一条控制操作尚未完成，请稍后再试。'),
    INPUT_SESSION: tr('画面尚未就绪或投屏已停止，请稍后再试。'),
    INPUT_DEVICE_CHANGED: tr('设备连接已变化，请重新连接后再试。'),
    INPUT_ARGUMENT: tr('控制参数无效，未发送操作。'),
    INPUT_UNSUPPORTED: tr('当前设备不支持此控制操作。'),
    INPUT_HELP: tr('无法确认设备控制能力，请导出应用日志。'),
    INPUT_API: tr('无法确认设备系统版本，未发送文本。'),
    INPUT_PERMISSION: tr('设备未允许输入控制，请检查设备权限。'),
    INPUT_TRANSPORT: tr('控制连接未完成，请检查设备连接。'),
    INPUT_REMOTE_EXIT: tr('设备未接受此操作，请导出应用日志。'),
    INPUT_REMOTE_UNCONFIRMED: tr('未收到控制命令完成确认，请导出应用日志。'),
    INPUT_TIMEOUT: tr('控制请求超时，未自动重试。'),
    INPUT_CANCELLED: tr('控制操作已取消。'),
    INPUT_COMMAND: tr('设备未完成控制操作，请导出应用日志。'),
    INPUT_UNKNOWN: tr('控制操作未完成，请导出应用日志。'),
  };
}
module.exports = { controlMessages };
