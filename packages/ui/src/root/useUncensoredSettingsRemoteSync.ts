import { useEffect } from "react";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import { syncUncensoredSettingsToTarget } from "@/lib/uncensoredRemoteSync.js";
import type { IServiceAccessor } from "./contract.ts";

/**
 * Переносит настройки нецензурированных провайдеров в целевой Environment активного
 * remote-workspace. Вызывается на монтирование workspace-слоя и при смене remote-сессии:
 * до подключения Remote Host прокси отдаёт ошибки, поэтому эффект повторяется по
 * `remoteSessionId`, а неудачи только логируются — локальные настройки остаются источником.
 */
export function useUncensoredSettingsRemoteSync(params: {
  targetServices: IServiceAccessor;
  isRemote: boolean;
  remoteSessionId?: string;
  workspacePath: string;
  workspaceIdentity?: string;
}): void {
  const baseServices = useBaseWorkspaceServices();
  const { targetServices, isRemote, remoteSessionId, workspacePath, workspaceIdentity } = params;
  const localUncensored = baseServices.uncensoredSettingsService;
  const targetUncensored = targetServices.uncensoredSettingsService;
  const targetProviderSettings = targetServices.providerSettingsService;

  useEffect(() => {
    if (!isRemote || !localUncensored || !targetUncensored || !targetProviderSettings) return;
    const workspace = workspaceIdentity ? { workspacePath, workspaceIdentity } : { workspacePath };
    let cancelled = false;

    void (async () => {
      try {
        const outcome = await syncUncensoredSettingsToTarget({
          readLocal: () => localUncensored.getTakeoverConfig(workspace),
          readTarget: () => targetUncensored.getConfig(workspace),
          writeTarget: (write) => targetUncensored.updateConfig(workspace, write),
          refreshTarget: () => targetProviderSettings.refresh("uncensored-remote-sync"),
        });
        if (!cancelled) {
          logger.info("[uncensored] settings remote sync finished", { outcome });
        }
      } catch (error) {
        if (!cancelled) {
          logger.warn("[uncensored] settings remote sync failed", error);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    localUncensored,
    targetUncensored,
    targetProviderSettings,
    isRemote,
    remoteSessionId,
    workspacePath,
    workspaceIdentity,
  ]);
}
