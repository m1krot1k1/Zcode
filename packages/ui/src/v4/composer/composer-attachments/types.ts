/**
 * 附件子 hook 的公共类型与常量：对外 API、调用参数、上传目标与队列条目。
 * 从 useComposerAttachments.ts 拆出，仅为让每个文件低于 max-lines 上限；
 * 字段、可选性与导出面保持与原文件一致。
 */
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import type { IPromptAttachmentTransferService } from "./contract.ts";
import type { ChatComposerPasteEvent } from "@/LexicalChatInput.js";
import type { ChatComposerAttachment } from "@/lib/chatAttachments.js";
import type { AttachmentPutFn } from "@/v4/composer/attachmentUpload.js";
import type { ComposerAttachmentUploadItem } from "@/store/composerAttachmentUploadStore.js";

export const COMPOSER_ATTACHMENT_UPLOAD_CONCURRENCY = 2;
export const COMPOSER_ATTACHMENT_AUTO_RETRY_DELAY_MS = 500;
export const COMPOSER_ATTACHMENT_COMPLETE_VISIBLE_MS = 300;
/**
 * 换代重传的兜底上限。dev 实测同一 workspace 可达 runtimeGeneration=4（3 次换代），
 * 取 5 留余量；它只防 Helper 反复崩溃时的无限重传，正常使用不该触达。
 */
export const COMPOSER_ATTACHMENT_REBUILD_RETRY_LIMIT = 5;
export const EMPTY_COMPOSER_ATTACHMENTS: ComposerAttachmentUploadItem[] = [];
export const REMOTE_ATTACHMENT_NOT_STAGED_ERROR_CODE = "remoteAttachmentNotStaged";

export type { ComposerAttachmentUploadItem } from "@/store/composerAttachmentUploadStore.js";

export interface UploadTarget {
  sessionId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  attachmentPut: AttachmentPutFn;
  transferService: IPromptAttachmentTransferService;
}

export interface UploadQueueEntry {
  scopeKey: string;
  attachmentId: string;
}

/** scope 级原子更新：入参与回值都是该 scope 的完整附件列表。 */
export type ComposerAttachmentScopeUpdate = (
  current: ComposerAttachmentUploadItem[],
) => ComposerAttachmentUploadItem[];

/** 单条目原子更新：只替换 id 命中的条目。 */
export type ComposerAttachmentItemUpdate = (
  item: ComposerAttachmentUploadItem,
) => ComposerAttachmentUploadItem;

export interface ComposerAttachmentsApi {
  attachments: ComposerAttachmentUploadItem[];
  attachmentError: string | null;
  hasAttachments: boolean;
  hasUnreadyAttachments: boolean;
  composerDragKind: "attachment" | "workspace" | null;
  isDraggingOverComposer: boolean;
  attachmentInputRef: React.RefObject<HTMLInputElement | null>;
  openAttachmentPicker: () => void;
  handleAttachmentInputChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  handlePaste: (event: ChatComposerPasteEvent) => void;
  handleDragOverComposer: (event: React.DragEvent<HTMLElement>) => void;
  handleDragLeaveComposer: (event: React.DragEvent<HTMLElement>) => void;
  handleDropComposer: (event: React.DragEvent<HTMLElement>) => void;
  handleWhiteboardMentionSelected: (boardId: string) => Promise<void>;
  /** 程序化加入文件（插件 UI 图片上下文等）；返回被接受的附件 id，超出上限的部分被丢弃。 */
  addAttachmentFiles: (files: File[]) => string[];
  removeAttachment: (id: string) => void;
  retryAttachment: (id: string) => void;
  /** 发送成功只清冻结的附件 id；不传表示用户主动清空整个附件区。 */
  clearAttachments: (attachmentIds?: readonly string[]) => void;
  /** 草稿跨工作区时重新准备附件，不能继承旧 session 的上传引用。 */
  restoreDraftAttachments: (attachments: readonly ChatComposerAttachment[]) => void;
  /** 把已由 session 接管的 queue refs 原样恢复为 ready chips；不触发 upload/adopt。 */
  restoreSessionOwnedAttachments: (
    attachments: readonly AttachmentRef[],
    previewUrls?: Readonly<Record<string, string>>,
  ) => boolean;
  /** 只返回已 ready ref；任一附件未就绪时返回 null 作 submit 二次门禁。 */
  prepareForSend: () => Promise<AttachmentRef[] | null>;
  /** sendText accepted 后才移交远端暂存内容，发送失败时仍由草稿持有。 */
  adoptSentAttachments: (attachmentIds: readonly string[]) => Promise<void>;
  setAttachmentError: (message: string | null) => void;
}

export interface UseComposerAttachmentsOptions {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  scopeId: string;
  attachmentSessionId?: string | null;
  attachmentPut: AttachmentPutFn;
  onRuntimeRestart?: (listener: () => void) => () => void;
  /**
   * 承载 transport 暴露 runtime 存活态时优先用它，替代 onRuntimeRestart。
   * unavailable 在 workspace-dispose 当场到达，把作废与唤醒拆到两个真实时点。
   */
  onRuntimeLifecycle?: (listener: (state: "available" | "unavailable") => void) => () => void;
  disabled?: boolean;
  /**
   * 是否消费全局 add-to-chat 事件（whiteboard 引用）。
   * 语义与 useWebElementContexts 等一致：由调用方传 `listenAddToChatEvents && !disabled`
   * （SessionPane 以 focused 区分聚焦 composer）。SidePane forceMount 常驻多个同
   * workspace 的 SessionPane，若不门控，一次白板引用会被所有 composer 同时
   * preventDefault 并各自注入附件，用户看不见的后台草稿被静默塞入画板内容。
   */
  listenAddToChatEvents?: boolean;
}
