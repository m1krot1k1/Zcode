import { ModelProviderSectionView } from "./model-provider-section/container/ModelProviderSectionView.js";
import { useModelProviderSectionController } from "./model-provider-section/container/useModelProviderSectionController.js";
import type { ModelProviderSectionProps } from "./model-provider-section/container/types.js";

export {
  fuzzyMatch,
  handleEndpointSuggestionPopoverOpenAutoFocus,
  resolveEndpointSuggestionOpenRequest,
} from "./model-provider-section/utils.js";

export {
  resolveCodingPlanProviderSyncAttemptKey,
  resolveModelProviderSideSelectionKey,
  shouldRetryUnchangedCodingPlanProviderSync,
} from "./model-provider-section/container/helpers.js";

/**
 * 模型 Provider 设置只由 SettingsPage 注入 Local Host；这里不接收 workspaceIdentity，
 * 防止远程 workspace 误将 Provider Settings 的读写路由到远端 Environment。
 */
export function ModelProviderSection(props: ModelProviderSectionProps = {}) {
  const controller = useModelProviderSectionController(props);
  return <ModelProviderSectionView controller={controller} />;
}
