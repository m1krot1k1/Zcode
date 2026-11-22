import {
  getDefaultModelProviderEndpointPathForKind,
  normalizeModelProviderBaseUrlForKind,
  resolveModelProviderKindApiFormat,
  resolveModelProviderRuntimeBaseUrl,
  type ModelProviderEndpoints,
  type ModelProviderKind,
} from "../legacyModelProviderSerialized.js";

export function resolveLegacyRuntimeBaseUrlForKind(
  endpoints: ModelProviderEndpoints,
  defaultKind: ModelProviderKind,
): string {
  const rawEndpoint =
    defaultKind === "anthropic" ? endpoints.anthropic?.trim() : endpoints.openai?.trim();
  if (rawEndpoint) {
    return normalizeModelProviderBaseUrlForKind(rawEndpoint, defaultKind);
  }
  const fallbackEndpoint = endpoints.anthropic?.trim() || endpoints.openai?.trim() || "";
  return fallbackEndpoint
    ? normalizeModelProviderBaseUrlForKind(fallbackEndpoint, defaultKind)
    : "";
}

export function resolveRuntimeBaseUrlForStore(
  endpoints: ModelProviderEndpoints,
  defaultKind: ModelProviderKind,
): string {
  const runtimeBaseURL = resolveModelProviderRuntimeBaseUrl(
    {
      apiFormat: resolveModelProviderKindApiFormat(defaultKind),
      defaultKind,
      endpoints,
    },
    defaultKind,
  );
  if (runtimeBaseURL) {
    return runtimeBaseURL;
  }

  const baseURL = endpoints.baseURL?.trim();
  if (baseURL) {
    return normalizeModelProviderBaseUrlForKind(baseURL, defaultKind);
  }

  // 旧 store 可能还只有 endpoints.anthropic/openai。
  // runtime config 只能保存当前 kind 的 baseURL，这里按 defaultKind 取一条旧入口。
  return resolveLegacyRuntimeBaseUrlForKind(endpoints, defaultKind);
}

export function normalizeEndpoints(
  endpoints: ModelProviderEndpoints,
  defaultKind: ModelProviderKind,
): ModelProviderEndpoints {
  const runtimeBaseURL = resolveRuntimeBaseUrlForStore(endpoints, defaultKind);
  if (!runtimeBaseURL) {
    return {};
  }
  return {
    baseURL: runtimeBaseURL,
    paths: {
      [defaultKind]: getDefaultModelProviderEndpointPathForKind(defaultKind),
    },
  };
}
