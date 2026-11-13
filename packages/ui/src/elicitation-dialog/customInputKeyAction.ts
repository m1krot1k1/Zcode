import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import type { ElicitationCustomInputKeyAction } from "./contract.js";

export function resolveElicitationCustomInputKeyAction(event: {
  key: string;
  advanceKind?: "next" | "submit";
  ctrlKey?: boolean;
  metaKey?: boolean;
  compositionActive?: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
  isPlanApproval?: boolean;
  hasPreviousQuestion?: boolean;
}): ElicitationCustomInputKeyAction | null {
  // 自定义回答使用可自动换行的文本框；普通 AskUserQuestion 的 Enter 跟随当前题目的
  // 推进/提交语义，ExitPlanMode 属于计划审批边界，裸 Enter 才能直接提交。
  // 中文输入法用 Enter 确认候选时仍属于 composition，不能误提交给 agent。
  if (isImeComposingKeyEvent(event)) {
    return null;
  }

  // 原因：输入框也是末尾选项；只处理 Enter/Escape 会让上下键进入后无法离开。
  // 导航复用选项焦点索引，并放在 IME 检查后，避免组词选候选时跳走。
  if (event.key === "ArrowUp") return "previousOption";
  if (event.key === "ArrowDown") return "nextOption";

  if (event.key === "Enter") {
    if (event.ctrlKey || event.metaKey || event.isPlanApproval) {
      return "submit";
    }
    return event.advanceKind === "submit" ? "submit" : "advance";
  }

  if (event.key === "Escape") {
    if (!event.isPlanApproval && event.hasPreviousQuestion) {
      return "previous";
    }
    return "dismiss";
  }

  return null;
}
