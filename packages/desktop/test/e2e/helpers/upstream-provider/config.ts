import { encodeCustomModelValue } from "@zcode/shared";

import { resolveUpstreamModels } from "../upstream-recorded-models.js";

export const UPSTREAM_PROVIDER_ID = process.env.E2E_PROVIDER_ID?.trim() || "e2e-upstream";
export const UPSTREAM_PROVIDER_NAV_KEY = `custom:${UPSTREAM_PROVIDER_ID}`;
export const UPSTREAM_ALTERNATE_PROVIDER_ID =
  process.env.E2E_PROVIDER_ALTERNATE_PROVIDER_ID?.trim() || "e2e-upstream-alt";
export const UPSTREAM_ALTERNATE_PROVIDER_NAME =
  process.env.E2E_PROVIDER_ALTERNATE_PROVIDER_NAME?.trim() || "Upstream E2E Alt";
// 模型名由 E2E_PROVIDER_MODEL / E2E_PROVIDER_SECONDARY_MODEL 控制，未设置时使用回放夹具的录制模型。
export const { model: UPSTREAM_MODEL, secondaryModel: UPSTREAM_SECONDARY_MODEL } =
  resolveUpstreamModels();
export const UPSTREAM_ALTERNATE_MODEL =
  process.env.E2E_PROVIDER_ALTERNATE_MODEL?.trim() || UPSTREAM_SECONDARY_MODEL;
export const UPSTREAM_PROVIDER_NAME = process.env.E2E_PROVIDER_NAME?.trim() || "Upstream";
export const UPSTREAM_THOUGHT_LEVEL = readUpstreamThoughtLevel();
export const UPSTREAM_SECONDARY_THOUGHT_LEVEL =
  process.env.E2E_PROVIDER_SECONDARY_THOUGHT_LEVEL?.trim() || "max";

const E2E_PROVIDER_REPLAY_API_KEY = "e2e-fixture-key";

const UPSTREAM_THOUGHT_LEVEL_LABELS_BY_VALUE: Record<string, string[]> = {
  high: ["High", "高"],
  disabled: ["Disabled", "关闭"],
  enabled: ["Enabled", "开启"],
  max: ["Max", "最高"],
};
export const UPSTREAM_MODEL_VALUES = getUpstreamModelValues(UPSTREAM_MODEL);

function readUpstreamThoughtLevel() {
  if (process.env.E2E_PROVIDER_THOUGHT_LEVEL !== undefined) {
    return process.env.E2E_PROVIDER_THOUGHT_LEVEL.trim();
  }
  return process.env.E2E_PROVIDER_PRESET?.trim() === "glmhighspeed" ? "" : "high";
}

export function getUpstreamApiKey() {
  if (process.env.E2E_PROVIDER_CAPTURE_MODE !== "capture") {
    return E2E_PROVIDER_REPLAY_API_KEY;
  }

  const apiKey = process.env.E2E_PROVIDER_API_KEY?.trim();
  if (!apiKey || apiKey === "xxx") {
    // 修复原因：只有 capture 模式会访问真实 上游；采集 fixture 时不能用
    // placeholder，否则后续 replay 会固化一份失败响应。真实录制可切到 GLM highspeed
    // preset，但测试 helper 仍复用这组历史 env 名以保持旧 case 兼容。
    throw new Error("E2E_PROVIDER_HTTP_MODE=capture requires E2E_PROVIDER_API_KEY");
  }
  return apiKey;
}

function getUpstreamModelValues(modelId: string) {
  return getUpstreamProviderModelValues(modelId);
}

export function getUpstreamProviderModelValues(
  modelId: string,
  {
    includePlainModelFallback = true,
    providerId = UPSTREAM_PROVIDER_ID,
  }: {
    includePlainModelFallback?: boolean;
    providerId?: string;
  } = {},
) {
  const values = [`${providerId}/${modelId}`, encodeCustomModelValue(providerId, modelId)];
  if (includePlainModelFallback) {
    values.push(modelId);
  }
  return values;
}

export function getUpstreamThoughtLevelLabels(thoughtLevel: string) {
  return UPSTREAM_THOUGHT_LEVEL_LABELS_BY_VALUE[thoughtLevel] ?? [];
}
