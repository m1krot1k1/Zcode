// Жизненный цикл Node-входа: telemetry-загрузчики, dispose-цепочка, миграция хранилища.
import { ICloudContentService } from "#src/cloud-content/cloudContent.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { AutomationRepo } from "#src/session/automationRepo.js";
import { IBotsService } from "../bots/bots.js";
import { ICodeIntelligenceService } from "../code-intelligence/contract.js";
import type { CodeIntelligenceService } from "../code-intelligence/contract.js";
import { ServiceCollection } from "../collection.js";
import { ICredentialService } from "../credential/credential.js";
import { IFileWatcherService } from "../fileWatcher/fileWatcher.js";
import { IGenUiService } from "../gen-ui/contract.js";
import { OAuthCredentialRepo } from "../oauth/repo/oauthCredentialRepo.js";
import { IOpenCodeAcpRuntime } from "../opencode-acp-runtime/contract.js";
import { IOffPeakTaskService } from "../session/offPeakTask.js";
import { OffPeakTaskRepo } from "../session/offPeakTaskRepo.js";
import { TaskIndexRepo } from "../session/taskIndexRepo.js";
import { IZCodeTaskService } from "../session/zcodeTaskService.js";
import { ISubagentsService } from "../subagents/subagents.js";
import { ITerminalService } from "../terminal/terminal.js";
import { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import { IZCodeSessionService } from "../zcode-session/zcodeSession.js";
import { type AppSettings, isCredentialDecryptError } from "@zcode/shared";
import {
  hasDisposeAll,
  hasDisposeAllAndWait,
  managedCuaHelperHosts,
  managedHostApiNetworkTransports,
  providerProvisioningSources,
  providerProvisioningTriggerDisposers,
  providerRuntimes,
  sharedSqliteRepos,
  taskAutoArchiveDisposers,
} from "./side-tables.js";
export function createTelemetryUserIdLoader(
  credentialService: Pick<ICredentialService, "load">,
): () => Promise<string> {
  const log = createServiceLogger("telemetry-user-id");
  return async () => {
    try {
      const activeProvider = (await credentialService.load("oauth:active_provider"))?.trim() ?? "";
      if (!activeProvider) {
        return "";
      }

      const rawUserInfo = await credentialService.load(`oauth:${activeProvider}:user_info`);
      return readTelemetryOAuthUserId(rawUserInfo);
    } catch (error) {
      if (!isCredentialDecryptError(error)) {
        throw error;
      }

      // Bugfix: telemetry 只是只读 userId 上报入口，不能抢在 host OAuthService 前
      // 对损坏凭据做半套清理；否则会漏掉派生模型 provider key 的 logout 收口。
      log.warn(undefined, "skip telemetry user id: OAuth credential decrypt failed", error);
      return "";
    }
  };
}

/** 仅给同一事件账号返回当前 ZCode JWT；不缓存、不修改登录凭据。 */
export function createTelemetryAuthorizationLoader(
  credentialService: Pick<ICredentialService, "load">,
): (userId: string) => Promise<string | null> {
  return async (userId) => {
    if (!userId) return null;
    try {
      const provider = (await credentialService.load("oauth:active_provider"))?.trim();
      if (provider !== "zai" && provider !== "bigmodel") return null;
      const readUserId = async () =>
        readTelemetryOAuthUserId(await credentialService.load(`oauth:${provider}:user_info`));
      if ((await readUserId()) !== userId) return null;
      const jwt = (await credentialService.load("zcodejwttoken"))?.trim();
      // 退出/切账号可能发生在异步读取期间；禁止将旧身份的 token 附到其他账号事件上。
      if (
        (await credentialService.load("oauth:active_provider"))?.trim() !== provider ||
        (await readUserId()) !== userId
      )
        return null;
      return jwt && /^[\x21-\x7e]+$/.test(jwt) ? `Bearer ${jwt}` : null;
    } catch {
      return null;
    }
  };
}

export function createTelemetryMarketingParamsLoader(
  credentialService: ICredentialService,
): () => Promise<import("@zcode/shared").OAuthLoginAttribution | null> {
  // 恢复原因：固定返回 null 会丢掉已保存的渠道归因，数仓应读取 OAuth 的同一份事实。
  const repo = new OAuthCredentialRepo(credentialService);
  return () => repo.loadLoginAttribution();
}

function readTelemetryOAuthUserId(rawUserInfo: string | null): string {
  if (!rawUserInfo) {
    return "";
  }

  try {
    const parsed = JSON.parse(rawUserInfo) as {
      id?: unknown;
      user_id?: unknown;
    };
    const id = typeof parsed.id === "string" ? parsed.id : "";
    const userId = typeof parsed.user_id === "string" ? parsed.user_id : "";
    return id.trim() || userId.trim();
  } catch {
    return "";
  }
}

export function disposeServiceResources(services: ServiceCollection): void {
  const content = services.getOptional(ICloudContentService);
  if (content && hasDisposeAllAndWait(content)) void content.disposeAllAndWait().catch(() => {});
  void services
    .getOptional(IOpenCodeAcpRuntime)
    ?.disposeAllAndWait()
    .catch(() => {});
  (
    services.getOptional(IGenUiService) as (IGenUiService & { dispose?(): void }) | undefined
  )?.dispose?.();
  // Bugfix: host process 退出前以前没有统一遍历本地服务做资源回收，
  // terminal/task wrapper 这类会拉起子进程的服务只能等宿主进程自己结束，时序上可能留下短暂残留。
  // 这里集中调用各服务的本地 disposeAll 钩子，把“退出 app = 回收所有托管资源”落成机械动作。
  const disposableServices = [
    services.getOptional(ITerminalService),
    services.getOptional(IZCodeTaskService),
    services.getOptional(IZCodeAgentService),
    services.getOptional(IZCodeSessionService),
    services.getOptional(IBotsService),
    services.getOptional(IFileWatcherService),
    services.getOptional(ISubagentsService),
    services.getOptional(IOffPeakTaskService),
    services.getOptional(ICodeIntelligenceService) as
      | (CodeIntelligenceService & { disposeAll?(): void })
      | undefined,
  ].filter((service) => service !== undefined);

  for (const service of disposableServices) {
    if (hasDisposeAll(service)) {
      service.disposeAll();
    }
  }

  // 同步 best-effort：终止托管的 Computer Use Helper（不 await，避免阻断同步 dispose 路径）。
  const managedCuaHelperHost = managedCuaHelperHosts.get(services);
  if (managedCuaHelperHost) {
    void managedCuaHelperHost.stop().catch(() => {});
  }
  // 关闭共享 tasks-index sqlite 句柄（Windows 上悬着句柄会让后续目录清理撞 EBUSY）
  for (const repo of sharedSqliteRepos.get(services) ?? []) repo.close();
  sharedSqliteRepos.delete(services);
  providerRuntimes.get(services)?.dispose();
  for (const dispose of providerProvisioningTriggerDisposers.get(services) ?? []) dispose();
  providerProvisioningTriggerDisposers.delete(services);
  providerProvisioningSources.delete(services);
  taskAutoArchiveDisposers.get(services)?.();
  taskAutoArchiveDisposers.delete(services);
  managedHostApiNetworkTransports.get(services)?.dispose();
}

export async function disposeServiceResourcesAndWait(services: ServiceCollection): Promise<void> {
  (
    services.getOptional(IGenUiService) as (IGenUiService & { dispose?(): void }) | undefined
  )?.dispose?.();
  // app 关闭时 host 需要等 agent 进程树完成 graceful + force 清理。
  // 旧的同步 dispose 会在 host 退出时丢掉强杀 timer，导致 zcode-cli/app-server 变成孤儿进程。
  const disposableServices = [
    services.getOptional(ICloudContentService),
    services.getOptional(ITerminalService),
    services.getOptional(IZCodeTaskService),
    services.getOptional(IZCodeAgentService),
    services.getOptional(IZCodeSessionService),
    services.getOptional(IBotsService),
    services.getOptional(IFileWatcherService),
    services.getOptional(ISubagentsService),
    services.getOptional(IOffPeakTaskService),
    services.getOptional(ICodeIntelligenceService) as
      | (CodeIntelligenceService & { disposeAll?(): void; disposeAllAndWait?(): Promise<void> })
      | undefined,
    services.getOptional(IOpenCodeAcpRuntime),
  ].filter((service) => service !== undefined);

  for (const service of disposableServices) {
    if (hasDisposeAllAndWait(service)) {
      await service.disposeAllAndWait();
    } else if (hasDisposeAll(service)) {
      service.disposeAll();
    }
  }

  // 等待托管的 Computer Use Helper 终止（best-effort）：Helper 是长生命周期高权限进程，服务释放语义必须显式
  // 收口它，不能只靠 launcher-pid watchdog / 进程退出兜底。
  const managedCuaHelperHost = managedCuaHelperHosts.get(services);
  if (managedCuaHelperHost) {
    await managedCuaHelperHost.stop().catch(() => {});
  }
  // 关闭共享 tasks-index sqlite 句柄（同 disposeServiceResources，异步收口路径也要释放）
  for (const repo of sharedSqliteRepos.get(services) ?? []) repo.close();
  sharedSqliteRepos.delete(services);
  providerRuntimes.get(services)?.dispose();
  for (const dispose of providerProvisioningTriggerDisposers.get(services) ?? []) dispose();
  providerProvisioningTriggerDisposers.delete(services);
  providerProvisioningSources.delete(services);
  taskAutoArchiveDisposers.get(services)?.();
  taskAutoArchiveDisposers.delete(services);
  await managedHostApiNetworkTransports
    .get(services)
    ?.disposeAndWait()
    .catch(() => {});
}

/** 所有应用入口在开放 RPC / 调度器前等待；失败不启动业务写者。 */
export async function migrateApplicationStorage(
  settings?: Pick<AppSettings, "lastWorkspaceSession" | "recentProjects">,
  hostId?: string,
): Promise<{ backupSkipped: boolean }> {
  const automations = new AutomationRepo();
  const offPeak = new OffPeakTaskRepo();
  const tasks = new TaskIndexRepo(settings, hostId);
  try {
    await automations.ensureReady();
    await offPeak.ensureReady();
    await tasks.ensureReady();
    return {
      backupSkipped:
        tasks.migrationBackupSkipped ||
        automations.migrationBackupSkipped ||
        offPeak.migrationBackupSkipped,
    };
  } finally {
    tasks.close();
    offPeak.close();
    automations.close();
  }
}
