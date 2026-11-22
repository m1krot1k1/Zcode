import type { ReactNode } from "react";
import type { ConversationShareAccessMode } from "@zcode/shared";
import type {
  ConversationShareDisplayError,
  ConversationShareDisplayWarnings,
  ConversationShareProgressPhase,
} from "@/store/conversationShareSelectionStore.js";

/**
 * 分享确认 dock 的公开 props。
 * 拆自 ConversationShareConfirmationDock.tsx，字段与默认值保持原样，
 * 只是移动了定义位置，便于各展示片段共享同一份契约。
 */
export interface ConversationShareConfirmationDockProps {
  selectionEditing?: boolean;
  publishDisabled?: boolean;
  preflightChecking?: boolean;
  preflightContent?: ReactNode;

  selectedCount: number;
  totalCount: number;
  title?: string;
  accessMode?: ConversationShareAccessMode;
  progressLabel?: string;
  progressPhase?: ConversationShareProgressPhase;
  completedArtifacts?: number;
  totalArtifacts?: number;
  onCancel: () => void;
  onEditSelection: () => void;
  onConfirm: () => void;
  onTitleChange?: (title: string) => void;
  onAccessModeChange?: (accessMode: ConversationShareAccessMode) => void;
  disclosureAccepted?: boolean;
  onDisclosureAcceptedChange?: (accepted: boolean) => void;
  pending?: boolean;
  error?: ConversationShareDisplayError | null;
  warnings?: ConversationShareDisplayWarnings | null;
  /** 整轮取消选择，按 productTurnId 定位（turnOrdinal 只用于展示文案）。 */
  onDeselectTurn?: (productTurnId: string) => void;
  onDismissError?: () => void;
  onDismissWarnings?: () => void;
  onCopyRequestId?: () => void;
}
