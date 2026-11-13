import {
  BUILTIN_MODEL_PROVIDER_IDS,
  buildRuntimeZCodeApiUrl,
  type CodingPlanBillingDiscountConfig,
  type CodingPlanStaticProductsConfig,
  type CodingPlanStaticTeamProduct,
  type CodingPlanStaticTeamProductsConfig,
  type CodingPlanSubscriptionProviderId,
  type ForceUpdateConfig,
  type StartPlanPreviewConfig,
} from "@zcode/shared";
import { ZCODE_CLIENT_CONFIG_API_PREFIX } from "./constants.js";
import type { ZCodeClientConfigEnvelope } from "./types.js";

export function resolveCodingPlanClientConfigUrl(env: NodeJS.ProcessEnv): URL {
  return new URL(buildRuntimeZCodeApiUrl(env, ZCODE_CLIENT_CONFIG_API_PREFIX));
}

/** 旧服务端目录仍使用 builtin 键；只在配置边界转换，不能扩散成运行时身份别名。 */
function normalizeStaticProductProviderIds<T>(
  products: Partial<Record<CodingPlanSubscriptionProviderId, T[]>>,
): Partial<Record<CodingPlanSubscriptionProviderId, T[]>> {
  const normalized = { ...products };
  const raw = products as Record<string, T[]>;
  for (const [legacyId, currentId] of [
    ["builtin:bigmodel-coding-plan", BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan],
    ["builtin:zai-coding-plan", BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan],
  ] as const) {
    // 显式空数组表示关闭该目录；只有旧键不存在时才使用新键，不能用长度判断回退。
    if (Object.hasOwn(raw, legacyId)) normalized[currentId] = raw[legacyId];
    delete (normalized as Record<string, T[]>)[legacyId];
  }
  return normalized;
}

export function unwrapClientConfigProducts(
  payload: ZCodeClientConfigEnvelope,
): CodingPlanStaticProductsConfig {
  if (payload.code !== undefined && payload.code !== 0) {
    throw new Error(payload.msg?.trim() || "ZCode client config request failed");
  }
  const products = payload.data?.configs?.codingPlanStaticProducts;
  if (!products || typeof products !== "object") {
    throw new Error("ZCode client config missing Coding Plan products");
  }
  return normalizeStaticProductProviderIds(products);
}

export function unwrapClientConfigTeamProducts(
  payload: ZCodeClientConfigEnvelope,
): CodingPlanStaticTeamProductsConfig {
  if (payload.code !== undefined && payload.code !== 0) {
    throw new Error(payload.msg?.trim() || "ZCode client config request failed");
  }
  const products: unknown = payload.data?.configs?.codingPlanStaticTeamProducts;
  if (!products || typeof products !== "object") {
    throw new Error("ZCode client config missing Coding Plan team products");
  }
  for (const providerProducts of Object.values(products)) {
    if (
      !Array.isArray(providerProducts) ||
      !providerProducts.every(isCodingPlanStaticTeamProduct)
    ) {
      // 远端配置没有运行时类型保障；无效静态目录必须整体降级为读取失败，
      // 让 UI 继续使用实时 pricing 恢复团队订阅身份，不能在合并阶段抛错。
      throw new Error("ZCode client config has invalid Coding Plan team products");
    }
  }
  return normalizeStaticProductProviderIds(products as CodingPlanStaticTeamProductsConfig);
}

function isCodingPlanStaticTeamProduct(value: unknown): value is CodingPlanStaticTeamProduct {
  if (!value || typeof value !== "object") {
    return false;
  }
  const product = value as Record<string, unknown>;
  return (
    isNonEmptyString(product.productId) &&
    isNonEmptyString(product.productName) &&
    (product.tier === "LITE" || product.tier === "PRO" || product.tier === "MAX") &&
    (product.subscribeMode === "CONTINUOUS" || product.subscribeMode === "ONE_TIME") &&
    (product.subscribePeriod === "MONTHLY" ||
      product.subscribePeriod === "QUARTERLY" ||
      product.subscribePeriod === "YEARLY") &&
    isNonEmptyString(product.purchaseMethodName) &&
    product.priceCurrency === "CNY" &&
    isValidCardCopyConfig(product.equity) &&
    isValidCardCopyConfig(product.description)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidCardCopyConfig(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(isValidCardCopyConfigItem));
}

function isValidCardCopyConfigItem(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as Record<string, unknown>;
  return (
    isNonEmptyString(item.text) && (item.tooltip === undefined || typeof item.tooltip === "string")
  );
}

export function unwrapClientConfigBillingDiscount(
  payload: ZCodeClientConfigEnvelope,
): CodingPlanBillingDiscountConfig | undefined {
  if (payload.code !== undefined && payload.code !== 0) {
    throw new Error(payload.msg?.trim() || "ZCode client config request failed");
  }
  const configs = payload.data?.configs;
  if (!configs || !("codingPlanBillingDiscount" in configs)) {
    return undefined;
  }
  return configs.codingPlanBillingDiscount;
}

export function unwrapClientConfigStartPlanPreview(
  payload: ZCodeClientConfigEnvelope,
): StartPlanPreviewConfig | null {
  if (payload.code !== undefined && payload.code !== 0) {
    throw new Error(payload.msg?.trim() || "ZCode client config request failed");
  }
  const preview = payload.data?.configs?.startPlanPreview;
  if (!preview) {
    return null;
  }
  if (
    typeof preview.planId !== "string" ||
    typeof preview.name !== "string" ||
    !Array.isArray(preview.entitlements)
  ) {
    throw new Error("ZCode client config invalid Start Plan preview");
  }
  return {
    planId: preview.planId,
    name: preview.name,
    entitlements: preview.entitlements.filter(isValidStartPlanPreviewEntitlement),
  };
}

export function unwrapClientConfigForceUpdate(
  payload: ZCodeClientConfigEnvelope,
): ForceUpdateConfig | null {
  if (payload.code !== undefined && payload.code !== 0) {
    throw new Error(payload.msg?.trim() || "ZCode client config request failed");
  }

  const forceUpdate = payload.data?.configs?.forceUpdate;
  if (!forceUpdate) {
    return null;
  }

  const minimalVersion = forceUpdate.minimalVersion;
  if (typeof minimalVersion !== "string" || minimalVersion.trim() === "") {
    return null;
  }

  return { minimalVersion: minimalVersion.trim() };
}

function isValidStartPlanPreviewEntitlement(
  entitlement: StartPlanPreviewConfig["entitlements"][number],
): boolean {
  return (
    typeof entitlement?.grantUnits === "number" &&
    typeof entitlement.meter === "string" &&
    typeof entitlement.period === "string" &&
    typeof entitlement.showName === "string" &&
    typeof entitlement.unitType === "string"
  );
}
