import type { ComponentProps, Dispatch, MutableRefObject, ReactNode, SetStateAction } from "react";
import {
  TID_V4_COMPOSER,
  TID_V4_COMPOSER_CLEAR_QUEUE_SEND,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_KEEP_QUEUE_SEND,
  TID_V4_PAUSED_QUEUE_SEND_DIALOG,
} from "@zcode/shared/test-ids";
import { InfoIcon, XIcon } from "lucide-react";
import type { ChatErrorBannerModelConfigTarget } from "@/ChatErrorBanner.js";
import { ChatErrorBanner } from "@/ChatErrorBanner.js";
import { ChatMediaAttachmentPreviewDialog } from "@/ChatMediaAttachmentPreviewDialog.js";
import type { ChatMediaAttachmentPreviewTarget } from "@/ChatMediaAttachmentPreviewDialog.js";
import { ChatPromptEditor } from "@/prompt-editor/ChatPromptEditor.js";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import { ComposerSubmissionPendingContext } from "@/project-sidebar/index.js";
import { HighspeedComposerBackground } from "@/highspeed/HighspeedActivationVisual.js";
import { useOptionalRemoteWorkspaceController } from "@/remote/useRemoteWorkspaceController.js";
import { useRemoteProjectReconnect } from "@/hooks/RemoteProjectPresentationContext.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import type { AppSlashCommand } from "@/slashCommandHelpers.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import { getLocalTtftObserver } from "@/v4/telemetry/localTtftObserver.js";
import type { useComposerAttachments } from "@/v4/composer/useComposerAttachments.js";
import type { HighspeedCardSnapshot } from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationComposerProps, HeldQueueConfirmation } from "./types.js";

/**
 * composer 的根视图：错误/初始化提示、高 speed 背景、编辑器壳与底部弹窗。
 *
 * 由 `ConversationComposer` 直接调用（不包一层 memo），所有状态与回调都是入参，
 * 因此这里只描述 DOM 结构与可访问语义，不引入新的状态所有者。
 */

type AttachmentsApi = ReturnType<typeof useComposerAttachments>;
type MediaPreviewItems = ComponentProps<typeof ImagePreviewDialog>["items"];
type AttachmentAction = ComponentProps<typeof ChatPromptEditor>["attachmentAction"];
type EditorSubmitHandler = NonNullable<ComponentProps<typeof ChatPromptEditor>["onSubmit"]>;
type InputApiRef = MutableRefObject<LexicalChatInputHandle | null>;

export interface ComposerRootInput {
  props: ConversationComposerProps;
  attachmentsApi: AttachmentsApi;
  mode: string;
  visibleError: ZCodeUiError | null;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  initialization: ConversationSnapshot["runtimeInitialization"] | undefined;
  pending: boolean;
  disabled: boolean;
  runtimeBlocked: boolean;
  remoteAvailable: boolean;
  routingAllowsSend: boolean;
  attachmentsReady: boolean;
  submissionReady: boolean;
  hasCodeCommentContexts: boolean;
  hasAttachments: boolean;
  hasWebElementContexts: boolean;
  hasPptxElementReferences: boolean;
  hasConversationSelectionReferences: boolean;
  hasPluginUiContexts: boolean;
  enterSubmits: boolean;
  modifiedEnterSubmits: boolean;
  sendTooltipTitle: string;
  normalPlaceholder: string;
  avoidIosInputFocusZoom: boolean;
  compactMobilePlaceholder: boolean;
  conversationSelectionLimitReason: string | null;
  topContentNode: ReactNode;
  attachmentAction: AttachmentAction;
  leadingActionsNode: ReactNode;
  submitControlNode: ReactNode;
  composerMediaPreviewItems: MediaPreviewItems;
  /**
   * App-команды с добавленным `/enhance`. Каталог CLI остаётся авторитетом,
   * поэтому список передаётся отдельно, а не мутируется в props.
   */
  appSlashCommandsOverride?: readonly AppSlashCommand[];
  attachmentPreviewIndex: number;
  attachmentPreviewOpen: boolean;
  setAttachmentPreviewOpen: (open: boolean) => void;
  pdfAttachmentPreview: ChatMediaAttachmentPreviewTarget | null;
  pdfAttachmentPreviewOpen: boolean;
  setPdfAttachmentPreview: (target: ChatMediaAttachmentPreviewTarget | null) => void;
  setPdfAttachmentPreviewOpen: (open: boolean) => void;
  heldQueueConfirmation: HeldQueueConfirmation | null;
  setHeldQueueConfirmation: Dispatch<SetStateAction<HeldQueueConfirmation | null>>;
  pendingRef: MutableRefObject<boolean>;
  handleClearQueueSend: () => void;
  handleKeepQueueSend: () => void;
  handleEditorChange: (value: string) => void;
  handleEditorFocus: () => void;
  handleEditorSubmit: EditorSubmitHandler;
  handleModifiedEditorSubmit: EditorSubmitHandler;
  inputApiRef: InputApiRef;
  promptHistory: readonly string[];
  workspaceKey: string;
  modelConfigTarget: ChatErrorBannerModelConfigTarget;
  highspeedCard: HighspeedCardSnapshot | null;
  highspeedEntrance: "activation" | "restore" | "none";
  highspeedEntranceAnimated: boolean;
  highspeedPresented: boolean;
  handleHighspeedModelTransitionStart: () => void;
  updateTargetSelectionPending: (pending: boolean) => void;
  remoteKind: { kind: string; remoteTarget?: { kind?: string } } | undefined;
  reconnectProject: ReturnType<typeof useRemoteProjectReconnect>;
  remoteController: ReturnType<typeof useOptionalRemoteWorkspaceController>;
}

