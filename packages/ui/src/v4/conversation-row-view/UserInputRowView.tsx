import { ConversationUserInputBubble } from "@/v4/ConversationUserInputBubble.js";
import { expandTopicInputMessages } from "@/v4/topicInputMessages.js";
import {
  type ComponentProps,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Clock, FileClockIcon, PencilIcon } from "lucide-react";
import { parseAutomationRunId } from "@zcode/shared";
import {
  TID_V4_EDIT,
  TID_V4_EDIT_CANCEL,
  TID_V4_EDIT_INPUT,
  TID_V4_EDIT_SUBMIT,
  TID_V4_EDIT_REWIND_WORKSPACE,
  TID_V4_ROW_ATTACHMENTS,
  testId,
} from "@zcode/shared/test-ids";
import type {
  AttachmentRef,
  UserInputRow,
  V4ConversationFileRewindPreviewResult,
} from "@zcode/shared/zcode-protocol-v4";
import { MessageAction, MessageActions } from "@/components/ai-elements/message.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PluginUiModelContextChip, formatPluginDisplayName } from "@/plugin-ui/index.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { ChatPromptEditor } from "@/prompt-editor/ChatPromptEditor.js";
import { type ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { CodeCommentAttachmentChip } from "@/v4/composer/CodeCommentAttachmentChip.js";
import {
  countComposerPromptContexts,
  parseComposerPromptContexts,
  serializeComposerPromptContexts,
} from "@/v4/composer/composerPromptContexts.js";
import { WebElementContextAttachmentChip } from "@/v4/composer/WebElementContextAttachmentChip.js";
import { ConversationSelectionReferenceChip } from "@/v4/composer/ConversationSelectionReferenceChip.js";
import { PptxElementReferenceChip } from "@/v4/composer/PptxElementReferenceChip.js";
import { useOpenPptxElementReference } from "@/v4/composer/useOpenPptxElementReference.js";
import { ConversationFileRewindDialog } from "@/v4/ConversationFileRewindDialog.js";
import { BotGroupSourceLabel } from "@/v4/BotGroupSourceLabel.js";
import { splitUserInputEpilogue } from "@/v4/ConversationUserInputEpilogue.js";
import { parseConversationShareContext } from "@/lib/conversationShareContext.js";
import { CopyRowAction } from "@/v4/conversation-row-view/CopyRowAction.js";
import { RowShell } from "@/v4/conversation-row-view/RowShell.js";
import { UserInputAttachmentList } from "@/v4/conversation-row-view/UserInputAttachmentList.js";
import type {
  EditWorkspaceRewindAvailability,
  UserInputEditHandler,
} from "@/v4/conversation-row-view/types.js";

const SingleUserInputRowView = memo(function SingleUserInputRowView({
  row,
  context,
  onEdit,
  editWorkspaceRewindAvailability,
  status,
}: {
  row: UserInputRow;
  context: ConversationRowRenderContext;
  onEdit?: UserInputEditHandler;
  editWorkspaceRewindAvailability?: EditWorkspaceRewindAvailability;
  status?: string;
}) {
  const { intl } = useZCodeIntl();
  // 引擎尾注折叠：正文只到 epilogueStart，
  // 之后的引擎文本折进气泡底部的披露。提示词上下文解析也只看正文——尾注里没有用户引用。
  const { body: bodyText, epilogue } = splitUserInputEpilogue(row.text, row.epilogueStart);
  const parsedPrompt = useMemo(
    () => ({
      ...parseComposerPromptContexts(bodyText, {
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      }),
      ...(row.conversationQuotes ? { conversationSelections: row.conversationQuotes } : {}),
    }),
    [context.workspaceIdentity, context.workspacePath, bodyText, row.conversationQuotes],
  );
  // 只用于把历史消息里的 share URL 尾块从可见正文里剥掉。
  // 该块已不再产出（见 ConversationComposer 的 promptText 注释）；这里保留解析，是为了让
  // 接线修复到本次删除之间发出的消息不至于把裸 markup 当正文显示出来。
  const parsedShareContext = useMemo(
    () => parseConversationShareContext(parsedPrompt.visibleContent),
    [parsedPrompt.visibleContent],
  );
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [draft, setDraft] = useState(row.text);
  const [editAttachments, setEditAttachments] = useState<AttachmentRef[]>(() => [
    ...(row.attachments ?? []),
  ]);
  // 编辑态删除附件后，持久 FilePart 列表仍保留全部附件；序号数组把可见列表
  // 映射回原 index，避免 video 预览等按 attachmentIndex 的读取指错分块。
  const [editAttachmentIndices, setEditAttachmentIndices] = useState<number[]>(() =>
    (row.attachments ?? []).map((_, index) => index),
  );
  const [editPromptContexts, setEditPromptContexts] = useState(() => parsedPrompt);
  const [conflictPreview, setConflictPreview] =
    useState<V4ConversationFileRewindPreviewResult | null>(null);
  const [conflictOpen, setConflictOpen] = useState(false);
  const inputApiRef = useRef<LexicalChatInputHandle | null>(null);
  const editContextCount = countComposerPromptContexts(editPromptContexts);
  const canSubmit = draft.trim().length > 0 || editAttachments.length > 0 || editContextCount > 0;
  const submitLabel = intl.formatMessage({ id: "chat.send" });
  const cancelLabel = intl.formatMessage({ id: "common.cancel" });
  const rewindWorkspaceLabel = intl.formatMessage({
    id: "chat.edit.resetConversationAndFiles",
  });
  const rewindWorkspaceTooltipTitle = intl.formatMessage({
    id: "chat.edit.resetConversationAndFiles.tooltip",
  });
  const rewindWorkspaceTooltipDescription =
    editWorkspaceRewindAvailability?.reason === "available"
      ? undefined
      : intl.formatMessage({
          id: `chat.edit.resetConversationAndFiles.${editWorkspaceRewindAvailability?.reason ?? "noFiles"}`,
        });
  const visibleText = parsedShareContext.visibleContent;
  const codeCommentContexts = parsedPrompt.codeComments;
  const webElementContexts = parsedPrompt.webElements;
  const pptxElementReferences = parsedPrompt.pptxElements;
  const conversationSelections = parsedPrompt.conversationSelections;
  const hasAttachments = (row.attachments?.length ?? 0) > 0;
  const hasMediaAttachments =
    row.attachments?.some(
      (attachment) => attachment.mime.startsWith("image/") || attachment.mime.startsWith("video/"),
    ) ?? false;
  const hasFileAttachments =
    row.attachments?.some(
      (attachment) =>
        !attachment.mime.startsWith("image/") && !attachment.mime.startsWith("video/"),
    ) ?? false;
  const hasVisibleText = visibleText.trim().length > 0;
  const pluginUiContexts = parsedPrompt.pluginUiContexts;
  // nudge 轮整条都是引擎文本：正文为空但气泡仍要画，里面只有那一枚披露。
  const hasBubble = hasVisibleText || epilogue !== undefined;
  const hasContextReferences =
    codeCommentContexts.length > 0 ||
    webElementContexts.length > 0 ||
    pptxElementReferences.length > 0 ||
    conversationSelections.length > 0 ||
    pluginUiContexts.length > 0;
  const hasAttachmentArea = hasAttachments || hasContextReferences;
  const hasAttachmentPills =
    hasFileAttachments ||
    codeCommentContexts.length > 0 ||
    webElementContexts.length > 0 ||
    pptxElementReferences.length > 0 ||
    (!row.botGroupSource && conversationSelections.length > 0);
  // Bug 根因：旧逻辑只接受 schedule runId，导致用户点击「立即运行」产生的 manual run
  // 没有来源标识。两种合法 automation runId 都应展示；普通会话输入仍因解析失败而不展示。
  const isScheduledAutomationPrompt = parseAutomationRunId(row.sourceCommandId ?? "") !== null;
  const openPptxElementReference = useOpenPptxElementReference({
    workspacePath: context.workspacePath,
    workspaceIdentity: context.workspaceIdentity,
    remoteSessionId: context.workspaceRemoteSessionId,
    onOpenCodeViewer: context.onOpenCodeViewer,
  });

  useEffect(() => {
    if (!editing) {
      setDraft(parsedShareContext.visibleContent);
      setEditAttachments([...(row.attachments ?? [])]);
      setEditAttachmentIndices((row.attachments ?? []).map((_, index) => index));
      setEditPromptContexts(parsedPrompt);
      return;
    }
    const focusEditor = () => inputApiRef.current?.focus();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(focusEditor);
      return;
    }
    focusEditor();
  }, [editing, parsedPrompt, row.attachments]);

  useEffect(() => {
    if (!onEdit) {
      setEditing(false);
      setSubmitting(false);
    }
  }, [onEdit]);

  const handleOpenEdit = useCallback(() => {
    // v4 迁移时把 user query 编辑误接成“直接读取主 composer 提交”，
    // 主 composer 为空时点击只会 warn。这里恢复旧行内编辑态。
    setDraft(parsedShareContext.visibleContent);
    setEditAttachments([...(row.attachments ?? [])]);
    setEditAttachmentIndices((row.attachments ?? []).map((_, index) => index));
    setEditPromptContexts(parsedPrompt);
    setEditing(true);
  }, [parsedPrompt, parsedShareContext, row.attachments]);

  const handleCancelEdit = useCallback(() => {
    setDraft(parsedShareContext.visibleContent);
    setEditAttachments([...(row.attachments ?? [])]);
    setEditAttachmentIndices((row.attachments ?? []).map((_, index) => index));
    setEditPromptContexts(parsedPrompt);
    setEditing(false);
  }, [parsedPrompt, parsedShareContext, row.attachments]);

  const handleRemoveEditAttachment = useCallback((index: number) => {
    setEditAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index));
    setEditAttachmentIndices((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }, []);

  const handleSubmitEdit = useCallback(
    async (nextText: string, workspaceMode: "preserve" | "rewind" = "preserve") => {
      if (!onEdit) return;
      if (!nextText.trim() && editAttachments.length === 0 && editContextCount === 0) return;
      setSubmitting(true);
      try {
        const result = await onEdit(
          { rowId: row.rowId, entityId: row.entityId! },
          serializeComposerPromptContexts(nextText, {
            ...editPromptContexts,
            conversationSelections: [],
          }),
          // 省略空数组会让 CLI 按 attachments 缺省语义恢复 canonical 原附件，
          // 因此 edit 必须始终提交当前完整列表，显式 [] 才能表达“删除全部”。
          editAttachments,
          workspaceMode,
          ...(parsedPrompt.conversationSelections.length || row.conversationQuotes
            ? [[...editPromptContexts.conversationSelections]]
            : []),
        );
        if (
          typeof result === "object" &&
          result !== null &&
          result.result?.type === "editUserQuery" &&
          result.result.disposition === "blocked" &&
          result.result.preview
        ) {
          setConflictPreview(result.result.preview);
          setConflictOpen(true);
          return;
        }
        if (result !== false) {
          setEditing(false);
          setConflictOpen(false);
        }
      } finally {
        setSubmitting(false);
      }
    },
    [
      editAttachments,
      editContextCount,
      editPromptContexts,
      onEdit,
      row.entityId,
      row.rowId,
      row.conversationQuotes,
      parsedPrompt.conversationSelections.length,
    ],
  );
  const rewindWorkspaceDisabled = submitting || editWorkspaceRewindAvailability?.enabled !== true;
  const rewindWorkspaceButton = (
    <Button
      type="button"
      variant="outline"
      size="icon-md"
      disabled={rewindWorkspaceDisabled}
      data-testid={testId(TID_V4_EDIT_REWIND_WORKSPACE, String(row.rowId))}
      aria-label={rewindWorkspaceLabel}
      onClick={() => {
        void handleSubmitEdit(draft, "rewind");
      }}
    >
      <FileClockIcon className="size-4" />
    </Button>
  );

  if (editing) {
    return (
      <RowShell rowId={row.rowId} className="flex flex-col items-end">
        <ChatPromptEditor
          workspacePath={context.workspacePath}
          taskId={context.sessionId ?? null}
          initialValue={parsedPrompt.visibleContent}
          submitting={submitting}
          submitDisabled={!canSubmit || submitting}
          allowSubmitWhenEmpty={editAttachments.length > 0 || editContextCount > 0}
          submitLabel={submitLabel}
          cancelLabel={cancelLabel}
          showMentionButton
          showSlashButton
          enableWorkspaceFileDrop
          topContent={
            editAttachments.length > 0 || editContextCount > 0 ? (
              <div className="flex max-w-full flex-col items-start gap-2">
                {editAttachments.length > 0 ? (
                  <UserInputAttachmentList
                    attachments={editAttachments}
                    attachmentIndices={editAttachmentIndices}
                    entityId={row.entityId}
                    rowId={row.rowId}
                    onRemove={handleRemoveEditAttachment}
                    sessionId={context.sessionId ?? undefined}
                    readAttachment={context.readAttachment}
                    readAttachmentRange={context.readAttachmentRange}
                  />
                ) : null}
                {editContextCount > 0 ? (
                  <div
                    className="flex max-w-full flex-wrap items-center gap-2"
                    data-v4-user-edit-context-attachments-row="true"
                  >
                    <CodeCommentAttachmentChip
                      comments={editPromptContexts.codeComments}
                      onRemove={(comment) =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          codeComments: current.codeComments.filter((item) => item !== comment),
                        }))
                      }
                      onRemoveAll={() =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          codeComments: [],
                        }))
                      }
                    />
                    <WebElementContextAttachmentChip
                      contexts={editPromptContexts.webElements}
                      onRemove={(id) =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          webElements: current.webElements.filter((item) => item.id !== id),
                        }))
                      }
                      onRemoveAll={() =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          webElements: [],
                        }))
                      }
                    />
                    <PptxElementReferenceChip
                      references={editPromptContexts.pptxElements}
                      onOpen={context.onOpenCodeViewer ? openPptxElementReference : undefined}
                      onRemove={(id) =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          pptxElements: current.pptxElements.filter((item) => item.id !== id),
                        }))
                      }
                      onRemoveAll={() =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          pptxElements: [],
                        }))
                      }
                    />
                    <ConversationSelectionReferenceChip
                      references={editPromptContexts.conversationSelections}
                      onRemove={(id) =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          conversationSelections: current.conversationSelections.filter(
                            (item) => !("id" in item) || item.id !== id,
                          ),
                        }))
                      }
                      onRemoveAll={() =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          conversationSelections: [],
                        }))
                      }
                    />
                  </div>
                ) : null}
              </div>
            ) : null
          }
          inputApiRef={inputApiRef}
          inputTestId={testId(TID_V4_EDIT_INPUT, String(row.rowId))}
          submitTestId={testId(TID_V4_EDIT_SUBMIT, String(row.rowId))}
          cancelTestId={testId(TID_V4_EDIT_CANCEL, String(row.rowId))}
          betweenCancelAndSubmitAction={
            <ControlHintTooltip
              title={rewindWorkspaceTooltipTitle}
              description={rewindWorkspaceTooltipDescription}
            >
              {rewindWorkspaceDisabled ? (
                // Button disabled 会应用 pointer-events-none，TooltipTrigger 直接落在
                // 按钮上时收不到 hover。禁用态用外层 span 承接 hover，实际按钮仍保持 disabled。
                <span className="inline-flex" data-disabled-tooltip-trigger="true">
                  {rewindWorkspaceButton}
                </span>
              ) : (
                rewindWorkspaceButton
              )}
            </ControlHintTooltip>
          }
          className="w-full max-w-xl"
          shellClassName="min-h-32"
          onChange={setDraft}
          onSubmit={(nextText) => {
            void handleSubmitEdit(nextText, "preserve");
          }}
          onCancel={handleCancelEdit}
        />
        <ConversationFileRewindDialog
          variant="editConflict"
          open={conflictOpen}
          onOpenChange={setConflictOpen}
          preview={conflictPreview}
          previewLoading={false}
          applying={submitting}
          error={null}
          onApply={() => {}}
          onConversationOnly={() => {
            void handleSubmitEdit(draft, "preserve");
          }}
        />
      </RowShell>
    );
  }

  return (
    <RowShell rowId={row.rowId} className="group/user-row flex flex-col items-end">
      {isScheduledAutomationPrompt ? (
        <div
          data-v4-user-input-automation-origin="schedule"
          className="mb-1 flex max-w-xl items-center gap-1 text-ui-sm text-foreground-subtle"
        >
          <Clock data-cron-task-icon="true" aria-hidden="true" className="size-3.5 shrink-0" />
          <span>{intl.formatMessage({ id: "chat.message.sentByScheduledTask" })}</span>
        </div>
      ) : null}
      {row.botGroupSource ? (
        // 群来源原先插在材料与正文之间，割裂同一输入；统一放在材料之前。
        <div data-v4-user-input-source="true" className="mb-2 flex min-w-0 max-w-full">
          <BotGroupSourceLabel source={row.botGroupSource} />
        </div>
      ) : null}

      {hasAttachmentArea ? (
        <div
          data-v4-user-input-attachments="true"
          data-testid={testId(TID_V4_ROW_ATTACHMENTS, String(row.rowId))}
          className="mb-2 flex max-w-xl flex-col items-end gap-2"
        >
          {row.botGroupSource && conversationSelections.length > 0 ? (
            <div data-v4-user-input-quotes="true" className="flex max-w-full justify-end">
              <ConversationSelectionReferenceChip
                references={conversationSelections}
                contentAlign="end"
              />
            </div>
          ) : null}
          {hasMediaAttachments ? (
            <div
              data-v4-user-input-media-attachments="true"
              className="flex max-w-full flex-wrap justify-end gap-2"
            >
              <UserInputAttachmentList
                attachments={row.attachments}
                entityId={row.entityId}
                attachmentKind="media"
                directItems
                rowId={row.rowId}
                sessionId={context.sessionId ?? undefined}
                readAttachment={context.readAttachment}
                readAttachmentRange={context.readAttachmentRange}
              />
            </div>
          ) : null}
          {hasAttachmentPills ? (
            <div
              data-v4-user-input-attachment-pills="true"
              // 非媒体文件与上下文引用必须共享这一层，才能在换行时
              // 保持“文件→评论→网页→PPT→对话引用”的顺序和统一右对齐。
              className="flex max-w-full flex-wrap justify-end gap-2"
            >
              {hasFileAttachments ? (
                <UserInputAttachmentList
                  attachments={row.attachments}
                  entityId={row.entityId}
                  attachmentKind="file"
                  directItems
                  rowId={row.rowId}
                  sessionId={context.sessionId ?? undefined}
                  readAttachment={context.readAttachment}
                  readAttachmentRange={context.readAttachmentRange}
                />
              ) : null}
              <CodeCommentAttachmentChip comments={codeCommentContexts} contentAlign="end" />
              <WebElementContextAttachmentChip contexts={webElementContexts} contentAlign="end" />
              <PptxElementReferenceChip
                references={pptxElementReferences}
                contentAlign="end"
                onOpen={context.onOpenCodeViewer ? openPptxElementReference : undefined}
              />
              {!row.botGroupSource ? (
                <ConversationSelectionReferenceChip
                  references={conversationSelections}
                  contentAlign="end"
                />
              ) : null}
              <PluginUiModelContextChip contexts={pluginUiContexts} contentAlign="end" />
            </div>
          ) : null}
        </div>
      ) : null}
      {hasBubble ? (
        // 附件和上下文引用只属于消息行，不属于气泡；否则仅附件消息会留下空气泡。
        // 同一 row 会渲染在主会话和 Subagent 侧栏，固定宽度会忽略实际宿主宽度。
        // 气泡保留 flex item 的自动宽度；宿主至少 624px 时再以 36rem 封顶并保留 48px 余量。
        <ConversationUserInputBubble
          text={visibleText}
          contentParts={row.botGroupSource?.contentParts}
          rowId={row.rowId}
          epilogue={epilogue}
          attachments={row.attachments}
          contextAttachmentCount={countComposerPromptContexts(parsedPrompt)}
        />
      ) : null}
      {row.source?.kind === "genUi" && (
        <div
          className="mt-1 text-right text-ui-sm text-foreground-subtlest"
          data-v4-user-input-source="genUi"
        >
          {intl.formatMessage({ id: "genUi.from" }, { name: row.source.title || "Gen UI" })}
        </div>
      )}
      {row.source?.kind === "pluginUi" ? (
        // 插件 UI 代发：来源标记来自 CLI 持久化的 intent.source，不由 renderer 推断。
        <div
          data-v4-user-input-source={row.source.pluginId}
          className="mt-1 text-right text-ui-sm text-foreground-subtlest"
        >
          {intl.formatMessage(
            { id: "pluginUi.fromPlugin" },
            { name: formatPluginDisplayName(row.source.pluginId) },
          )}
        </div>
      ) : null}
      {status ? (
        <div
          data-v4-user-input-status="true"
          className="mt-1 text-right text-ui-sm text-foreground-subtlest"
          aria-live="polite"
        >
          {status}
        </div>
      ) : null}
      {/* Bugfix：手机远控没有 hover，v4 迁移时漏掉了旧 UserMessage 的常显分支，
          导致复制和编辑入口不可发现；远控直接显示，桌面端继续通过 hover/focus 降噪。 */}
      <MessageActions
        className={cn(
          "mt-1",
          context.compactForRemoteControl
            ? "opacity-100"
            : "opacity-0 transition-opacity group-hover/user-row:opacity-100 focus-within:opacity-100",
        )}
      >
        <CopyRowAction
          text={row.text}
          rowId={row.rowId}
          label={intl.formatMessage({ id: "chat.message.copy" })}
        />
        {onEdit && row.entityId ? (
          <MessageAction
            label={intl.formatMessage({ id: "chat.message.edit" })}
            tooltip={intl.formatMessage({ id: "chat.message.edit" })}
            data-testid={testId(TID_V4_EDIT, String(row.rowId))}
            onClick={handleOpenEdit}
          >
            <PencilIcon className="size-3.5" />
          </MessageAction>
        ) : null}
      </MessageActions>
    </RowShell>
  );
});

export const UserInputRowView = memo(function UserInputRowView(
  props: ComponentProps<typeof SingleUserInputRowView>,
) {
  const rows = useMemo(() => expandTopicInputMessages(props.row), [props.row]);
  if (rows.length === 1) return <SingleUserInputRowView {...props} row={rows[0]!} />;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-v4-topic-messages="true">
      {rows.map((row) => (
        <div
          key={row.botGroupSource!.messageId}
          data-topic-message-id={row.botGroupSource!.messageId}
        >
          {/* 多条原文共用一个已接收输入，不能把局部编辑误当作替换整批。 */}
          <SingleUserInputRowView {...props} row={row} onEdit={undefined} />
        </div>
      ))}
    </div>
  );
});
