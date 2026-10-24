import { tr } from './i18n.js';
import { applyMigrationPreferences } from './dataMigrationStorage.js';

export async function restoreStartupData(api = window.electronAPI, storage = localStorage) {
  if (!api?.migrationBootstrap) return;
  const state = await api.migrationBootstrap();
  if (!state?.ok) throw new Error(state?.error || tr("无法读取数据迁移状态"));
  if (!state.id || !state.preferences) return;
  try {
    applyMigrationPreferences(state.preferences, storage, state.removePreferenceKeys || []);
    const done = await api.migrationAcknowledge({ id: state.id });
    if (!done?.ok) throw new Error(done?.error || tr("无法完成数据迁移"));
  } catch (error) {
    const rollback = await api.migrationRollback({ id: state.id });
    if (!rollback?.ok) throw new Error(tr("{0}；恢复失败：{1}", { 0: error.message, 1: rollback?.error || tr("请保留恢复备份并重启应用") }));
    applyMigrationPreferences(rollback.preferences || rollback.previousPreferences || {}, storage, rollback.removePreferenceKeys || []);
    const done = await api.migrationAcknowledge({ id: state.id });
    if (!done?.ok) throw new Error(tr("已恢复原数据，但无法完成恢复状态确认：{0}", { 0: done?.error || tr("请重新启动应用") }));
  }
}
