/**
 * V4 composer 工具条。
 *
 * 展示件全部复用旧 chat-input-toolbar 的纯 props 组件（ModelConfigSelect /
 * ChatModeSwitchControl / ThoughtLevelCycleControl / ChatContextUsage），外观与旧
 * ChatInputToolbar 对齐；但状态编排是全新 v4 wiring，不复活旧 ChatInputToolbar 的
 * effect 链 / 旧协议写路径：
 * - 当前模型/档位来自 Composer；已运行会话的用量来自 snapshot.usage.contextWindow
 * - 模型、思考深度和模式只更新下一次 Submission 的 Composer 意图
 * - 模型静态事实来自目标 Host ModelSelectionView；workspace configOptions 只提供
 *   mode 等非模型 presentation
 *
 * 新任务和已有会话采用相同的 Composer 显示事实；prewarm 不补模型或档位。
 * 提交时由宿主（SessionPane）把冻结选择随 Submission 一起发送。
 * 三件套不能全部门控在 config!==null 上——草稿态会整体不渲染。
 *
 * Разбиение: контекстная часть (настройки провайдера, entitlements, usage) живёт в
 * composer-toolbar/useComposerContextUsage, модельная (выбор модели/плана/уровня и
 * горячие клавиши) — в composer-toolbar/useComposerModelControls, разметка — в
 * composer-toolbar/V4ComposerModelControlsView. Публичный API модуля и порядок
 * хуков не изменились.
 */
import { memo } from "react";
import { V4ComposerModelControlsView } from "@/v4/composer/composer-toolbar/V4ComposerModelControlsView.js";
import { useComposerContextUsage } from "@/v4/composer/composer-toolbar/useComposerContextUsage.js";
import { useComposerModelControls } from "@/v4/composer/composer-toolbar/useComposerModelControls.js";
import type { V4ComposerToolbarProps } from "@/v4/composer/composer-toolbar/types.js";

// 拆分件再导出（模式选择移居 V4ComposerModeControls，超行数拆分）：
// 既有消费方（ConversationComposer）继续从本模块入口 import，接口面不变。
export { V4ComposerModeSwitch } from "@/v4/composer/V4ComposerModeControls.js";
export { shouldShowModelProviderSettingsShortcut } from "@/v4/composer/composer-toolbar/modelProviderSettingsShortcut.js";
export type {
  ModelSelectionSource,
  V4ComposerToolbarProps,
} from "@/v4/composer/composer-toolbar/types.js";

/** 模型 / 思考深度 / context usage 簇（渲染在发送键左侧，与旧 UI 同位）。 */
function V4ComposerModelControlsImpl(props: V4ComposerToolbarProps) {
  const contextUsage = useComposerContextUsage(props);
  const modelControls = useComposerModelControls(props, contextUsage);
  return (
    <V4ComposerModelControlsView
      props={props}
      contextUsage={contextUsage}
      modelControls={modelControls}
    />
  );
}

export const V4ComposerModelControls = memo(V4ComposerModelControlsImpl);
