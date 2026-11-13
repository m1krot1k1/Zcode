// SessionPane 拆分：与 React 状态无关的纯助手、常量与跨 hook 共享的命令类型。
import type {
  ConversationComposerSendOptions,
  ConversationComposerSendResult,
} from "@/v4/ConversationComposer.js";
import type { ComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type {
  CommandAck,
  CommandEnvelope,
  CommandType,
  SessionErrorInfo,
} from "@zcode/shared/zcode-protocol-v4";
import type { HighspeedCardSnapshot, SessionCreateSource } from "@zcode/shared";
import type { ConversationPromptTelemetrySeed } from "@/v4/telemetry/conversationTelemetrySupervisor.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import { WORKSPACE_FILE_DRAG_MIME } from "@/lib/workspaceFileDrag.js";

export const MOBILE_PLAN_INTERACTION_RECONCILE_DELAY_MS = 500;

export function createSessionErrorKey(
  sessionId: string | null | undefined,
  error: SessionErrorInfo,
): string {
  return [
    sessionId?.trim() || "draft",
    error.code,
    error.at,
    error.message,
    error.traceId ?? "",
    error.detail ?? "",
  ].join(":");
}

export const EMPTY_SUBAGENT_PROJECTION: NonNullable<ConversationSnapshot["subagents"]> = {
  revision: 0,
  childSessionIds: [],
  running: [],
  endedTotal: 0,
};

export const MAX_CONVERSATION_FILE_CHANGES_CACHE_ENTRIES = 20;

export function toComposerUiError(
  sessionId: string | null | undefined,
  error: SessionErrorInfo,
): ZCodeUiError {
  return {
    code: error.code,
    message: error.message,
    ...(error.traceId ? { traceId: error.traceId } : {}),
    ...(error.detail ? { detail: error.detail } : {}),
    ...(error.underlyingErrorMessage
      ? { underlyingErrorMessage: error.underlyingErrorMessage }
      : {}),
    ...(error.underlyingErrorDetail ? { underlyingErrorDetail: error.underlyingErrorDetail } : {}),
    // V4 snapshot 已携带安全归因；此处透传归因字段，保证错误按安全归因聚类。
    ...(error.attribution ? { attribution: error.attribution } : {}),
    ...(sessionId ? { taskId: sessionId } : {}),
  };
}

export function submissionConfigFromCommand(
  type: CommandType,
  payload: Record<string, unknown>,
): ComposerSubmissionConfig | null {
  const candidate =
    type === "createSession"
      ? (payload.firstInput as Record<string, unknown> | undefined)
      : type === "sendText" || type === "sendGoalCommand"
        ? payload
        : undefined;
  if (!candidate?.modelSelection || !candidate.mode) return null;
  return {
    modelSelection: candidate.modelSelection as NonNullable<
      ComposerSubmissionConfig["modelSelection"]
    >,
    mode: candidate.mode as ComposerSubmissionConfig["mode"],
    planEnabled:
      typeof candidate.planEnabled === "boolean"
        ? candidate.planEnabled
        : candidate.mode === "plan",
  };
}

export function isConversationFileDrag(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types);
  return (
    types.includes("Files") ||
    types.includes(WORKSPACE_FILE_DRAG_MIME) ||
    Array.from(dataTransfer.items ?? []).some((item) => item.kind === "file")
  );
}

/**
 * Highspeed 发送起点的 pane 绑定（spec §9.2）：在触发发送的同步阶段冻结，prepare 返回时据此
 * 判断 pane 是否仍停在本轮发送所属的 Task / 草稿，决定是否在本 pane 呈现卡并登记激活。
 */
export interface HighspeedPaneOrigin {
  sessionId: string | null;
  /** 发送起点时的 pane 绑定代次；草稿首发据此判断 pane 是否离开过该草稿。 */
  paneBinding: number;
  draftId: string | null;
}

/** SessionPane 的 v4 命令派发签名，供各 hook 的 params 复用（与组件内实现逐字一致）。 */
export type SessionPaneDispatchCommand = (
  type: CommandType,
  payload: Record<string, unknown>,
  targetSessionId: string | null,
  baseRevision?: number,
  baseLogEpoch?: string,
  telemetrySeed?: ConversationPromptTelemetrySeed,
  highspeedCard?: HighspeedCardSnapshot,
  onEnvelopeCreated?: (envelope: CommandEnvelope) => void,
  creationProjectId?: string | null,
  sessionCreateSource?: SessionCreateSource,
  recentSubmissionOverride?: ComposerSubmissionConfig | null,
  creationTaskGroupId?: string | null,
  submittedDraftText?: string,
) => Promise<CommandAck>;

/** Composer 发送入口签名（handleSendText），供 sendTextRef 与插件 UI 桥接复用。 */
export type SessionPaneSendText = (
  text: string,
  options?: ConversationComposerSendOptions,
) => Promise<ConversationComposerSendResult>;
