import { ServiceChannels } from "@zcode/shared";
import type {
  ZCodeUncensoredModelEntry,
  ZCodeUncensoredSettingsStatus,
  ZCodeUncensoredSettingsWrite,
} from "@zcode/shared";
import type {
  UncensoredSettingsStore,
  UncensoredSettingsWorkspace,
} from "../code-intelligence/contract.js";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * uncensored-settings 对外契约。
 *
 * 状态里没有 секрет: API-ключ write-only, наружу отдаётся только `apiKeyConfigured`.
 * Запись всегда полная (список провайдеров + их модели), частичного сохранения нет.
 */

export type UncensoredModelEntry = ZCodeUncensoredModelEntry;
export type UncensoredSettingsStatus = ZCodeUncensoredSettingsStatus;
export type UncensoredSettingsWrite = ZCodeUncensoredSettingsWrite;

export interface UncensoredChatInput {
  providerId: string;
  modelId: string;
  text: string;
}

export type UncensoredChatResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/**
 * Одно определение workspace-идентичности и store-порта живёт в контракте
 * code intelligence, рядом с хранилищем; здесь только реэкспорт, чтобы
 * у UI/сервиса не появилась вторая копия формы.
 */
export type { UncensoredSettingsWorkspace };
export type UncensoredSettingsStorePort = UncensoredSettingsStore;

export interface UncensoredSettingsService {
  /**
   * Текущий статус workspace без секрета.
   * `apiKeyConfigured` берётся из флага хранилища; ключ для отображения не читается.
   * Идемпотентно; событий не отправляет; ждёт чтения файла.
   */
  getConfig(workspace: UncensoredSettingsWorkspace): Promise<UncensoredSettingsStatus>;

  /**
   * Полная замена записи workspace. Пустой `providers` сбрасывает конфигурацию.
   * Пустой `apiKey` у провайдера сохраняет текущий секрет, `null` удаляет его.
   * Бросает ошибку валидации до записи; частичного сохранения нет; событий не отправляет.
   */
  updateConfig(
    workspace: UncensoredSettingsWorkspace,
    write: UncensoredSettingsWrite,
  ): Promise<UncensoredSettingsStatus>;

  /**
   * Один прямой запрос к выбранной uncensored-модели. Ключ читает только Host и
   * никогда не возвращает его в результате. Ответ — только текст или категория ошибки.
   */
  sendMessage(
    workspace: UncensoredSettingsWorkspace,
    input: UncensoredChatInput,
  ): Promise<UncensoredChatResult>;
}

export const IUncensoredSettingsService = createServiceDescriptor<UncensoredSettingsService>(
  ServiceChannels.UncensoredSettings,
);
