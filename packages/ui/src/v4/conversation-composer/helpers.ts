import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import type { ChatComposerAttachment } from "@/lib/chatAttachments.js";
import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import type { ComposerRestoreRequest, ExternalTextInsertRequest } from "./types.js";

export function getComposerAttachmentTypeLabel(filename: string, mimeType: string): string {
  const leaf = filename.split(/[\\/]/u).at(-1) ?? filename;
  const dotIndex = leaf.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < leaf.length - 1) {
    return leaf.slice(dotIndex + 1).toUpperCase();
  }
  return (mimeType.split("/").at(-1) ?? mimeType).toUpperCase();
}
export function restorePersistedComposerDraftIntoInput({
  draft,
  inputApi,
  onEditorStateError,
}: {
  draft: Pick<V4ComposerDraft, "editorStateJson" | "mention" | "text">;
  inputApi: Pick<
    LexicalChatInputHandle,
    "getMarkdown" | "setEditorStateJson" | "setMention" | "setText"
  >;
  onEditorStateError?: (error: unknown) => void;
}): string {
  if (draft.editorStateJson) {
    try {
      inputApi.setEditorStateJson(draft.editorStateJson);
      return inputApi.getMarkdown();
    } catch (error) {
      onEditorStateError?.(error);
    }
  }
  if (draft.mention && draft.text.startsWith(draft.mention.markdown)) {
    // Workspace 插件详情会卸载聊天 Composer。结构化 mention 必须从共享草稿事实源恢复，
    // 不能只依赖一次性插入事件，否则重挂载时会退化成 canonical 普通文本。
    inputApi.setMention(draft.mention, draft.text.slice(draft.mention.markdown.length));
    return draft.text;
  }
  inputApi.setText(draft.text);
  return draft.text;
}
export function applyExternalTextInsertRequestToComposer({
  appliedRequestId,
  inputApi,
  request,
  requestFocus,
  scheduleDraftPersist,
  updateText,
}: {
  appliedRequestId: number | null;
  inputApi: Pick<
    LexicalChatInputHandle,
    | "getMarkdown"
    | "prependMentionIfMissing"
    | "setMention"
    | "setText"
    | "setTextWithPluginMentions"
  > | null;
  request: ExternalTextInsertRequest | null | undefined;
  requestFocus: () => void;
  scheduleDraftPersist: () => void;
  updateText: (text: string) => void;
}): number | null {
  if (!request || request.requestId === appliedRequestId) {
    return appliedRequestId;
  }
  if (!inputApi) {
    return appliedRequestId;
  }
  if (request.mode === "prepend-if-missing" && request.mention) {
    if (!inputApi.prependMentionIfMissing(request.mention)) {
      return request.requestId;
    }
    // Bug 原因：安装完成后若回放点击时保存的旧 prompt，会覆盖用户安装期间的编辑。
    // 节点级前置保留编辑器当前的 mention 与段落结构，再从编辑器读取 canonical 草稿。
    updateText(inputApi.getMarkdown());
    scheduleDraftPersist();
    requestFocus();
    return request.requestId;
  }
  if (request.mention && request.text.startsWith(request.mention.markdown)) {
    // 根因：商店试用以前只传 canonical 文本，Lexical 无法知道开头链接是结构化 Plugin mention。
    // request 同时携带 display-only 节点数据；发送与草稿事实源仍使用 request.text 原文。
    inputApi.setMention(request.mention, request.text.slice(request.mention.markdown.length));
  } else if (request.text.includes("](plugin://")) {
    // 推荐任务可在正文中组合多个插件；按原位置构造成真实提及节点。
    inputApi.setTextWithPluginMentions(request.text);
  } else {
    inputApi.setText(request.text);
  }
  updateText(request.text);
  scheduleDraftPersist();
  requestFocus();
  return request.requestId;
}
export function applyComposerRestoreRequestToComposer({
  appliedRequestId,
  currentSessionId,
  currentWorkspaceKey,
  hasDraftContent,
  inputApi,
  request,
  requestFocus,
  restoreSessionOwnedAttachments,
  reportRestore,
  restoreDraftConfig,
  scheduleDraftPersist,
  updateText,
}: {
  appliedRequestId: number | null;
  currentSessionId: string | null;
  currentWorkspaceKey: string;
  hasDraftContent: boolean;
  inputApi: Pick<LexicalChatInputHandle, "setText"> | null;
  request: ComposerRestoreRequest | null | undefined;
  requestFocus: () => void;
  restoreSessionOwnedAttachments: (
    attachments: readonly AttachmentRef[],
    previewUrls?: Readonly<Record<string, string>>,
  ) => boolean;
  reportRestore?: (reason: "applied" | "not-ready" | "conflict" | "mismatch") => void;
  restoreDraftConfig?: (config: NonNullable<ComposerRestoreRequest["config"]>) => void;
  scheduleDraftPersist: () => void;
  updateText: (text: string) => void;
}): number | null {
  if (!request || request.requestId === appliedRequestId) {
    return appliedRequestId;
  }
  if (request.sessionId !== currentSessionId || request.workspaceKey !== currentWorkspaceKey) {
    reportRestore?.("mismatch");
    return appliedRequestId;
  }
  if (!inputApi) {
    reportRestore?.("not-ready");
    return appliedRequestId;
  }
  if (
    hasDraftContent ||
    !restoreSessionOwnedAttachments(request.attachments, request.attachmentPreviewUrls)
  ) {
    // 删除已经落到权威队列，但 composer 在 ACK 返回前又有了草稿。静默 return 会留下空输入框。
    reportRestore?.("conflict");
    return appliedRequestId;
  }
  reportRestore?.("applied");
  inputApi.setText(request.text);
  updateText(request.text);
  if (request.config) restoreDraftConfig?.(request.config);
  scheduleDraftPersist();
  requestFocus();
  return request.requestId;
}
export function revokeUnappliedComposerPreviewUrls(
  urls: Readonly<Record<string, string>> | undefined,
): void {
  if (!urls) return;
  for (const url of Object.values(urls)) {
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }
}
export function arePromptHistoryEntriesEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}
export function formatAttachmentLineCount(
  attachment: ChatComposerAttachment,
  locale: string,
): string {
  const formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  return formatter.format(typeof attachment.lineCount === "number" ? attachment.lineCount : 0);
}
