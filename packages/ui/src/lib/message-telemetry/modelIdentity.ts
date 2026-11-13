import type { ZCodeProvider } from "@zcode/shared";
import {
  CUSTOM_SUPPLIER_KEY_PREFIX,
  GHOST_SUPPLIER_KEY_PREFIX,
  NATIVE_SUPPLIER_KEY_PREFIX,
  decodeCustomModelValue,
} from "@zcode/shared";

export function resolvePromptTelemetryModelProvider(params: {
  modelName?: string | null;
  provider?: ZCodeProvider;
  selectedSupplierKey?: string | null;
}): string {
  const { modelName, provider, selectedSupplierKey } = params;
  // Bugfix: send_btn 的 model_name 已按 UI model value 修正，但 selectedSupplierKey
  // 偶尔仍停留在上一个 supplier，导致出现 `uuid/model` 搭配 `glm` provider。
  // 当 model value 自身带 provider 维度时，provider 必须与同一份 UI selection 对齐。
  const providerFromModelName = readProviderIdFromModelValue(modelName);
  if (providerFromModelName) {
    return providerFromModelName;
  }

  if (!selectedSupplierKey) {
    return provider ?? "";
  }

  if (selectedSupplierKey.startsWith(CUSTOM_SUPPLIER_KEY_PREFIX)) {
    const customProviderId = selectedSupplierKey.slice(CUSTOM_SUPPLIER_KEY_PREFIX.length).trim();
    return customProviderId || provider || "";
  }

  // ghost supplier 代表尚未解析到稳定 custom provider 的临时隔离态，provider 维度统一回退到当前 ZCode Agent provider。
  if (selectedSupplierKey.startsWith(GHOST_SUPPLIER_KEY_PREFIX)) {
    return provider ?? "";
  }

  if (selectedSupplierKey.startsWith(NATIVE_SUPPLIER_KEY_PREFIX)) {
    const nativeProvider = selectedSupplierKey.slice(NATIVE_SUPPLIER_KEY_PREFIX.length).trim();
    return nativeProvider || provider || "";
  }

  return provider ?? "";
}

export function readProviderIdFromModelValue(modelValue: string | null | undefined): string | null {
  const normalizedModelValue = modelValue?.trim() ?? "";
  if (!normalizedModelValue) {
    return null;
  }

  const customModel = decodeCustomModelValue(normalizedModelValue);
  if (customModel?.providerId?.trim()) {
    return customModel.providerId.trim();
  }

  const separatorIndex = normalizedModelValue.indexOf("/");
  if (separatorIndex <= 0) {
    return null;
  }

  const providerId = normalizedModelValue.slice(0, separatorIndex).trim();
  return providerId || null;
}

export function resolveProviderHostname(baseURL: string | null | undefined): string {
  const normalizedBaseURL = baseURL?.trim() ?? "";
  if (!normalizedBaseURL) {
    return "";
  }

  try {
    return new URL(normalizedBaseURL).hostname;
  } catch {
    return "";
  }
}
