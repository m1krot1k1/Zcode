// Контракты фаз сборки Local Host: каждый модуль возвращает свой bundle, а следующие
// фазы получают его целиком. Так зависимости остаются однонаправленными и без циклов.
import type { ServiceCollection } from "../collection.js";
import type { IOpenCodeAcpRuntime } from "../opencode-acp-runtime/contract.js";
import type { OpenCodeCliProviderCatalogSource } from "../model-provider/providerRuntime.js";
import type { IBotsService } from "../bots/bots.js";
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { OffPeakTaskService } from "../session/offPeakTaskService.js";
import type { createObservableSettingService } from "../setting/observableSettingService.js";
import type { createSettingServiceWithMigrations } from "../setting/settingService.js";
import type { createOAuthProviderLogoutHandler } from "../oauth/oauthProviderLogout.js";
import type { CreateLocalServicesOptions } from "./createLocalServicesOptions.js";
import type { CoreServices } from "./core.js";
import type { createProviderServices } from "./providers.js";
import type { createFeatureServices } from "./features.js";
import type { createCuaServices } from "./cua-services.js";
import type { createProjectServices } from "./projects.js";
import type { createAgentServices } from "./agent.js";
import type { createRuntimeServices } from "./runtime.js";

/** Общие зависимости, которые создаёт сам вход до запуска фаз. */
export interface BuildContext {
  options: CreateLocalServicesOptions;
  /** Authority режим Host: desktop-attached-remote отрезает часть локальных сценариев. */
  isDesktopAttachedRemote: boolean;
  /** Локальные Setting с миграциями; null когда Host передал свой Setting. */
  localSettings: ReturnType<typeof createSettingServiceWithMigrations> | null;
  settingService: ReturnType<typeof createObservableSettingService>;
  openCodeAcpRuntime: IOpenCodeAcpRuntime | undefined;
  openCodeCliProviderCatalogSource: OpenCodeCliProviderCatalogSource | undefined;
  desktopContextPromptEnabled: boolean | undefined;
  resolveCurrentZCodeEndpointOrigin: () => Promise<string>;
  /** Инвалидация plugin UI аккаунтов: пишет feature-фаза, читает credential-фаза. */
  pluginUiInvalidation: { current?: (() => void) | undefined };
  /** Logout-обработчик OAuth: создаётся в provider-фазе, читается credential/bots. */
  oauthLogout: { current: ReturnType<typeof createOAuthProviderLogoutHandler> | null };
  /** Поздняя привязка ServiceCollection для ленивых мостов агента (bots). */
  serviceRegistryRef: { current?: ServiceCollection | undefined };
  /** Поздняя привязка Agent Service для ленивых feature-мостов. */
  agentServiceRef: { current?: IZCodeAgentService | undefined };
  /** Off-Peak singleton создаётся при регистрации, agent читает его лениво. */
  offPeakTask: { current?: OffPeakTaskService | undefined };
  /** Ленивое чтение bots из коллекции внутри мостов агента. */
  resolveBotsService: () => IBotsService | undefined;
}

export type { CoreServices };
export type ProviderServices = ReturnType<typeof createProviderServices>;
export type FeatureServices = ReturnType<typeof createFeatureServices>;
export type CuaServices = ReturnType<typeof createCuaServices>;
export type ProjectServices = ReturnType<typeof createProjectServices>;
export type AgentServices = ReturnType<typeof createAgentServices>;
export type RuntimeServices = ReturnType<typeof createRuntimeServices>;

/** Полный набор зависимостей, который получает фаза регистрации сервисов. */
export type LocalServicesBundle = BuildContext &
  CoreServices &
  ProviderServices &
  FeatureServices &
  CuaServices &
  ProjectServices &
  AgentServices &
  RuntimeServices;
