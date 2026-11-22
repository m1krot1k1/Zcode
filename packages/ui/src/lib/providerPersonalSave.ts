import type { IProviderSettingsService, ProviderSettingsView } from "@zcode/services";
import {
  getProviderFormApiKey,
  type ProviderSettingsFormProvider,
} from "@/lib/providerSettingsFormTypes.js";

/**
 * 一次保存是否改变了连接凭据或端点。
 * 只有 Key/Base URL 变化才需要重新发现模型；改名、启停等保存不应触发网络请求。
 */
export function hasProviderConnectionChange(
  previous: Pick<ProviderSettingsFormProvider, "config"> | undefined,
  next: Pick<ProviderSettingsFormProvider, "config">,
): boolean {
  const previousApiKey = previous ? getProviderFormApiKey(previous) : "";
  const nextApiKey = getProviderFormApiKey(next);
  const previousBaseUrl = previous?.config.api?.baseUrl?.trim() ?? "";
  const nextBaseUrl = next.config.api?.baseUrl?.trim() ?? "";
  return previousApiKey !== nextApiKey || previousBaseUrl !== nextBaseUrl;
}

/**
 * 保存设置页明确维护的稀疏 Personal Overlay。
 */
export async function persistPersonalProvider(params: {
  provider: ProviderSettingsFormProvider;
  providerSettingsService: Pick<IProviderSettingsService, "savePersonalProviderOverlay">;
}): Promise<ProviderSettingsView> {
  const {
    builtinModelIds: _builtinModelIds,
    personalModelIds: _modelIds,
    ...providerFields
  } = params.provider.personalConfig;
  return params.providerSettingsService.savePersonalProviderOverlay(
    params.provider.providerId,
    structuredClone(providerFields),
    params.provider.providerNameUpdate === undefined && params.provider.enabledUpdate === undefined
      ? undefined
      : {
          ...(params.provider.providerNameUpdate === undefined
            ? {}
            : { providerName: params.provider.providerNameUpdate }),
          ...(params.provider.enabledUpdate === undefined
            ? {}
            : { enabled: params.provider.enabledUpdate }),
        },
  );
}
