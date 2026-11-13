// SessionPane 拆分：发送链路（slash 派发、Highspeed 发送起点、配置屏障后的 sendText）。
import { toast } from "@/components/ui/toast.js";
import { readHighspeedRegularTpsFromHealth } from "@/highspeed/highspeedSavedTime.js";
import type { HighspeedTurnPreparer } from "@/highspeed/highspeedSend.js";
import {
  HIGHSPEED_SEND_WAIT_BUDGET_MS,
  prepareHighspeedSendContext,
  readRegularTpsWithinSendBudget,
  resolveHighspeedPrepareSelection,
} from "@/highspeed/highspeedSend.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { resolveEntitledAccountProviderAccess } from "@/lib/accountProviderAccess.js";
import { isProviderNotReadyError } from "@/lib/chatPrepareError.js";
import { getProviderSettingsSnapshot } from "@/lib/providerSettingsSnapshot.js";
import { getRemoteConnectionFailureCode } from "@/lib/remoteWorkspaceServiceError.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import { logger } from "@/logger.js";
import type { AppSlashCommand } from "@/slashCommandHelpers.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { ComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";
import type { useDraftConfigControl } from "@/v4/composer/useDraftConfigControl.js";
import type { DraftPrewarmBinding } from "@/v4/composer/useDraftSessionPrewarm.js";
import type { ConfigCommandBarrier } from "@/v4/configCommandBarrier.js";
import type {
  ConversationComposerSendOptions,
  ConversationComposerSendResult,
} from "@/v4/ConversationComposer.js";
import { shouldFocusTimelineAfterComposerSend } from "@/v4/promptScrollFocusPolicy.js";
import type {
  HighspeedPaneOrigin,
  SessionPaneDispatchCommand,
  SessionPaneSendText,
} from "@/v4/session-pane/helpers.js";
import { submissionConfigFromCommand } from "@/v4/session-pane/helpers.js";
import type { V4VisibleSlashCommand } from "@/v4/slashCommands.js";
import { parseSelectionSideSlashCommand, parseV4VisibleSlashCommand } from "@/v4/slashCommands.js";
import type { ConversationPromptTelemetrySeed } from "@/v4/telemetry/conversationTelemetrySupervisor.js";
import type { IHighspeedCardService, IServiceAccessor, IUsageStatsService } from "@zcode/services";
import type {
  AppSettings,
  HighspeedCardSnapshot,
  HighspeedPrepareTurnResult,
  ModelSelection,
  SessionCreateSource,
} from "@zcode/shared";
import { buildGenUiModelContext } from "@zcode/shared/gen-ui";
import type {
  CommandType,
  ConversationSnapshot,
  SessionConfigState,
} from "@zcode/shared/zcode-protocol-v4";
import { useCallback } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";

export interface UseSessionPaneSendParams {
  sessionId: string | null;
  workspacePath: string;
  workspaceIdentity: string | undefined;
  highspeedCardService: IHighspeedCardService;
  usageStatsService: IUsageStatsService;
  intl: IntlInstance;
  baseWorkspaceServices: IServiceAccessor;
  setSendSubmissionError: Dispatch<SetStateAction<ZCodeUiError | null>>;
  snapshotRef: RefObject<ConversationSnapshot | null>;
  sessionIdRef: RefObject<string | null>;
  setActiveHighspeedCard: Dispatch<SetStateAction<HighspeedCardSnapshot | null>>;
  invalidateActiveHighspeedCard: (cardId: string, failureKey: string) => void;
  setHighspeedActivationCardId: Dispatch<SetStateAction<string | null>>;
  presentedHighspeedCardIdRef: RefObject<string | null>;
  timelineScrollToBottomRef: RefObject<(() => void) | null>;
  paneBindingRef: RefObject<{ key: string; generation: number }>;
  configCommandBarrier: ConfigCommandBarrier;
  ensureDraftModelReadyForSend: () => Promise<boolean>;
  markDraftProviderNotReady: () => void;
  sharedSettings: AppSettings | null;
  draftConfigRef: ReturnType<typeof useDraftConfigControl>["draftConfigRef"];
  resolveInitialDraftConfig: () => Partial<SessionConfigState> | undefined;
  captureAcceptedModelSelection: (
    selection: ModelSelection,
    expectedSelection?: ModelSelection,
  ) => () => void;
  recommendStartPlan: (selection: ModelSelection) => Promise<ModelSelection | null>;
  createSubmissionFromComposer: () => ComposerSubmissionConfig | null;
  reportDraftCreated: (
    createdSessionId: string,
    source: SessionCreateSource,
    messageId: string,
  ) => void;
  handleDraftSessionCreated: (
    createdSessionId: string,
    createSource?: SessionCreateSource,
    messageId?: string,
    taskGroupId?: string | null,
  ) => Promise<void>;
  dispatchCommand: SessionPaneDispatchCommand;
  handleOpenSelectionSideConversationWithPrompt: (
    text: string,
    telemetrySeed?: ConversationPromptTelemetrySeed,
  ) => Promise<boolean>;
  availableSelectionSideSlashCommandNames: Array<string>;
  appSlashCommands: Array<AppSlashCommand> | undefined;
  sendTextRef: RefObject<SessionPaneSendText | null>;
  waitForDraftSession: () => Promise<DraftPrewarmBinding>;
  prewarmBindingRef: RefObject<DraftPrewarmBinding | null>;
  ensureDraftPrewarmConfigBeforeSendRef: RefObject<(targetSessionId: string) => Promise<void>>;
  settleCurrentQueueInputs: (targetSessionId: string) => void;
}

