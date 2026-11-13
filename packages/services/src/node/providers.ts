// Provider/account рантайм: request auth, config runtime, provisioning source и Registry.
import type { BuildContext, CoreServices } from "./bundles.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  createAccountProviderConfigSource,
  createCodingPlanFamilyAvailabilityResolver,
  resolveCurrentAccountAccess,
} from "../model-provider/accountProviderConnectionResolver.js";
import { bindAccountProviderInvalidation } from "../model-provider/accountProviderInvalidation.js";
import { createAccountProviderRequestAuthService } from "../model-provider/accountProviderRequestAuthService.js";
import { resolveAccountTeamPlanRuntimeMaterial } from "../model-provider/accountProviderTeamPlanRequestKey.js";
import { createAccountRequestAuthService } from "../model-provider/accountRequestAuthService.js";
import { readLegacyZCodeConfigProviders } from "../model-provider/legacyZCodeConfigProviderReader.js";
import { createProviderConfigRuntime } from "../model-provider/providerConfigRuntime.js";
import {
  createProviderProvisioningSource,
  resolveCredentialFilePath,
} from "../model-provider/providerProvisioningSource.js";
import { createProviderRuntimeFromConfigRuntime } from "../model-provider/providerRuntime.js";
import { createProviderSettingsConnectivityTester } from "../model-provider/providerSettingsConnectivity.js";
import { fetchZCodeBuiltinRemoteRelease } from "../model-provider/zcodeBuiltinRemoteConfig.js";
import { createOAuthProviderLogoutHandler } from "../oauth/oauthProviderLogout.js";
import { resolveClientConfigPlatform } from "../runtime-tools/clientPlatform.js";
import { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import {
  NodeModelSelectionConfigRepository,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
} from "@zcode/provider-node";
import {
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  ZCODE_VERSION,
  isStartPlanModelProviderId,
} from "@zcode/shared";
import { join } from "node:path";
import { getAppConfigDir as resolveAppConfigDir } from "../paths.js";

export function createProviderServices(args: BuildContext & CoreServices) {
  const {
    options,
    settingService,
    resolveCurrentZCodeEndpointOrigin,
    oauthLogout,
    openCodeCliProviderCatalogSource,
    apiClient,
    credentialService,
    oauthCredentialRepo,
    projectTokenClient,
    accountProviderCredentialService,
    accountProviderCredentialStore,
    readAccountProviderSettings,
    loadAccountIdentity,
  } = args;
  const accountRequestAuthService = createAccountRequestAuthService(
    createAccountProviderRequestAuthService({
      resolveCurrentAccountAccess: (access) =>
        resolveCurrentAccountAccess({
          access,
          readSettings: readAccountProviderSettings,
          loadAccountIdentity,
        }),
      loadOAuthTokenSet: (providerId) => oauthCredentialRepo.loadTokenSet(providerId),
      async loadIndividualPlanMaterial(providerId, family, rejectedProjectTokenFingerprint) {
        const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
        const accountIdentity = (await oauthCredentialRepo.loadUserProfile(oauthProviderId))?.id;
        if (!accountIdentity) return null;
        return accountProviderCredentialService.loadCodingPlanMaterial({
          providerId,
          family,
          accountIdentity,
          rejectedProjectTokenFingerprint,
        });
      },
      resolveTeamPlanMaterial: async (access, rejectedProjectTokenFingerprint) => {
        const accountIdentity = await loadAccountIdentity(access.family);
        if (!accountIdentity) return null;
        return resolveAccountTeamPlanRuntimeMaterial({
          apiClient,
          credentialService,
          access,
          accountIdentity,
          tokenClient: projectTokenClient,
          rejectedProjectTokenFingerprint,
        });
      },
    }),
  );
  const providerConfigLog = createServiceLogger("provider-config");
  const clientConfigPlatform = resolveClientConfigPlatform();
  const providerConfigRuntime = createProviderConfigRuntime({
    zcodeBuiltinFilePath: options.zcodeBuiltinProviderConfigFilePath,
    zcodeBuiltinEnvironment: {
      environmentConfigRoot: resolveAppConfigDir(),
      platform: clientConfigPlatform,
      appVersion: ZCODE_VERSION,
      resolveEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
      onRefreshResult: (event) => {
        if (event.result === "updated")
          providerConfigLog.info(undefined, "ZCode Built-in CDN 配置已更新", event);
        else providerConfigLog.debug(undefined, "ZCode Built-in 刷新检查", event);
      },
      fetchRelease: (endpointOrigin, signal) =>
        fetchZCodeBuiltinRemoteRelease({
          apiClient,
          endpointOrigin,
          signal,
          appVersion: ZCODE_VERSION,
          platform: clientConfigPlatform,
        }),
    },
    onZCodeBuiltinRefreshError: (error) => {
      providerConfigLog.warn(undefined, "ZCode Built-in Config 远端刷新失败", {
        error,
      });
    },
    onPersonalConfigRecovery: (event) => {
      providerConfigLog.warn(
        undefined,
        "Personal Provider Config 加载失败，已保留磁盘状态并以内存空配置降级",
        {
          error: event.error,
        },
      );
    },
    onPersonalConfigPollingError: (error) => {
      // 轮询错误只在进入失败状态时回调一次；下一轮仍会自行重试，避免持续故障刷盘。
      providerConfigLog.warn(undefined, "Personal Provider Config 轮询暂时失败，将继续重试", {
        error,
      });
    },
    // 已发布 config.json 保存的是 ZCode 用户配置；清理第三方 ACP 不能移除这条升级路径。
    // Repository 仅在新 Personal 配置不存在时导入，并保留旧文件以便回滚。
    readLegacyProviders: () => readLegacyZCodeConfigProviders(),
  });
  const accountProviderConfigSource = createAccountProviderConfigSource({
    configSource: providerConfigRuntime.configService,
    readSettings: readAccountProviderSettings,
    async loadCodingPlanApiKey(providerId, family, accountIdentity, forceRefresh) {
      if (isStartPlanModelProviderId(providerId)) return null;
      return accountProviderCredentialService.loadCodingPlanApiKey({
        providerId,
        family,
        accountIdentity,
        forceRefresh,
      });
    },
    loadAccountIdentity,
    resolveFamilyAvailability: createCodingPlanFamilyAvailabilityResolver({
      apiClient,
      credentialService,
    }),
  });
  const accountProviderRuntimeLog = createServiceLogger("account-provider-runtime");
  const modelSelectionConfiguredDefaultSource = new NodeModelSelectionConfigRepository({
    personalRepository: providerConfigRuntime.personalRepository,
  });
  const providerProvisioningSource = createProviderProvisioningSource({
    personalRepository: providerConfigRuntime.personalRepository,
    settingService,
    credentialFilePath: resolveCredentialFilePath(resolveAppConfigDir()),
    personalConfigFilePath: join(resolveAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
  });
  const providerProvisioningDisposers = [
    providerConfigRuntime.configService.onDidChange((reason) => {
      // 每个 Window Host 都会轮询同一文件；只把本进程成功提交的 updated
      // 作为同步触发，避免其它 Host 的 poll-changed 把一次保存重复计入多个代际。
      if (reason === "personal:updated") {
        options.onProviderProvisioningSourceChanged?.("personal-config");
      }
    }),
    settingService.onDidUpdate((event) => {
      if (
        event.keys.includes("providerFamilyDomain") ||
        event.keys.includes("providerFamilyConnectionSelections")
      ) {
        options.onProviderProvisioningSourceChanged?.("account-settings");
      }
    }),
  ];
  const disposeAccountProviderInvalidation = bindAccountProviderInvalidation({
    onDidUpdateSetting: (listener) => settingService.onDidUpdate(listener),
    refresh: (reason) => accountProviderConfigSource.refresh(reason),
  });
  const accountProviderRefreshErrorDispose = accountProviderConfigSource.onDidRefreshError(
    (event) => {
      accountProviderRuntimeLog.warn(undefined, "account provider source refresh failed", {
        error: event.error,
        reasons: event.reasons,
      });
    },
  );
  let providerConnectivityAgentService:
    | Pick<IZCodeAgentService, "testModelConnectivity">
    | undefined;
  const providerRuntime = createProviderRuntimeFromConfigRuntime({
    configRuntime: providerConfigRuntime,
    accountSource: accountProviderConfigSource,
    ...(openCodeCliProviderCatalogSource
      ? { runtimeProviderSource: openCodeCliProviderCatalogSource }
      : {}),
    modelSelectionConfiguredDefaultSource,
    disposeModelSelectionConfiguredDefaultSource: () =>
      modelSelectionConfiguredDefaultSource.dispose(),
    testConnectivity: createProviderSettingsConnectivityTester({
      testModelConnectivity: async (input) => {
        if (!providerConnectivityAgentService) {
          throw new Error("Agent Service 尚未完成模型连通性测试装配");
        }
        return providerConnectivityAgentService.testModelConnectivity(input);
      },
    }),
    disposeAccountSource: () => {
      disposeAccountProviderInvalidation();
      accountProviderRefreshErrorDispose();
      accountProviderConfigSource.dispose();
    },
  });
  oauthLogout.current = createOAuthProviderLogoutHandler({
    accountProviderCredentialStore,
    refreshAccountProviders: (reason: string) => accountProviderConfigSource.refresh(reason),
  });
  const setProviderConnectivityAgentService = (
    service: Pick<IZCodeAgentService, "testModelConnectivity">,
  ): void => {
    providerConnectivityAgentService = service;
  };

  return {
    accountRequestAuthService,
    providerConfigRuntime,
    providerRuntime,
    accountProviderConfigSource,
    providerProvisioningSource,
    providerProvisioningDisposers,
    setProviderConnectivityAgentService,
  };
}
