/**
 * uncensored-settings 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type {
  UncensoredSettingsService,
  UncensoredSettingsStatus,
  UncensoredSettingsWorkspace,
  UncensoredSettingsWrite,
} from "./contract.js";

/**
 * Настройки — полный список провайдеров; порядок провайдеров и моделей = порядок fallback.
 * `apiKey` не входит в статус: чтение возвращает только `apiKeyConfigured` на провайдера.
 */
export async function exampleUncensoredSettings(
  contract: UncensoredSettingsService,
  workspace: UncensoredSettingsWorkspace,
  next: UncensoredSettingsWrite,
): Promise<UncensoredSettingsStatus> {
  return contract.updateConfig(workspace, { providers: next.providers });
}
