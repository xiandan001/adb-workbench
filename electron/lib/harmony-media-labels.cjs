const { tr, getLocale } = require('./localization.cjs');
const { controlMessages } = require('./harmony-control-messages.cjs');
function mediaLabels() {
  return {
    locale: getLocale(), title: tr('鸿蒙原生投屏'), preparing: tr('正在准备独立媒体组件…'),
    awaiting: tr('请在设备上确认屏幕录制授权。'), streaming: tr('原生视频已连接（静音）'), stopped: tr('投屏已停止'),
    stop: tr('停止投屏'), record: tr('开始录像'), stopRecord: tr('停止并保存'), recording: tr('正在录像'),
    saving: tr('正在保存 WebM 录像…'), saved: tr('录像已保存'), recordFailed: tr('录像保存未完成，文件已保留，可从设备卡片重试。'),
    recordHint: tr('录像以真实 WebM 格式保存；本模式不采集麦克风或系统音频。'),
    inputEnabled: tr('允许控制设备'), home: tr('回到桌面'), back: tr('返回'), sendText: tr('发送文本'),
    controlSending: tr('正在发送控制操作…'), controlFailed: tr('控制操作未完成，请导出应用日志。'), controlErrors: controlMessages(),
    textPlaceholder: tr('输入要发送到设备的文本'), withLogs: tr('同时保存设备日志'), close: tr('关闭'),
    decoderError: tr('当前主机无法解码此视频流。'), transportError: tr('媒体连接中断或返回数据无效。'),
    unsupported: tr('当前设备的原生录屏能力或授权不满足要求。'), denied: tr('用户拒绝或中止了屏幕录制授权。'),
    consentNotice: tr('此窗口仅传输所选设备的画面；系统隐私授权与保护保持启用。'),
    errors: {
      H264_BYTES: tr('视频数据格式无效。'), H264_SIZE: tr('视频帧超过安全大小限制。'),
      H264_LENGTH: tr('视频帧长度无效或内容不完整。'), H264_CONFIG: tr('视频解码参数不完整或无效。')
    }
  };
}
module.exports = { mediaLabels };
