import type { ModelSelectionView } from "@zcode/provider";
import type { OffPeakClientConfig } from "../codingPlanSubscription.js";
import type { ZCodeClientConfigEnvelope } from "./types.js";

/**
 * 闲时任务灰度判据（纯函数供单测）：远端只提供曝光开关，模型成员和事实
 * 来自 ZCode Built-in Provider / Model Config。
 * mock 模式（ZCODE_OFFPEAK_MOCK=1）只替代产品曝光与套餐状态；模型候选仍来自 Registry。
 */
export function resolveOffPeakClientConfig(
  payload: ZCodeClientConfigEnvelope,
  env: NodeJS.ProcessEnv,
  modelSelectionView: ModelSelectionView = EMPTY_OFF_PEAK_MODEL_SELECTION_VIEW,
): OffPeakClientConfig {
  const hasModels = modelSelectionView.providers.some((provider) => provider.models.length > 0);
  if (env["ZCODE_OFFPEAK_MOCK"] === "1") {
    return {
      enabled: hasModels,
      modelSelectionView,
      // ZCODE_OFFPEAK_MOCK_NO_PLAN=1 演示「非 coding plan 锁定」态；缺省视为已订阅。
      codingPlanActive: env["ZCODE_OFFPEAK_MOCK_NO_PLAN"] !== "1",
    };
  }
  const raw = payload.data?.configs?.offPeak;
  return {
    enabled: raw?.enable_offpeak_task === true && hasModels,
    modelSelectionView,
  };
}

const EMPTY_OFF_PEAK_MODEL_SELECTION_VIEW: ModelSelectionView = Object.freeze({
  revision: 0,
  providers: Object.freeze([]),
});
