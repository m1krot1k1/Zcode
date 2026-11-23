import { createServiceLogger } from "../logger/serviceLogger.js";
import type {
  UncensoredSettingsService,
  UncensoredSettingsStorePort,
  UncensoredSettingsWorkspace,
  UncensoredSettingsWrite,
} from "./contract.js";

/**
 * Сервис — тонкая обёртка над единственным владельцем состояния — файловым
 * хранилищем code intelligence. Он не держит копию настроек, не читает credential
 * store для статуса и не отдаёт секрет: композиционный корень (`node/features.ts`)
 * связывает его с `createUncensoredSettingsStore`, а host-only store отдельно
 * передаётся обработчику `uncensored/getConfig`.
 */

export interface UncensoredSettingsServiceOptions {
  store: UncensoredSettingsStorePort;
}

function summarizeSettingsError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Ошибки валидации называют поле, но не секрет. Остальные ошибки сворачиваем,
  // чтобы исключить случайное попадание credential material в лог.
  return message.startsWith("Uncensored") || message.startsWith("At most") ||
    message.startsWith("Duplicate") || message.startsWith("Each")
    ? message
    : "uncensored settings write failed";
}

export function createUncensoredSettingsService(
  options: UncensoredSettingsServiceOptions,
): UncensoredSettingsService {
  const logger = createServiceLogger("uncensored-settings");
  const { store } = options;
  return {
    getConfig: (workspace) => store.read(workspace),

    async updateConfig(workspace, write) {
      try {
        const status = await store.write(workspace, write);
        logger.info(undefined, "Uncensored settings updated", {
          providerCount: status.providers.length,
          modelCount: status.providers.reduce((total, provider) => total + provider.models.length, 0),
          configuredKeyCount: status.providers.filter((provider) => provider.apiKeyConfigured)
            .length,
        });
        return status;
      } catch (error) {
        logger.warn(undefined, "Uncensored settings update rejected", {
          reason: summarizeSettingsError(error),
        });
        throw error;
      }
    },
  };
}
