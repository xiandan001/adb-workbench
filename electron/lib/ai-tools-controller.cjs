const { validateArguments, validateCommandName } = require('./ai-tools-policy.cjs');

const COMMANDS = Object.freeze([
  'snapshot', 'provider_save', 'provider_remove', 'provider_test', 'models_list', 'quota_query',
  'config_status', 'config_preview', 'config_apply', 'backups_list', 'backup_preview_restore',
  'sessions_scan', 'sessions_list', 'sessions_open',
  'router_status', 'router_save', 'router_remove', 'router_start', 'router_stop', 'router_profile', 'router_copy_key',
  'resources_snapshot', 'resources_mcp_save', 'resources_mcp_remove', 'resources_prompt_save', 'resources_prompt_remove', 'resources_mcp_preview', 'resources_prompt_preview', 'resources_apply', 'resources_backups_list', 'resources_backup_preview_restore',
  'projects_snapshot', 'projects_pick', 'projects_save', 'projects_remove', 'projects_open', 'projects_environment', 'projects_launch_preview', 'projects_launch',
  'portable_export', 'portable_preview', 'portable_apply', 'portable_recoveries_list', 'portable_recovery_preview', 'portable_recovery_apply',
  'skills_list', 'skills_read', 'skills_import', 'skills_remove', 'skills_install_preview', 'skills_uninstall_preview', 'skills_apply', 'skills_backups_list', 'skills_backup_preview_restore',
]);
const fail = (code, message) => Object.assign(new Error(message), { code });

