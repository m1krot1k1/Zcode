/**
 * ui-model-provider-detail 标准调用示例：详情只消费 Settings View 的形状。
 */
import type { ProviderSettingsView } from "./contract.js";

export function exampleUiModelProviderDetail(view: ProviderSettingsView): ProviderSettingsView {
  return view;
}
