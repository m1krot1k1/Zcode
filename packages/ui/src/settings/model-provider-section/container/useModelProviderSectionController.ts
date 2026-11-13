import type { ModelProviderSectionProps } from "./types.js";
import { useModelProviderSectionActions } from "./useModelProviderSectionActions.js";
import { useModelProviderSectionCodingPlan } from "./useModelProviderSectionCodingPlan.js";
import { useModelProviderSectionEnvironment } from "./useModelProviderSectionEnvironment.js";
import { useModelProviderSectionNavigation } from "./useModelProviderSectionNavigation.js";

export function useModelProviderSectionController(props: ModelProviderSectionProps) {
  const environment = useModelProviderSectionEnvironment(props);
  const codingPlan = useModelProviderSectionCodingPlan({ environment });
  const navigation = useModelProviderSectionNavigation({ environment, codingPlan });
  const actions = useModelProviderSectionActions({ environment, codingPlan, navigation });
  // 首屏慢网时之前直接 return null，导致整块模型供应商页空白，
  // 已有的左侧分组 loading 和刷新按钮 loading 都没有机会渲染。
  // 这里改为始终先渲染布局壳子，再按分组展示 loading，避免用户误以为页面坏了。
  const presetLoading = environment.loading || environment.modelProvidersRefreshing;
  const customLoading = environment.loading || environment.modelProvidersRefreshing;

  return {
    environment,
    codingPlan,
    navigation,
    actions,
    presetLoading,
    customLoading,
  };
}

export type ModelProviderSectionController = ReturnType<typeof useModelProviderSectionController>;