export function buildComposerRoot(input: ComposerRootInput): ReactNode {
  const {
    props,
    attachmentsApi,
    mode,
    visibleError,
    intl,
    initialization,
    pending,
    disabled,
    runtimeBlocked,
    remoteAvailable,
    routingAllowsSend,
    attachmentsReady,
    submissionReady,
    hasCodeCommentContexts,
    hasAttachments,
    hasWebElementContexts,
    hasPptxElementReferences,
    hasConversationSelectionReferences,
    hasPluginUiContexts,
    enterSubmits,
    modifiedEnterSubmits,
    sendTooltipTitle,
    normalPlaceholder,
    avoidIosInputFocusZoom,
    compactMobilePlaceholder,
    conversationSelectionLimitReason,
    topContentNode,
    attachmentAction,
    leadingActionsNode,
    submitControlNode,
    composerMediaPreviewItems,
    attachmentPreviewIndex,
    attachmentPreviewOpen,
    setAttachmentPreviewOpen,
    pdfAttachmentPreview,
    pdfAttachmentPreviewOpen,
    setPdfAttachmentPreview,
    setPdfAttachmentPreviewOpen,
    heldQueueConfirmation,
    setHeldQueueConfirmation,
    pendingRef,
    handleClearQueueSend,
    handleKeepQueueSend,
    handleEditorChange,
    handleEditorFocus,
    handleEditorSubmit,
    handleModifiedEditorSubmit,
    inputApiRef,
    promptHistory,
    workspaceKey,
    modelConfigTarget,
    highspeedCard,
    highspeedEntrance,
    highspeedEntranceAnimated,
    highspeedPresented,
    handleHighspeedModelTransitionStart,
    updateTargetSelectionPending,
    remoteKind,
    reconnectProject,
    remoteController,
    appSlashCommandsOverride,
  } = input;
  const {
    appSlashCommands,
    blockingRequestId = null,
    centered = false,
    contextHeader,
    layout = "stacked",
    onDismissError,
    onOpenModelSettings,
    onOpenModelUpgrade,
    onRetryInitialization,
    sessionId = null,
    skillCatalogSessionId = sessionId,
    suppressGoalCommands = false,
    workspaceIdentity,
    workspacePath,
  } = props;
  const isBlockedByInteraction = blockingRequestId !== null;

  // v4 pendingInteractions 是 bottom dock 阻塞态；composer 必须保留挂载，
  // 只在视觉和可访问树中隐藏，避免权限/问答卡片出现时丢失草稿和编辑器内部状态。
  return (
    // 外层 bottom dock 负责 sticky 与横向主列宽度；composer 自身组织错误提示与输入壳。
    // centered（居中草稿布局，m5）：收窄 max-w-2xl（旧
    // getChatViewComposerWidthClassName 的 draft 档），由宿主的居中容器摆位。
    // 有 contextHeader（草稿态）时，内层输入 surface 套旧 ChatViewComposer 同款卡：
    // rounded-2xl bg-surface shadow-xl/5；会话态回落不透明页面底色。
    // 错误横幅虽然排在 contextHeader 前面，但不能与输入区共用同一个圆角 surface，
    // 视觉上会被误认为输入卡标题栏；将 surface 边界收窄到工作区头和编辑器后，桌面与手机
    // Web 仍共享同一 DOM 顺序，同时恢复错误提示与输入卡之间的独立层级。
    <div
      data-testid={TID_V4_COMPOSER}
      data-input-routing={mode}
      aria-hidden={isBlockedByInteraction ? true : undefined}
      style={isBlockedByInteraction ? { display: "none" } : undefined}
      className={cn(
        "chat-composer-region z-20 w-full shrink-0 @container/composer",
        centered && "max-w-2xl",
      )}
    >
      {/* 旧 ChatViewComposer 同款隐藏 file input（web/无 native picker 平台回退）。 */}
      <input
        ref={attachmentsApi.attachmentInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={attachmentsApi.handleAttachmentInputChange}
      />
      {visibleError ? (
        // 仅展示附件错误会漏掉会话级 lastError，任务失败后也应在输入框上方显示原因。
        // 这里复用旧 ChatErrorBanner 壳，只接收 SessionPane 已归一化后的当前错误。
        // 错误横幅独立于输入 surface，并先于桌面和手机共用的 contextHeader。
        <div className="mb-6 w-full shrink-0">
          <ChatErrorBanner
            error={visibleError}
            remoteKind={
              remoteKind?.kind === "workspace" ? remoteKind.remoteTarget?.kind : undefined
            }
            onReconnect={
              reconnectProject || remoteController
                ? () => {
                    const request = reconnectProject
                      ? reconnectProject(workspaceKey)
                      : remoteController?.dispatch({
                          type: "reconnect-workspace",
                          workspaceKey,
                        });
                    void request?.catch((error: unknown) =>
                      logger.warn("[v4-composer] 项目重连失败", { error }),
                    );
                  }
                : undefined
            }
            onDismiss={onDismissError}
            onOpenModelSettings={onOpenModelSettings}
            onOpenUpgrade={onOpenModelUpgrade}
            modelConfigTarget={modelConfigTarget}
          />
        </div>
      ) : null}
      {initialization?.status === "failed" ? (
        // 初始化中只限制执行，不额外显示提示；失败时才显示错误和重试。
        // 状态条悬在可滚动正文上方；必须使用不透明 card，避免历史文字透入错误提示。
        <div
          data-testid="v4-session-initialization"
          role="alert"
          className="mb-2 flex w-full flex-wrap items-center gap-2 rounded-lg border border-card-border bg-card px-3 py-2 text-ui-base text-foreground-subtle"
        >
          <span className="min-w-0 flex-1">
            {intl.formatMessage({ id: "chat.initialization.failed" })}
          </span>
          {onRetryInitialization ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="v4-session-initialization-retry"
              onClick={onRetryInitialization}
            >
              {intl.formatMessage({ id: "chat.initialization.retry" })}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div
        data-highspeed-composer={highspeedCard ? "true" : undefined}
        data-highspeed-entrance={highspeedCard ? highspeedEntrance : undefined}
        className={cn(
          "chat-composer-input-surface relative w-full",
          contextHeader && "rounded-2xl bg-surface shadow-xl/5",
          highspeedCard && "highspeed-composer-surface",
          highspeedPresented && "highspeed-placeholder-presented",
        )}
      >
        {highspeedCard ? (
          <HighspeedComposerBackground
            key={highspeedCard.cardId}
            animated={highspeedEntranceAnimated}
            onModelTransitionStart={handleHighspeedModelTransitionStart}
          />
        ) : null}
        {contextHeader ? (
          // 旧 ChatViewComposer contextHeaderContent 同款包装（workspace 菜单 + Git 分支）。
          <div className="relative z-10 p-1.5 flex min-w-0 flex-wrap items-center gap-0">
            <ComposerSubmissionPendingContext.Provider value={updateTargetSelectionPending}>
              {contextHeader}
            </ComposerSubmissionPendingContext.Provider>
          </div>
        ) : null}
        {conversationSelectionLimitReason ? (
          <div
            role="alert"
            className="relative z-10 mb-2 w-full rounded-lg border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 px-3 py-2 text-ui-base text-foreground"
          >
            {intl.formatMessage({
              id: `chat.selections.limit.${conversationSelectionLimitReason}`,
            })}
          </div>
        ) : null}
        <ChatPromptEditor
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          taskId={sessionId}
          skillCatalogSessionId={skillCatalogSessionId}
          placeholder={
            remoteAvailable
              ? normalPlaceholder
              : intl.formatMessage({
                  id: "remote.conversation.sendUnavailable",
                })
          }
          disabled={disabled || mode === "reject"}
          submitting={pending}
          submitDisabled={
            runtimeBlocked || pending || !routingAllowsSend || !attachmentsReady || !submissionReady
          }
          allowSubmitWhenEmpty={
            // 发送按钮已把代码评论视为可发送上下文，但这里曾漏掉同一状态，
            // 导致空文本仅附代码评论时 Enter 被编辑器判为空，必须改点发送按钮。
            hasCodeCommentContexts ||
            hasAttachments ||
            hasWebElementContexts ||
            hasPptxElementReferences ||
            hasConversationSelectionReferences ||
            hasPluginUiContexts
          }
          enterSubmits={enterSubmits}
          onModifiedSubmit={modifiedEnterSubmits ? handleModifiedEditorSubmit : undefined}
          submitLabel={sendTooltipTitle}
          showSlashButton
          // @ 是 Plugin / 文件 / 对话 / 画板主入口；# 会话与 $ / ¥ / ￥ Skills
          // 仍由 MentionPlugin 保留兼容触发，但不在 + 菜单重复展示。
          showMentionButton
          topContent={topContentNode}
          attachmentAction={runtimeBlocked ? undefined : attachmentAction}
          inputTestId={TID_V4_COMPOSER_INPUT}
          inputApiRef={inputApiRef}
          promptHistory={promptHistory}
          avoidIosInputFocusZoom={avoidIosInputFocusZoom}
          compactPlaceholder={compactMobilePlaceholder}
          // Bugfix 原因：命令目录必须完整来自 CLI workspace slash catalog；UI 只在
          // secondary pane 按产品能力隐藏 goal，不再追加任何内建命令或别名。
          excludedSlashCommandNames={suppressGoalCommands ? ["goal"] : undefined}
          appSlashCommands={
            runtimeBlocked ? [] : (appSlashCommandsOverride ?? appSlashCommands)
          }
          enableMentionPanel
          leadingActions={leadingActionsNode}
          submitControl={submitControlNode}
          layout={layout}
          className="p-0"
          shellClassName={
            highspeedCard
              ? "relative z-10 !rounded-none !border-0 !bg-transparent !transition-none hover:!border-transparent focus-within:!border-transparent focus-within:!bg-transparent"
              : undefined
          }
          onChange={handleEditorChange}
          onFocus={handleEditorFocus}
          onSubmit={handleEditorSubmit}
          onWhiteboardMentionSelected={attachmentsApi.handleWhiteboardMentionSelected}
          onPaste={attachmentsApi.handlePaste}
        />
        {attachmentsApi.attachmentError ? (
          <p className="flex items-start gap-2 p-3 text-ui-base text-warning">
            <InfoIcon className="mt-0.5 size-4 shrink-0" />
            <span>{attachmentsApi.attachmentError}</span>
          </p>
        ) : null}
      </div>
      <ImagePreviewDialog
        initialIndex={attachmentPreviewIndex}
        items={composerMediaPreviewItems}
        onOpenChange={setAttachmentPreviewOpen}
        open={attachmentPreviewOpen}
      />
      <ChatMediaAttachmentPreviewDialog
        attachment={pdfAttachmentPreview}
        open={pdfAttachmentPreviewOpen}
        onOpenChange={(open) => {
          setPdfAttachmentPreviewOpen(open);
          if (!open) setPdfAttachmentPreview(null);
        }}
      />
      <Dialog
        open={heldQueueConfirmation !== null}
        onOpenChange={(open) => {
          if (!open && !pendingRef.current) {
            if (heldQueueConfirmation?.telemetrySeed.localTtft)
              getLocalTtftObserver()?.exclude(
                heldQueueConfirmation.telemetrySeed.localTtft,
                "cancelled",
              );
            setHeldQueueConfirmation(null);
          }
        }}
      >
        <DialogContent
          data-testid={TID_V4_PAUSED_QUEUE_SEND_DIALOG}
          showCloseButton={false}
          className="max-w-xl gap-6 p-6 sm:p-8"
        >
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              disabled={pending}
              aria-label={intl.formatMessage({ id: "common.close" })}
              className="absolute top-4 right-4"
            >
              <XIcon className="size-5" />
            </Button>
          </DialogClose>
          <DialogHeader className="gap-3 pr-8">
            <DialogTitle className="text-xl font-semibold sm:text-2xl">
              {intl.formatMessage({ id: "chat.queue.sendConfirm.title" })}
            </DialogTitle>
            <DialogDescription className="text-ui-base sm:text-ui-lg">
              {intl.formatMessage(
                { id: "chat.queue.sendConfirm.description" },
                {
                  count: String(heldQueueConfirmation?.queueItemIds.length ?? 0),
                },
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-3 sm:gap-3">
            <Button
              type="button"
              variant="destructive"
              size="lg"
              data-testid={TID_V4_COMPOSER_CLEAR_QUEUE_SEND}
              disabled={pending}
              className="min-w-32 rounded-full"
              onClick={handleClearQueueSend}
            >
              {intl.formatMessage({ id: "chat.queue.sendConfirm.clear" })}
            </Button>
            <Button
              type="button"
              size="lg"
              data-testid={TID_V4_COMPOSER_KEEP_QUEUE_SEND}
              disabled={pending}
              className="min-w-32 rounded-full"
              onClick={handleKeepQueueSend}
            >
              {pending ? <Spinner className="size-4" /> : null}
              {intl.formatMessage({ id: "chat.queue.sendConfirm.keep" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
