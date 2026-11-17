import type {
  CacheControlCapability,
  CacheControlProviderFamily,
  ResolveCacheCapabilityInput,
} from "./contract.js";

export const DEFAULT_MAX_CACHE_BREAKPOINTS = 4;
export const DEFAULT_CACHE_QUANTIZATION_STRIDE = 4;

export function isOpenRouterEndpoint(baseURL?: string, providerId?: string): boolean {
  const normalizedProvider = providerId?.trim().toLowerCase() ?? "";
  if (normalizedProvider === "openrouter" || normalizedProvider.startsWith("openrouter-")) {
    return true;
  }
  const normalizedUrl = baseURL?.trim().toLowerCase() ?? "";
  return normalizedUrl.includes("openrouter.ai");
}

function isDashScopeCompatibleEndpoint(baseURL?: string, providerId?: string): boolean {
  const normalizedProvider = providerId?.trim().toLowerCase() ?? "";
  if (normalizedProvider.includes("dashscope") || normalizedProvider.includes("alibaba")) {
    return true;
  }
  const normalizedUrl = baseURL?.trim().toLowerCase() ?? "";
  return normalizedUrl.includes("dashscope.aliyuncs.com") || normalizedUrl.includes("dashscope-intl.aliyuncs.com");
}

function disabledCapability(
  family: Extract<CacheControlProviderFamily, "automatic-prefix" | "unsupported">,
  isOpenRouter: boolean,
): CacheControlCapability {
  return {
    family,
    isOpenRouter,
    maxBreakpoints: 0,
    quantizationStrideMessages: DEFAULT_CACHE_QUANTIZATION_STRIDE,
    supportsExplicitBreakpoints: false,
    supportsToolSchemaBreakpoint: false,
  };
}

function enabledCapability(
  family: Exclude<CacheControlProviderFamily, "automatic-prefix" | "unsupported">,
  options: {
    readonly isOpenRouter: boolean;
    readonly supportsToolSchemaBreakpoint: boolean;
  },
): CacheControlCapability {
  return {
    family,
    isOpenRouter: options.isOpenRouter,
    maxBreakpoints: DEFAULT_MAX_CACHE_BREAKPOINTS,
    quantizationStrideMessages: DEFAULT_CACHE_QUANTIZATION_STRIDE,
    supportsExplicitBreakpoints: true,
    supportsToolSchemaBreakpoint: options.supportsToolSchemaBreakpoint,
  };
}

export function resolveProviderCacheCapability(
  input: ResolveCacheCapabilityInput,
): CacheControlCapability {
  const providerKind = input.providerKind?.trim().toLowerCase();
  const modelId = input.modelId?.trim().toLowerCase() ?? "";
  const openRouter = isOpenRouterEndpoint(input.baseURL, input.providerId);

  if (providerKind === "anthropic") {
    return enabledCapability("anthropic-native", {
      isOpenRouter: openRouter,
      supportsToolSchemaBreakpoint: true,
    });
  }

  if (providerKind === "openai") {
    return disabledCapability("automatic-prefix", false);
  }

  if (providerKind !== undefined && providerKind !== "openai-compatible") {
    return disabledCapability("unsupported", false);
  }

  if (openRouter) {
    if (modelId.startsWith("anthropic/") || modelId.includes("claude-")) {
      return enabledCapability("openrouter-anthropic", {
        isOpenRouter: true,
        supportsToolSchemaBreakpoint: true,
      });
    }
    if (modelId.startsWith("google/") || modelId.includes("gemini-")) {
      return enabledCapability("openrouter-gemini", {
        isOpenRouter: true,
        supportsToolSchemaBreakpoint: true,
      });
    }
    if (modelId.startsWith("qwen/") || modelId.startsWith("qwen-")) {
      return enabledCapability("openrouter-qwen", {
        isOpenRouter: true,
        supportsToolSchemaBreakpoint: true,
      });
    }
    if (modelId.startsWith("deepseek/") || modelId.startsWith("deepseek-")) {
      return enabledCapability("openrouter-deepseek", {
        isOpenRouter: true,
        supportsToolSchemaBreakpoint: false,
      });
    }
    if (modelId.startsWith("z-ai/glm") || modelId.startsWith("thudm/glm") || modelId.startsWith("glm-")) {
      return enabledCapability("openrouter-glm", {
        isOpenRouter: true,
        supportsToolSchemaBreakpoint: false,
      });
    }
    if (modelId.startsWith("openai/")) {
      return disabledCapability("automatic-prefix", true);
    }
    return disabledCapability("unsupported", true);
  }

  if (isDashScopeCompatibleEndpoint(input.baseURL, input.providerId) && modelId.includes("qwen")) {
    return enabledCapability("openrouter-qwen", {
      isOpenRouter: false,
      supportsToolSchemaBreakpoint: false,
    });
  }

  return disabledCapability("unsupported", false);
}
