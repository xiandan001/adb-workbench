import { tr } from './i18n.js';

export function resolveSshReconnectProfile(session, profiles) {
  if (!session || !['disconnected', 'error'].includes(session.status)) throw new Error(tr('此 SSH 会话仍在连接或处理中，不能重复重连'));
  if (!session.profileId) throw new Error(tr('此会话没有已保存的连接配置，请新建连接；旧输出和草稿仍保留'));
  const profile = profiles.find(item => item.id === session.profileId);
  if (!profile || profile.host !== session.host || Number(profile.port) !== Number(session.port) || profile.username !== session.username) {
    throw new Error(tr('原连接配置已删除或主机信息已变更，请新建连接；不会重连到其他主机'));
  }
  return profile;
}
