import { useCallback, useState } from "react";
import {
  resolveV4ComposerConfigPickerState,
  type V4ComposerConfigPicker,
} from "@/v4/composer/configPickerState.js";

/**
 * 三个配置 picker（模型 / 思考深度 / 模式）的互斥打开状态。
 *
 * 固定 key 的 SessionPane 会跨 task/draft 复用 composer，旧 picker owner 因此跟着
 * 实例进入新 scope：提交新 scope portal 前同步归零，避免菜单闪现一帧；旧 Radix
 * layer 随后到达的 close 事件由 scope guard 丢弃。
 */
export function useComposerConfigPicker(configPickerScopeKey: string) {
  const [configPickerState, setConfigPickerState] = useState<{
    scopeKey: string;
    activePicker: V4ComposerConfigPicker | null;
  }>(() => ({
    scopeKey: configPickerScopeKey,
    activePicker: null,
  }));
  if (configPickerState.scopeKey !== configPickerScopeKey) {
    setConfigPickerState({
      scopeKey: configPickerScopeKey,
      activePicker: null,
    });
  }
  const activeConfigPicker =
    configPickerState.scopeKey === configPickerScopeKey ? configPickerState.activePicker : null;
  const handleConfigPickerOpenChange = useCallback(
    (picker: V4ComposerConfigPicker, open: boolean) => {
      // composer 内容为导航 rail 恢复 pointer-events 后，三个 Radix modal
      // picker 的独立 open 状态会在同一次 pointerdown 中竞争，旧 layer 无法可靠 dismiss。
      // 关闭回调可能晚于兄弟 picker 的打开回调，只允许它清理自己，避免误关接管者。
      setConfigPickerState((current) => {
        if (current.scopeKey !== configPickerScopeKey) {
          return current;
        }
        return {
          scopeKey: current.scopeKey,
          activePicker: resolveV4ComposerConfigPickerState(current.activePicker, picker, open),
        };
      });
    },
    [configPickerScopeKey],
  );

  return { activeConfigPicker, handleConfigPickerOpenChange };
}
