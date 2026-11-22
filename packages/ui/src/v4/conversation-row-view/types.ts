import type {
  AttachmentRef,
  CommandAck,
  ConversationRow,
  ConversationRowTarget,
} from "@zcode/shared/zcode-protocol-v4";
import type { AssistantCodeCommentCard } from "@/lib/assistantCodeComment.js";
import type { AssistantPreviewCard } from "@/lib/assistantPreviewCards.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";

export type UserInputEditHandler = (
  target: ConversationRowTarget,
  newText: string,
  attachments?: readonly AttachmentRef[],
  workspaceMode?: "preserve" | "rewind",
  conversationQuotes?: import("@zcode/shared").ConversationSelectionText[],
) => Promise<CommandAck | boolean | void> | CommandAck | boolean | void;

export type AssistantMessageFeedback = "like" | "dislike";

export type AssistantFeedbackHandler = (
  target: ConversationRowTarget,
  feedback: AssistantMessageFeedback | null,
) => Promise<boolean | void> | boolean | void;

export interface EditWorkspaceRewindAvailability {
  enabled: boolean;
  reason: "available" | "noFiles" | "reverted" | "running" | "unavailable";
}

export interface ConversationRowViewProps {
  row: ConversationRow;
  /** 渲染上下文（theme/codePreviewSettings/workspacePath）；宿主保证引用稳定。 */
  context: ConversationRowRenderContext;
  /** 完成态 assistant 行的 fork 入口（forkAssistant command）。 */
  onFork?: (target: ConversationRowTarget) => void;
  /** assistant entity 反馈 CAS；UI 先乐观更新，命令失败时回滚。 */
  onFeedbackChange?: AssistantFeedbackHandler;
  /** 协议兼容：上层仍可提供 retryTurn capability，但产品 UI 不渲染普通重试入口。 */
  onRetry?: (target: ConversationRowTarget) => void;
  /** user 行的 edit 入口（editUserQuery command，用行内编辑文本替换该轮）。 */
  onEdit?: UserInputEditHandler;
  editWorkspaceRewindAvailability?: EditWorkspaceRewindAvailability;
  /** 嵌套在工具 Group 内时去掉 Reasoning 内容的重复左导线与缩进。 */
  reasoningContentVariant?: "default" | "nested";
  /** renderer-only 提交状态；不写入协议 row，也不冒充已 drain 的历史事实。 */
  userInputStatus?: string;
  /**
   * 一轮对用户是一个回复：非最后一段 text 不显示任何
   * action（复制/fork 都没有），入口只在轮尾段。
   */
  hideAssistantActions?: boolean;
  /** TurnGroup 需要把轮级 action 延后到文件 summary 后渲染。 */
  deferAssistantActions?: boolean;
  /** 轮尾段的复制内容 = 整轮全部 text 段合并（不是只复制最后一段）。 */
  assistantCopyText?: string;
  /** Assistant Preview Cards 只由 TurnGroup 为轮尾 terminal assistant text 计算后下发。 */
  assistantPreviewCards?: AssistantPreviewCard[];
  /** 仅当前 renderer 观察到 running -> complete 时下发的一次性自动打开身份。 */
  assistantPreviewCardsAutoOpenKey?: string;
  /** Assistant code-comment cards 只由 TurnGroup 为轮尾终态 assistant text 计算后下发。 */
  assistantCodeCommentCards?: AssistantCodeCommentCard[];
  /** 由 TurnGroup 统一裁决整轮正文是否隐藏 code-comment 协议原文。 */
  assistantCodeCommentProjectionEnabled?: boolean;
}
