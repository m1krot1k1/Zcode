import {
  BUILTIN_MODEL_PROVIDER_IDS,
  resolveBigModelApiOrigin,
  resolveRuntimeZCodeEnv,
} from "@zcode/shared";
import {
  normalizeModelProviderBaseUrlForKind,
  type ModelProviderKind,
} from "../legacyModelProviderSerialized.js";

const LEGACY_PRESET_GLM_PROVIDER_IDS = new Set<string>([
  "zai-api",
  BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
  BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
  "bigmodel-api",
  BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
]);

function isLegacyPresetGlmProviderId(providerId: string): boolean {
  return LEGACY_PRESET_GLM_PROVIDER_IDS.has(providerId);
}

const BIGMODEL_CODING_PLAN_ANTHROPIC_BASE_URL = "https://open.bigmodel.cn/api/anthropic";

export function normalizeBigModelCodingPlanAnthropicBaseUrlForEnv(
  baseUrl: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  const fallbackBaseUrl =
    resolveRuntimeZCodeEnv(env) === "production"
      ? BIGMODEL_CODING_PLAN_ANTHROPIC_BASE_URL
      : `${resolveBigModelApiOrigin(env)}/api/anthropic`;
  const normalizedBaseUrl = normalizeModelProviderBaseUrlForKind(
    baseUrl ?? fallbackBaseUrl,
    "anthropic",
  );
  if (resolveRuntimeZCodeEnv(env) === "production") {
    return normalizedBaseUrl || fallbackBaseUrl;
  }

  try {
    const parsed = new URL(normalizedBaseUrl || fallbackBaseUrl);
    const productionParsed = new URL(BIGMODEL_CODING_PLAN_ANTHROPIC_BASE_URL);
    // 旧配置可能保存生产域名；测试环境的 Team Plan Key 无法调用生产网关。
    return parsed.origin === productionParsed.origin
      ? fallbackBaseUrl
      : normalizedBaseUrl || fallbackBaseUrl;
  } catch {
    return fallbackBaseUrl;
  }
}

export function resolvePresetProviderKindFromRuntimeBaseUrl(
  providerId: string,
  baseURL: string | undefined,
): ModelProviderKind | undefined {
  if (!baseURL || !isLegacyPresetGlmProviderId(providerId)) {
    return undefined;
  }

  // 历史 config.json 可能保存成 kind=anthropic 但 baseURL 指向
  // /coding/paas/v4。ZAI/BigModel 这组内置 provider 的运行协议必须和已知
  // runtime URL 对齐，否则 agent 会用 Anthropic adapter 请求 OpenAI Chat endpoint。
  const normalized = baseURL.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  const path = resolveRuntimeBaseUrlPath(normalized);

  if (isBigModelCodingPlanLegacyOpenAiRuntime(providerId, normalized)) {
    // BigModel Coding Plan 的默认 runtime 已统一回 Anthropic。
    // 历史落盘的 /coding/paas/v4 不能继续把该内置 provider 推断成 OpenAI-compatible。
    return "anthropic";
  }
  if (path.includes("/coding/paas/v4")) {
    return "openai-compatible";
  }
  if (path.includes("/api/anthropic") || path.includes("/zcode-plan/anthropic")) {
    return "anthropic";
  }
  return undefined;
}

function resolveRuntimeBaseUrlPath(baseURL: string): string {
  try {
    return new URL(baseURL).pathname.toLowerCase();
  } catch {
    // 非 URL 的历史值继续按原始字符串做保守匹配。
    return baseURL.toLowerCase();
  }
}

export function isBigModelCodingPlanLegacyOpenAiRuntime(
  providerId: string,
  baseURL: string | undefined,
): boolean {
  if (providerId !== BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan) {
    return false;
  }
  const normalized = baseURL?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return false;
  }
  return resolveRuntimeBaseUrlPath(normalized).includes("/coding/paas/v4");
}
