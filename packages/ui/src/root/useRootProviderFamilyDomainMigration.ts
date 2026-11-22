import { useEffect, useState } from "react";
import type { IServiceAccessor } from "./contract.ts";
import { ensureProviderFamilyDomainMigration } from "@/lib/providerFamilyDomainMigration.js";
import { logger } from "@/logger.js";

/**
 * 启动期的 provider family domain 迁移。
 *
 * 迁移完成标志是 provider 启动门的输入之一：只有迁移走完（含失败后的继续启动）才允许
 * 解析 provider 启动态，因此完成标志与该 effect 必须由同一个 owner 维护。
 */
export function useRootProviderFamilyDomainMigration({
  services,
  refreshAppSettings,
  refreshProviderState,
}: {
  services: IServiceAccessor;
  refreshAppSettings: () => Promise<void>;
  refreshProviderState: () => Promise<void>;
}): boolean {
  const [providerFamilyDomainMigrationComplete, setProviderFamilyDomainMigrationComplete] =
    useState(false);

  useEffect(() => {
    let disposed = false;

    void (async () => {
      try {
        await ensureProviderFamilyDomainMigration(services);
      } catch (error) {
        logger.warn("[Root] provider family domain 迁移失败，继续启动", {
          error,
        });
      } finally {
        if (!disposed) {
          setProviderFamilyDomainMigrationComplete(true);
          try {
            await refreshAppSettings();
            await refreshProviderState();
          } catch (refreshError) {
            logger.warn("[Root] provider family domain 迁移后刷新状态失败", {
              error: refreshError,
            });
          }
        }
      }
    })();

    return () => {
      disposed = true;
    };
  }, [refreshAppSettings, refreshProviderState, services]);

  return providerFamilyDomainMigrationComplete;
}