function createAiToolsController({ store, config, quota, models, sessions, router, resources, projects, portable, skills, pickBackup, pickDirectory, copyText, tools, getMembership, getOwner }) {
  let disposed = false; let migrationReserved = false;
  const capabilities = COMMANDS.filter(command => (!command.startsWith('sessions_') || sessions) && (!command.startsWith('router_') || router) && (!command.startsWith('resources_') || resources) && (!command.startsWith('projects_') || projects) && (!command.startsWith('portable_') || portable && pickBackup) && (!command.startsWith('skills_') || skills) && (!['projects_pick', 'skills_import'].includes(command) || pickDirectory) && (command !== 'router_copy_key' || copyText));
  const operations = new Set(); const tasks = new Set(); const restoreTokens = new Set(); const resourceRestoreTokens = new Set(); const skillRestoreTokens = new Set();
  function authorize(event) {
    const owner = getOwner();
    if (!owner || owner.isDestroyed() || !owner.webContents.mainFrame || event?.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) throw fail('AI_TOOLS_OWNER_REQUIRED', '请在卓控台主窗口操作 AI 工具');
    if (disposed) throw fail('AI_TOOLS_DISPOSED', 'AI 工具工作区正在退出');
    if (migrationReserved) throw fail('AI_TOOLS_MIGRATION_PENDING', '数据迁移已准备开始，请等待重启后继续操作 AI 工具');
  }
  async function perform(event, raw) {
    const abort = new AbortController();
    try {
      authorize(event);
      const request = validateArguments(raw);
      if (Object.keys(request).some(key => !['command', 'args'].includes(key))) throw fail('AI_TOOLS_INVALID_REQUEST', 'AI 工具请求格式无效');
      const command = validateCommandName(request.command);
      if (!capabilities.includes(command)) throw fail('AI_TOOLS_COMMAND_UNKNOWN', '此 AI 工具功能尚未接通');
      const args = validateArguments(request.args === undefined ? {} : request.args);
      if (operations.size >= 16) throw fail('AI_TOOLS_BUSY', 'AI 工具操作过多，请等待当前操作完成');
      operations.add(abort);
      const status = await getMembership(); authorize(event);
      const activated = status?.activated === true && status.scope === 'vip';
      const membership = { activated, reason: activated ? null : status?.reason || 'membership_required' };
      const recovery = command === 'backups_list' || command === 'backup_preview_restore' || command === 'config_apply' && restoreTokens.has(args.token) || command === 'router_stop'
        || command === 'resources_backups_list' || command === 'resources_backup_preview_restore' || command === 'resources_apply' && resourceRestoreTokens.has(args.token)
        || ['portable_recoveries_list', 'portable_recovery_preview', 'portable_recovery_apply'].includes(command)
        || ['skills_backups_list', 'skills_backup_preview_restore'].includes(command) || command === 'skills_apply' && skillRestoreTokens.has(args.token);
      if (command === 'snapshot') {
        const data = activated ? await store.snapshot() : { providers: [], persistent: null, warning: '' };
        return { success: true, result: { ...data, membership, tools, capabilities, quota: activated ? quota.list() : [] } };
      }
      if (!activated && !recovery) throw fail('AI_TOOLS_MEMBERSHIP_REQUIRED', 'AI 工具管理使用卓控台现有会员权益，请前往会员中心激活');
      let result;
      switch (command) {
        case 'provider_save': {
          router?.assertProviderMutable(args.provider?.id);
          result = await store.saveProvider(args.provider);
          quota.invalidate(result.id); break;
        }
        case 'provider_remove':
          router?.assertProviderMutable(args.providerId);
          result = await store.removeProvider(args.providerId); quota.invalidate(args.providerId); break;
        case 'provider_test':
          result = await models.test(await store.getProvider(args.providerId), { signal: abort.signal }); break;
        case 'models_list':
          result = await models.list(await store.getProvider(args.providerId), { signal: abort.signal }); break;
        case 'quota_query':
          result = await quota.query(await store.getProvider(args.providerId), { signal: abort.signal, force: args.force === true }); break;
        case 'config_status': {
          const data = await store.snapshot();
          const providerIds = data.providers.filter(provider => provider.targetApps?.includes(args.toolId)).map(provider => provider.id);
          result = await config.status({ toolId: args.toolId, providerIds, signal: abort.signal }); break;
        }
        case 'config_preview':
          result = await config.preview({ toolId: args.toolId, providerId: args.providerId }); break;
        case 'config_apply':
          restoreTokens.delete(args.token);
          result = await config.apply({ token: args.token }); break;
        case 'backups_list': result = { backups: await config.listBackups() }; break;
        case 'backup_preview_restore':
          result = await config.previewRestore({ backupId: args.backupId });
          if (restoreTokens.size >= 32) restoreTokens.delete(restoreTokens.values().next().value);
          restoreTokens.add(result.token); break;
        case 'sessions_scan': result = await sessions.scan(); break;
        case 'sessions_list': result = await sessions.list({ search: args.search, toolId: args.toolId, offset: args.offset }); break;
        case 'sessions_open': result = await sessions.open({ id: args.id, offset: args.offset }); break;
        case 'router_status': result = router.snapshot(); break;
        case 'router_save': result = router.save(args.route); break;
        case 'router_remove': result = router.remove(args.routeId); break;
        case 'router_start': result = await router.start(args.port); break;
        case 'router_stop': result = await router.stop(); break;
        case 'router_profile': result = router.profile({ routeId: args.routeId, targetApps: args.targetApps }); break;
        case 'router_copy_key': await copyText(router.getKey()); result = { copied: true }; break;
        case 'resources_snapshot': result = resources.snapshot(); break;
        case 'resources_mcp_save': result = resources.saveMcp(args.mcp); break;
        case 'resources_mcp_remove': result = resources.removeMcp({ id: args.mcpId }); break;
        case 'resources_prompt_save': result = resources.savePrompt(args.prompt); break;
        case 'resources_prompt_remove': result = resources.removePrompt({ id: args.promptId }); break;
        case 'resources_mcp_preview': result = resources.previewMcp({ toolId: args.toolId, mcpId: args.mcpId, enabled: args.enabled }); break;
        case 'resources_prompt_preview': result = resources.previewPrompt({ toolId: args.toolId, promptId: args.promptId, enabled: args.enabled }); break;
        case 'resources_apply': resourceRestoreTokens.delete(args.token); result = resources.apply({ token: args.token }); break;
        case 'resources_backups_list': result = { backups: resources.listBackups() }; break;
        case 'resources_backup_preview_restore':
          result = resources.previewRestore({ backupId: args.backupId });
          if (resourceRestoreTokens.size >= 32) resourceRestoreTokens.delete(resourceRestoreTokens.values().next().value);
          resourceRestoreTokens.add(result.token); break;
        case 'projects_snapshot': result = projects.snapshot(); break;
        case 'projects_pick': {
          const selected = await pickDirectory('选择 AI 项目文件夹'); authorize(event);
          result = selected ? projects.offerDirectory(selected) : { cancelled: true }; break;
        }
        case 'projects_save': result = projects.save(args.project); break;
        case 'projects_remove': result = projects.remove(args.projectId); break;
        case 'projects_open': result = await projects.open(args.projectId); break;
        case 'projects_environment': result = await projects.environment(); break;
        case 'projects_launch_preview': result = await projects.previewLaunch({ projectId: args.projectId, providerId: args.providerId }); break;
        case 'projects_launch': result = await projects.launch({ token: args.token }); break;
        case 'portable_export':
        case 'portable_preview': {
          const selected = await pickBackup(command === 'portable_export'); authorize(event);
          result = !selected ? { cancelled: true } : command === 'portable_export'
            ? await portable.exportBundle({ path: selected.path, expectedHash: selected.expectedHash, password: args.password })
            : await portable.previewImport({ path: selected.path, password: args.password }); break;
        }
        case 'portable_apply': router?.assertIdle(); result = portable.applyImport({ token: args.token }); break;
        case 'portable_recoveries_list': result = { recoveries: portable.listRecoveries() }; break;
        case 'portable_recovery_preview': result = portable.previewRecovery({ backupId: args.backupId }); break;
        case 'portable_recovery_apply': router?.assertIdle(); result = portable.applyRecovery({ token: args.token }); break;
        case 'skills_list': result = { skills: skills.list(), tools: tools.filter(tool => ['claude', 'codex', 'gemini', 'opencode'].includes(tool.id)).map(({ id, label }) => ({ id, label })) }; break;
        case 'skills_read': result = skills.read({ id: args.id }); break;
        case 'skills_import': {
          const selected = await pickDirectory('选择包含 SKILL.md 的技能文件夹'); authorize(event);
          result = selected ? skills.importDirectory({ sourceDirectory: selected }) : { cancelled: true }; break;
        }
        case 'skills_remove': result = skills.remove({ id: args.id }); break;
        case 'skills_install_preview': result = skills.previewInstall({ skillId: args.skillId, toolId: args.toolId }); break;
        case 'skills_uninstall_preview': result = skills.previewUninstall({ skillId: args.skillId, toolId: args.toolId }); break;
        case 'skills_apply': skillRestoreTokens.delete(args.token); result = skills.apply({ token: args.token }); break;
        case 'skills_backups_list': result = { backups: skills.listBackups() }; break;
        case 'skills_backup_preview_restore':
          result = skills.previewRestore({ backupId: args.backupId });
          if (skillRestoreTokens.size >= 32) skillRestoreTokens.delete(skillRestoreTokens.values().next().value);
          skillRestoreTokens.add(result.token); break;
      }
      authorize(event);
      if (abort.signal.aborted) throw fail('AI_TOOLS_CANCELLED', 'AI 工具操作已取消');
      return { success: true, result: result ?? {} };
    } catch (error) {
      const known = typeof error?.code === 'string' && error.code.startsWith('AI_TOOLS_');
      return { success: false, error: { code: known ? error.code : 'AI_TOOLS_OPERATION_FAILED', message: known ? String(error.message).slice(0, 1000) : 'AI 工具操作未完成，请检查配置或本地存储后重试',
        ...(known && typeof error.backupId === 'string' && /^[a-f0-9-]{36}$/i.test(error.backupId) ? { backupId: error.backupId } : {}) } };
    } finally { operations.delete(abort); }
  }
  function execute(event, raw) {
    const task = perform(event, raw); tasks.add(task);
    void task.finally(() => tasks.delete(task)); return task;
  }
  return { execute, register(ipcMain) { ipcMain.handle('ai-tools:request', execute); },
    async reserveForMigration() {
      if (disposed || migrationReserved) throw fail('AI_TOOLS_MIGRATION_PENDING', 'AI 工具正在退出或已有待完成的数据迁移');
      migrationReserved = true;
      try {
        for (const operation of operations) operation.abort();
        projects?.cancelPending(); await sessions?.cancelPending();
        await Promise.allSettled([...tasks]); await router?.stop();
      } catch (error) { migrationReserved = false; throw error; }
      return () => { if (!disposed) migrationReserved = false; };
    },
    async dispose() {
      disposed = true;
      for (const operation of operations) operation.abort();
      restoreTokens.clear(); resourceRestoreTokens.clear(); skillRestoreTokens.clear();
      quota.dispose?.(); portable?.dispose(); projects?.dispose();
      await Promise.all([sessions?.dispose(), router?.dispose()]);
      await Promise.allSettled([...tasks]);
      config.dispose?.(); resources?.dispose(); skills?.dispose();
    },
  };
}

module.exports = { createAiToolsController, AI_TOOLS_COMMANDS: COMMANDS };
