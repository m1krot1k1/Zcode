import type { ZCodeElicitationQuestion, ZCodeElicitationRequest } from "@zcode/shared";
import type { InteractionAutoResolution } from "@zcode/shared/zcode-protocol-v4";
import type { ElicitationFormDraft } from "@/store/zcodeSessionStoreTypes.js";

export interface ElicitationDialogProps {
  request: ZCodeElicitationRequest;
  autoResolution?: InteractionAutoResolution;
  onRespond: (
    requestId: string,
    action: "accept" | "decline" | "cancel",
    content?: Record<string, unknown>,
  ) => void;
  /** 普通 AskUserQuestion 首次暂停来源；失败返回 false 后允许下一次操作重试。 */
  onFirstInteraction?: (
    source: ElicitationAutoResolutionSnoozeSource,
  ) => boolean | void | Promise<boolean | void>;
  initialFormDraft?: ElicitationFormDraft;
  onFormDraftChange?: (requestId: string, draft: ElicitationFormDraft) => void;
}

export type ElicitationAutoResolutionSnoozeSource =
  | "panelHover"
  | "answer"
  | "navigation"
  | "countdown";

export const PLAN_APPROVAL_APPROVE_VALUE = "approve";

export interface NormalizedElicitationQuestion extends ZCodeElicitationQuestion {
  key: string;
}

export interface AnswerDraft {
  selectedValues: string[];
  customAnswer: string;
}

export type DraftState = Record<string, AnswerDraft>;

export type ElicitationCustomInputKeyAction =
  | "advance"
  | "submit"
  | "previous"
  | "dismiss"
  | "previousOption"
  | "nextOption";