export function useSessionPaneSend(params: UseSessionPaneSendParams) {
  const {
    sessionId,
    workspacePath,
    workspaceIdentity,
    highspeedCardService,
    usageStatsService,
    intl,
    baseWorkspaceServices,
    setSendSubmissionError,
    snapshotRef,
    sessionIdRef,
    setActiveHighspeedCard,
    invalidateActiveHighspeedCard,
    setHighspeedActivationCardId,
    presentedHighspeedCardIdRef,
    timelineScrollToBottomRef,
    paneBindingRef,
    configCommandBarrier,
    ensureDraftModelReadyForSend,
    markDraftProviderNotReady,
    sharedSettings,
    draftConfigRef,
    resolveInitialDraftConfig,
    captureAcceptedModelSelection,
    recommendStartPlan,
    createSubmissionFromComposer,
    reportDraftCreated,
    handleDraftSessionCreated,
    dispatchCommand,
    handleOpenSelectionSideConversationWithPrompt,
    availableSelectionSideSlashCommandNames,
    appSlashCommands,
    sendTextRef,
    waitForDraftSession,
    prewarmBindingRef,
    ensureDraftPrewarmConfigBeforeSendRef,
    settleCurrentQueueInputs,
  } = params;

  const dispatchSlashCommand = useCallback(
    async (
      command: V4VisibleSlashCommand,
      targetSessionId: string,
      baseRevision: number | undefined,
      heldQueueDisposition: "clearQueueAndSend" | "keepQueueAndSend" | undefined,
      expectedHeldQueueItemIds?: readonly string[],
      submission?: ComposerSubmissionConfig,
      onAccepted?: (messageId: string) => void,
    ): Promise<boolean | "confirmationRequired"> => {
      let type: CommandType | null = null;
      let payload: Record<string, unknown> = {};
      // compact 是可排队 input command，不走 CAS；resumeGoal 仍是 CAS。
      let withBaseRevision = false;
      const currentRoutingMode = snapshotRef.current?.inputRouting.mode;
      const compactExpectedToQueue =
        command.kind === "compact" &&
        currentRoutingMode !== undefined &&
        currentRoutingMode !== "startNow";
      switch (command.kind) {
        case "compact":
          type = "compact";
          break;
        case "sendGoalCommand":
          type = "sendGoalCommand";
          // 人工合并曾让 /goal 在准备完成后重新读取 Composer，覆盖点击时已冻结的档位。
          // 与 sendText 一样沿用本次 Submission；后续菜单修改只影响下一次发送。
          if (!submission) return false;
          payload = {
            text: command.objective,
            displayText: command.displayText,
            ...submission,
            ...(heldQueueDisposition ? { heldQueueDisposition } : {}),
            ...(expectedHeldQueueItemIds ? { expectedHeldQueueItemIds } : {}),
          };
          break;
        case "resumeGoal":
          type = "resumeGoal";
          withBaseRevision = true;
          break;
        case "emptyGoal":
          logger.warn("[v4-pane] /goal 需要目标文本");
          return true;
        case "unsupportedGoal":
          logger.warn(`[v4-pane] 暂不支持 /goal ${command.action}`);
          return true;
        default:
          return false;
      }
      if (withBaseRevision && baseRevision === undefined) {
        logger.warn(`[v4-pane] slash ${command.kind} 缺少 baseRevision`);
        return true;
      }
      const ack = await dispatchCommand(
        type,
        payload,
        targetSessionId,
        withBaseRevision ? baseRevision : undefined,
      );
      if (ack.status === "accepted") onAccepted?.(ack.commandId);
      if (ack.reasonCode === "guard.heldQueueConfirmationStale") {
        return "confirmationRequired";
      }
      if (ack.status !== "accepted" && ack.status !== "noop") {
        logger.warn(
          `[v4-pane] slash ${command.kind} 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`,
        );
        if (command.kind === "compact" && ack.reasonCode === "compactOperationLock") {
          toast(intl.formatMessage({ id: "chat.compact.duplicateBlocked" }));
        } else if (command.kind === "compact" && ack.reasonCode === "activeTurn") {
          // 兼容尚未升级的 CLI：旧端仍会返回 activeTurn，不能再次无声清空命令。
          toast(intl.formatMessage({ id: "chat.compact.runningBlocked" }));
        }
      } else if (command.kind === "compact" && compactExpectedToQueue) {
        toast(intl.formatMessage({ id: "chat.compact.queued" }));
      } else if (heldQueueDisposition === "clearQueueAndSend") {
        settleCurrentQueueInputs(targetSessionId);
      }
      return true;
    },
    [dispatchCommand, intl, settleCurrentQueueInputs],
  );

  const readGroupedDraftId = useCallback(
    () =>
      String(
        useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
          .draftFocusVersion,
      ),
    [workspacePath, workspaceIdentity],
  );
  /**
   * 冻结本次发送起点（spec §9.2）。必须在触发发送的同步阶段调用：早于配置屏障、草稿模型就绪、
   * Start 套餐推荐、空 session 创建等所有发送前 await，否则起点会被读成用户切换后的 Task。
   */
  const captureHighspeedPaneOrigin = useCallback(
    (): HighspeedPaneOrigin => ({
      sessionId: sessionIdRef.current,
      paneBinding: paneBindingRef.current.generation,
      draftId: sessionIdRef.current === null ? readGroupedDraftId() : null,
    }),
    [readGroupedDraftId],
  );

  const prepareHighspeedTurnFrom = useCallback(
    (origin: HighspeedPaneOrigin): HighspeedTurnPreparer =>
      async (
        taskId: string,
        submissionSelection?: ModelSelection,
      ): Promise<HighspeedPrepareTurnResult | null> => {
        // 规则 15：prepare 的选择与本次提交同源——用户刚切换的模型必须在首次发送就驱动
        // admission。曾按会话投影旧组合抽卡，抽中后把用户切到非 Coding Plan 模型的提交
        // 覆盖成卡模型，表现为"选了别的模型还是抽中加速"。
        const selection = resolveHighspeedPrepareSelection({
          submissionSelection,
          projectedConfig:
            snapshotRef.current?.sessionId === taskId ? snapshotRef.current.config : null,
          draftConfig: draftConfigRef.current,
          initialDraftConfig: resolveInitialDraftConfig(),
        });
        if (!selection) return null;
        // 加速卡沿用会话模型，必须带上会话生效的思考档位；缺档位时 CLI 会因 execution 选择
        // 不完整报 "Reasoning level is required" 让整轮发送失败。优先取提交选择的 options，
        // 再回落 thought（CLI 投影的生效档位）；空串表示该模型无档位，交给 service 省略 options。
        const { provider, model, reasoningLevel } = selection;
        try {
          const sendStartedAt = Date.now();
          const result = await highspeedCardService.prepareTurn({
            taskId,
            providerId: provider,
            model,
            ...(reasoningLevel ? { reasoningLevel } : {}),
            waitBudgetMs: HIGHSPEED_SEND_WAIT_BUDGET_MS,
          });
          if (result.kind === "accelerated") {
            // Bug 根因：该查询只决定节省时间展示，却曾在抽中后同步 await；monitor 侧 15s 超时把
            // 1s 发送承诺拉长到最多 16s（新会话首发尤其明显：空 session 已建、正文长期未发）。
            // 现在只在剩余发送预算内 best-effort 等待，超时/失败本轮不附加 regularTps，
            // 请求由 Service 层继续完成并缓存供下一轮（spec §3 规则 12、§9.4）。
            const regularTps = await readRegularTpsWithinSendBudget({
              read: async () => {
                // 节省时间的基准 TPS 来自 Coding Plan 用量健康接口，请求期鉴权只能由账号访问
                // 上下文解析。这里按当前选中的 Coding Plan Provider 现取快照，不订阅配置面
                // （SessionPane 不需要为此重渲染）；未连接或无权益时直接不展示节省时间。
                const providerSettingsState = getProviderSettingsSnapshot();
                const accountAccess =
                  providerSettingsState.status === "ready"
                    ? resolveEntitledAccountProviderAccess(providerSettingsState.view, provider)
                    : null;
                if (!accountAccess) return undefined;
                return readHighspeedRegularTpsFromHealth({
                  usageStatsService,
                  preferredProviderId: provider,
                  accountAccess: accountAccess.access,
                  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                });
              },
              elapsedMs: Date.now() - sendStartedAt,
              onError: (error) =>
                logger.warn("[highspeed] 读取普通 Decode TPS 失败，本轮不展示节省时间", {
                  error: error instanceof Error ? error.message : String(error),
                  provider,
                  taskId,
                }),
              onTimeout: (budgetMs) =>
                logger.info(
                  "[highspeed] 普通 Decode TPS 未在发送预算内返回，本轮不附加 regularTps",
                  {
                    budgetMs,
                    provider,
                    taskId,
                  },
                ),
            });
            const acceleratedResult: HighspeedPrepareTurnResult = regularTps
              ? { ...result, card: { ...result.card, regularTps } }
              : result;
            const cardId = acceleratedResult.card.cardId;
            // Bug 根因：SessionPane 跨 Task 复用同一实例，发送前的配置屏障、套餐推荐、建会话以及
            // prepare 与 TPS 读取 await 期间用户都可能切到其他 Task；此时写卡片状态会把旧 Task 的卡
            // 呈现到新 Task 的输入框并播放激活。起点曾在 prepare 入口才读取，切换发生在 prepare 之前时
            // 起点已是新 Task，判定失效；现由调用方在发送同步阶段冻结。只有 pane 正显示卡所属 Task，
            // 或草稿首发且 pane 从未离开该草稿（首发 session 尚未绑定回 pane）时才呈现。卡仍交给本轮
            // 发送继续加速，只跳过本 pane 的呈现；切回所属 Task 由快照恢复按 restore 呈现。
            const paneSessionId = sessionIdRef.current;
            const paneShowsSendTarget =
              paneSessionId === taskId ||
              (origin.sessionId === null &&
                paneSessionId === null &&
                paneBindingRef.current.generation === origin.paneBinding &&
                readGroupedDraftId() === origin.draftId);
            if (!paneShowsSendTarget) {
              return acceleratedResult;
            }
            // Bug 根因：恢复链路与 draw 命中共用同一条卡片渲染路径，按“卡片出现”触发激活动效会在
            // 切回 Task 时重播；prepare 复用已有卡同样返回 accelerated。只有本 pane 首次呈现的卡才登记。
            if (presentedHighspeedCardIdRef.current !== cardId) {
              presentedHighspeedCardIdRef.current = cardId;
              setHighspeedActivationCardId(cardId);
            }
            setActiveHighspeedCard(acceleratedResult.card);
            return acceleratedResult;
          } else if (
            !result.card ||
            result.card.taskId !== taskId ||
            result.card.expiresAt <= Date.now()
          ) {
            setActiveHighspeedCard((current) => (current?.taskId === taskId ? null : current));
          }
          return result;
        } catch (error) {
          logger.warn("[highspeed] 抽卡失败，本轮按普通模型发送", {
            error: error instanceof Error ? error.message : String(error),
            taskId,
          });
          return null;
        }
      },
    [
      draftConfigRef,
      highspeedCardService,
      readGroupedDraftId,
      resolveInitialDraftConfig,
      usageStatsService,
    ],
  );

  const dispatchSendTextAfterConfig = useCallback(
    async (
      text: string,
      options: ConversationComposerSendOptions | undefined,
      createSourceAtSend: SessionCreateSource,
      highspeedOriginAtSend: HighspeedPaneOrigin,
      taskGroupIdAtSend?: string | null,
    ) => {
      let onAcceptedSelection: (() => void) | undefined;
      const prepareHighspeedTurn = prepareHighspeedTurnFrom(highspeedOriginAtSend);
      const dispatchSubmissionCommand = async (...args: Parameters<typeof dispatchCommand>) => {
        args[9] = createSourceAtSend;
        args[11] = taskGroupIdAtSend;
        args[12] = options?.submittedDraftText ?? text;
        if (
          args[0] === "sendText" &&
          args[2] &&
          baseWorkspaceServices.genUiService &&
          typeof args[1]?.text === "string"
        ) {
          try {
            const context = buildGenUiModelContext(
              await baseWorkspaceServices.genUiService.listState({
                workspacePath,
                workspaceIdentity,
                sessionId: args[2],
              }),
            );
            if (context) args[1] = { ...args[1], text: `${args[1].text}\n\n${context}` };
          } catch {
            // 状态是辅助上下文；读取失败不能阻断既有 CommandInbox 输入路径。
            logger.warn("[gen-ui] Widget context unavailable");
          }
        }
        const ack = await dispatchCommand(...args);
        // 在原 accepted 边界写回推荐选择，早于新 Session 的草稿转移；失败不改用户意图。
        if (ack.status === "accepted" && submissionConfigFromCommand(args[0], args[1]))
          onAcceptedSelection?.();
        return ack;
      };
      // 进入 barrier 前已经冻结；等待配置/附件期间不再回读 Composer 或 Session。
      let submission = options?.submission ?? null;
      if (submission) {
        // Bug 根因：旧版冻结的 Composer intent 不含 planEnabled，按协议兼容默认值归一化一次再发送。
        submission = {
          ...submission,
          planEnabled: submission.planEnabled ?? false,
        };
      }
      const heldQueueDisposition = options?.heldQueueDisposition;
      const expectedHeldQueueItemIds = options?.expectedHeldQueueItemIds;
      const readyAttachments = options?.attachments ?? [];
      const sharedContextRefs = options?.sharedContextRefs;
      const contextAttachmentCount = options?.contextAttachmentCount ?? 0;
      const slashCommand = parseV4VisibleSlashCommand(text, readyAttachments, {
        contextAttachmentCount,
      });

      if (!(await ensureDraftModelReadyForSend())) {
        return "blocked" as const;
      }

      const selectionSideSlashCommand =
        sessionId &&
        appSlashCommands?.some((command) => command.value === "side" || command.value === "btw")
          ? parseSelectionSideSlashCommand(text, readyAttachments, {
              contextAttachmentCount,
              enabledCommandNames: availableSelectionSideSlashCommandNames,
            })
          : null;
      if (sessionId && selectionSideSlashCommand) {
        const created = await handleOpenSelectionSideConversationWithPrompt(
          selectionSideSlashCommand.text,
          options?.telemetrySeed,
        );
        return created ? ("sent" as const) : ("blocked" as const);
      }
      if (
        submission?.planEnabled &&
        slashCommand !== null &&
        (slashCommand.kind === "sendGoalCommand" ||
          slashCommand.kind === "resumeGoal" ||
          slashCommand.kind === "emptyGoal" ||
          slashCommand.kind === "unsupportedGoal")
      ) {
        // Plan 模式不能创建、更新或恢复 goal。必须在 draft promotion / command dispatch
        // 之前拒绝，否则即使 CLI 后续拒绝，composer 也会误以为发送成功并清空用户输入。
        toast(intl.formatMessage({ id: "chat.goal.planModeBlocked" }));
        return "blocked" as const;
      }
      if (
        !submission ||
        !submission.modelSelection ||
        !submission.mode ||
        submission.planEnabled === undefined
      ) {
        logger.warn("[v4-pane] Submission 缺少完整模型或模式配置");
        return "blocked" as const;
      }
      const currentRoutingMode = snapshotRef.current?.inputRouting.mode;
      if (
        currentRoutingMode === "choice" &&
        !heldQueueDisposition &&
        (slashCommand === null || slashCommand.kind === "sendGoalCommand")
      ) {
        // UI choice 只对普通输入和 /goal <新目标> 生效；/compact 直接追加暂停队列，
        // resumeGoal 等控制命令也不应被发送消息确认框截获。
        return "confirmationRequired" as const;
      }
      // slash 命令优先：已有 session 直接消费；draft 首发 /goal 复用同一个预热会话。
      if (slashCommand === null || slashCommand.kind === "sendGoalCommand") {
        const original = submission.modelSelection;
        const chosen = await recommendStartPlan(original);
        if (!chosen) return "blocked" as const;
        if (chosen !== original) {
          onAcceptedSelection = captureAcceptedModelSelection(chosen, original);
          submission = { ...submission, modelSelection: chosen };
        }
      }
      const prewarmTargetBeforeSend =
        sessionId === null ? prewarmBindingRef.current?.sessionId : null;
      if (prewarmTargetBeforeSend) {
        // 屏障只保证已经入队的命令完成；若点击配置时预热 session/snapshot 尚未
        // 就绪，命令可能当时没有目标。首发绑定确定的预热 session 前再同步一次
        // 草稿权威配置，禁止 UI 新值与 runtime 旧值分叉。
        await ensureDraftPrewarmConfigBeforeSendRef.current(prewarmTargetBeforeSend);
      }
      // slash 命令优先：已有 session 直接消费；draft 首发 /goal 先建空会话再发命令。
      // 携带附件或网页元素上下文时不消费为 v4 原生命令（compact/goal 等无附件语义），随 sendText 直发。
      if (sessionId && slashCommand) {
        const consumed = await dispatchSlashCommand(
          slashCommand,
          sessionId,
          snapshotRef.current?.revision,
          heldQueueDisposition,
          expectedHeldQueueItemIds,
          submission,
        );
        if (consumed === "confirmationRequired") return consumed;
        if (consumed) {
          onAcceptedSelection?.();
          return;
        }
      }
      const draftSlashCommand =
        slashCommand?.kind === "sendGoalCommand" ||
        slashCommand?.kind === "resumeGoal" ||
        slashCommand?.kind === "emptyGoal" ||
        slashCommand?.kind === "unsupportedGoal"
          ? slashCommand
          : null;
      if (!sessionId && draftSlashCommand) {
        if (
          draftSlashCommand.kind === "emptyGoal" ||
          draftSlashCommand.kind === "unsupportedGoal"
        ) {
          await dispatchSlashCommand(
            draftSlashCommand,
            prewarmBindingRef.current?.sessionId ?? "__draft__",
            undefined,
            heldQueueDisposition,
            expectedHeldQueueItemIds,
            submission,
          );
          return;
        }
      }
      // Bug 根因：首发曾把 binding=null 当成无预热，绕过 owner 再建一个会话。
      // 文本、附件/context 和 goal 都等待同一创建任务，创建失败或换代直接保留草稿。
      const draftBinding = sessionId === null ? await waitForDraftSession() : null;
      if (draftBinding) {
        await ensureDraftPrewarmConfigBeforeSendRef.current(draftBinding.sessionId);
        if (!draftBinding.beginPromotion()) throw new Error("草稿会话已切换，请重新发送");
      }
      const targetSessionId = sessionId ?? draftBinding!.sessionId;
      if (draftBinding && draftSlashCommand) {
        const consumed = await dispatchSlashCommand(
          draftSlashCommand,
          targetSessionId,
          0,
          heldQueueDisposition,
          expectedHeldQueueItemIds,
          submission,
          (messageId) => reportDraftCreated(targetSessionId, createSourceAtSend, messageId),
        );
        if (consumed === "confirmationRequired") return consumed;
        if (consumed) {
          draftBinding.promote();
          await handleDraftSessionCreated(
            targetSessionId,
            createSourceAtSend,
            undefined,
            taskGroupIdAtSend,
          );
          return;
        }
      }
      // admission 写出后的失败或 transport error 不能证明 CLI 没有执行；保留原 binding
      // 的 pending 生命周期，交给 Composer 保留输入，禁止自动换会话/command 重发。
      // 附件 ref 已在 composer 预传状态机中收口。
      const highspeed = await prepareHighspeedSendContext(
        targetSessionId,
        prepareHighspeedTurn,
        submission.modelSelection,
      );
      const ack = await dispatchSubmissionCommand(
        "sendText",
        {
          text,
          ...submission,
          ...(options?.orchestrationMode ? { orchestrationMode: options.orchestrationMode } : {}),
          ...(options?.requestedDelivery ? { requestedDelivery: options.requestedDelivery } : {}),
          conversationQuotes: options?.conversationQuotes,
          ...(readyAttachments.length > 0 ? { attachments: readyAttachments } : {}),
          ...(sessionId && options?.requestedDelivery
            ? {
                // Bug 根因：立即发送曾先投影 QueueItem，再等待二次
                // sendQueuedNow，导致队列中间态外泄且输入框延迟清空。现在由
                // CLI 原子 stop + start，accepted ACK 即是 Composer 清空边界。
                requestedDelivery: options.requestedDelivery,
              }
            : {}),
          ...(heldQueueDisposition ? { heldQueueDisposition } : {}),
          ...(expectedHeldQueueItemIds ? { expectedHeldQueueItemIds } : {}),
          ...(sharedContextRefs?.length ? { context_refs: sharedContextRefs } : {}),
          ...(options?.source ? { source: options.source } : {}),
          ...highspeed.override,
        },
        targetSessionId,
        undefined,
        undefined,
        options?.telemetrySeed,
        highspeed.acceleratedCard,
        options?.onCommandCreated
          ? (envelope) => {
              if (envelope.type === "sendText") options.onCommandCreated?.(envelope.commandId);
            }
          : undefined,
        undefined,
        undefined,
        // Recent 记录加速前的 Composer 原始选择，不用被覆盖的 payload Selection。
        submission,
      );
      if (ack.reasonCode === "guard.heldQueueConfirmationStale") {
        return "confirmationRequired" as const;
      }
      if (ack.status !== "accepted") {
        if (
          ack.reasonCode === "modelUnavailable" &&
          highspeed.acceleratedCard &&
          highspeed.override.modelExecution?.selectionFallback
        ) {
          // Bug 根因：Highspeed 与退回模型都不可用时，准入拒绝曾按普通发送异常处理，
          // Composer 虽保留输入，但卡仍锁住模型选择且显示无助于恢复的错误。作废 Service
          // 持有的同一张卡，并返回 blocked，让 Composer 的提交事务恢复正文和附件。
          setSendSubmissionError(null);
          invalidateActiveHighspeedCard(
            highspeed.acceleratedCard.cardId,
            `admission:${ack.commandId}:${highspeed.acceleratedCard.cardId}`,
          );
          return "blocked" as const;
        }
        throw new Error(ack.reasonCode ?? "sendText 被拒绝");
      }
      if (draftBinding) {
        // 合并后普通首发漏传 commandId；只在 accepted 边界统计，避免预热空创建重复计数。
        draftBinding.promote();
        await handleDraftSessionCreated(
          targetSessionId,
          createSourceAtSend,
          ack.commandId,
          taskGroupIdAtSend,
        );
      } else if (heldQueueDisposition === "clearQueueAndSend") {
        settleCurrentQueueInputs(targetSessionId);
      }
    },
    [
      dispatchCommand,
      recommendStartPlan,
      baseWorkspaceServices,
      captureAcceptedModelSelection,
      dispatchSlashCommand,
      ensureDraftModelReadyForSend,
      sharedSettings?.openCodeCliEnabled,
      availableSelectionSideSlashCommandNames,
      appSlashCommands,
      handleDraftSessionCreated,
      reportDraftCreated,
      handleOpenSelectionSideConversationWithPrompt,
      invalidateActiveHighspeedCard,
      intl,
      prepareHighspeedTurnFrom,
      resolveInitialDraftConfig,
      createSubmissionFromComposer,
      sessionId,
      settleCurrentQueueInputs,
      waitForDraftSession,
    ],
  );

  const dispatchSendText = useCallback(
    (text: string, options?: ConversationComposerSendOptions) => {
      const createSource = useZCodeSessionStore
        .getState()
        .getWorkspaceState(workspacePath, workspaceIdentity).draftCreateSource;
      const submissionOptions = {
        ...options,
        submission:
          options?.submission === undefined ? createSubmissionFromComposer() : options.submission,
      };
      // 进入配置屏障前冻结 Highspeed 发送起点；屏障与后续 await 期间用户可能切换 Task。
      const highspeedOrigin = captureHighspeedPaneOrigin();
      const taskGroupId =
        sessionId === null
          ? useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
              .draftTaskGroupId
          : undefined;
      // followupMode 仍通过 Session CAS 同步；模型和模式已封装进 Submission，不再
      // 依赖“配置命令先到、sendText 后到”的跨命令时序。
      return configCommandBarrier.enqueue(async () => {
        try {
          return await dispatchSendTextAfterConfig(
            text,
            submissionOptions,
            createSource,
            highspeedOrigin,
            taskGroupId,
          );
        } catch (error) {
          if (sessionId === null && isProviderNotReadyError(error)) {
            // UI 预检查与 Host getClient 之间 registry 仍可能失效。竞态命中时收敛成
            // 同一个正常等待态，不走异常发送路径，也不清空 composer。
            markDraftProviderNotReady();
            return "blocked" as const;
          }
          throw error;
        }
      });
    },
    [
      captureHighspeedPaneOrigin,
      configCommandBarrier,
      createSubmissionFromComposer,
      dispatchSendTextAfterConfig,
      markDraftProviderNotReady,
      sessionId,
      workspacePath,
      workspaceIdentity,
    ],
  );

  const focusTimelineToLatest = useCallback(() => {
    timelineScrollToBottomRef.current?.();
  }, []);

  const handleSendText = useCallback(
    async (
      text: string,
      options?: ConversationComposerSendOptions,
    ): Promise<ConversationComposerSendResult> => {
      // 发送前冻结本次 admission 预期：command ACK 回来时 projection 可能已经切到 running，
      // 不能用更新后的 enqueue mode 反推刚提交的 prompt 是否原本立即发送。
      const shouldFocusLatest = shouldFocusTimelineAfterComposerSend({
        draftMode: sessionId === null,
        inputRoutingMode: snapshotRef.current?.inputRouting.mode ?? null,
        heldQueueDisposition: options?.heldQueueDisposition,
      });
      try {
        const sendResult = await dispatchSendText(text, options);
        if (sendResult === "blocked" || sendResult === "confirmationRequired") {
          return sendResult;
        }
        setSendSubmissionError(null);
        if (shouldFocusLatest) {
          focusTimelineToLatest();
        }
        return "sent";
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const runtimeModelUnavailable = detail.includes("provider.notInRegistry");
        // 首发前 switchModelConfig 失败只会抛回 Composer；Composer 为了保留草稿
        // 仅写日志，不会生成 snapshot.control.lastError，用户看到的结果就是“点击没反应”。
        // 这里把 admission 前失败收口为 pane-local 错误横幅，不改变 desktop continuous 或
        // Web remote replayable 的发送/恢复语义，草稿仍由 Composer 原路径保留。
        setSendSubmissionError({
          code:
            getRemoteConnectionFailureCode(error) ??
            (runtimeModelUnavailable ? "ZCODE_RUNTIME_MODEL_UNAVAILABLE" : "SEND_FAILED"),
          message: runtimeModelUnavailable
            ? detail
            : intl.formatMessage({ id: "chat.error.sendFailed" }),
          detail,
          ...(sessionId ? { taskId: sessionId } : {}),
        });
        throw error;
      }
    },
    [dispatchSendText, focusTimelineToLatest, intl, sessionId],
  );
  // 上面那个 ref 的唯一赋值点（见 handleSendWorkflowSaveRequest 的说明）。
  sendTextRef.current = handleSendText;

  return {
    dispatchSlashCommand,
    captureHighspeedPaneOrigin,
    prepareHighspeedTurnFrom,
    dispatchSendText,
    focusTimelineToLatest,
    handleSendText,
  };
}
