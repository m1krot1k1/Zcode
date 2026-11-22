// 分享确认 dock 的纯展示模型：阶段顺序、文案 id 与进度百分比。
// 拆自 ConversationShareConfirmationDock.tsx，判定顺序与文案选择保持原样。
import type { ConversationShareAccessMode } from "@zcode/shared";
import type { ConversationShareProgressPhase } from "@/store/conversationShareSelectionStore.js";

export const NOOP = () => {};

export const SHARE_PROGRESS_PHASES: readonly ConversationShareProgressPhase[] = [
  "collecting",
  "uploading",
  "checking",
];

export const SHARE_PHASE_LABEL_IDS: Record<ConversationShareProgressPhase, string> = {
  collecting: "conversationShare.phase.collecting",
  uploading: "conversationShare.phase.uploading",
  checking: "conversationShare.phase.checking",
};

export function resolveShareProgressPercent(phase: ConversationShareProgressPhase): number {
  return phase === "collecting" ? 20 : phase === "uploading" ? 58 : 82;
}

export function resolveShareFailedProgressMessageId(phase: ConversationShareProgressPhase): string {
  return phase === "collecting"
    ? "conversationShare.progress.collectingFailed"
    : phase === "uploading"
      ? "conversationShare.progress.uploadingFailed"
      : "conversationShare.progress.checkingFailed";
}

export function resolveShareProgressPhaseIndex(phase: ConversationShareProgressPhase): number {
  return SHARE_PROGRESS_PHASES.indexOf(phase);
}

export function resolveShareAccessSummaryMessageId(
  accessMode: ConversationShareAccessMode,
): string {
  return accessMode === "public_readonly"
    ? "conversationShare.permission.linkViewerSummary"
    : accessMode === "public_importable"
      ? "conversationShare.permission.linkEditorSummary"
      : "conversationShare.permission.privateSummary";
}

export function resolveShareFooterMetaMessageId(error: boolean, pending: boolean): string {
  return error
    ? "conversationShare.publish.failedFooter"
    : pending
      ? "conversationShare.publish.footerMeta"
      : "conversationShare.partial.selectionCount";
}
