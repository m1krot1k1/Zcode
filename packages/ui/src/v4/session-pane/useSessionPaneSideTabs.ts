// SessionPane 拆分：侧板/详情页打开入口与框选副屏会话创建。
import type { WorkflowRunSettingsChange } from "@/components/workflow-timeline/workflowRunSettings.js";
import { workflowSessionModelOf } from "@/components/workflow-timeline/workflowRunSettings.js";
import { useDynamicWorkflowAvailability } from "@/hooks/useDynamicWorkflowAvailability.js";
import { useWorkflowRunJournalSummaries } from "@/hooks/useWorkflowRunJournalSummaries.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { ConversationSelectionReference } from "@/lib/conversationSelectionReference.js";
import {
  clearConversationSelectionReferenceScope,
  dispatchConversationSelectionAdd,
} from "@/lib/conversationSelectionReference.js";
import {
  clearSelectionSideChat,
  createSelectionSideChat,
  registerSelectionSideChatOpener,
} from "@/lib/selectionSideChatRuntime.js";
import { resolveSelectionSideInheritedModel } from "@/lib/selectionSideInheritedModel.js";
import type {
  OpenPlanDetailSideTabRequest,
  OpenScopedPlanDetailSideTabRequest,
  OpenScopedSubagentDirectorySideTabRequest,
  OpenScopedSubagentSideTabRequest,
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  OpenSelectionSideChatRequest,
  OpenSubagentSideTabRequest,
  OpenWorkflowActorSessionSideTabRequest,
  OpenWorkflowArtifactSideTabRequest,
  OpenWorkflowRunDirectorySideTabRequest,
  OpenWorkflowRunSideTabRequest,
  OpenWorkflowWorkspaceSideTabRequest,
} from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import { normalizeSlashCommandValue, shouldOfferSideSlashCommand } from "@/slashCommandHelpers.js";
import type { AppSlashCommand } from "@/slashCommandHelpers.js";
import {
  hasChatLoadingBlockingActiveWork,
  hasChatLoadingBlockingInteraction,
} from "@/v4/chatLoadingVisibility.js";
import type { ConversationStoreState } from "@/v4/conversationProjectionStore.js";
import type { ConversationStatusPanelWorkflowRunTarget } from "@/v4/conversationStatusPanelModel.js";
import type { SessionPaneDispatchCommand, SessionPaneSendText } from "@/v4/session-pane/helpers.js";
import type { ConversationPromptTelemetrySeed } from "@/v4/telemetry/conversationTelemetrySupervisor.js";
import { buildWorkflowDraftByToolCallId } from "@/v4/workflowDraftJoin.js";
import {
  buildWorkflowFillGraphByRunId,
  buildWorkflowGraphByToolCallId,
  buildWorkflowRunByRunId,
  buildWorkflowRunByToolCallId,
  buildWorkflowRunPendingQuestionsByRunId,
  buildWorkflowSaveCandidatesByRunId,
} from "@/v4/workflowRunCardJoin.js";
import {
  WORKFLOW_RUN_DIRECTORY_LIMIT,
  countEndedWorkflowRuns,
  workflowRunDirectoryRefreshKey,
} from "@/v4/workflowRunDirectoryModel.js";
import type { IZCodeSessionService, ModelSelectionView } from "@zcode/services";
import type { ModelSelection, ZCodeSlashCommand } from "@zcode/shared";
import type { CommandAck, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { RefObject } from "react";

export interface UseSessionPaneSideTabsParams {
  sessionId: string | null;
  rootSessionId: string | undefined;
  readOnly: boolean;
  allowWorkspaceFileRewind: boolean;
  selectionSideChat: boolean;
  activeSelectionSideChatSessionId: string | null;
  workspacePath: string;
  workspaceIdentity: string | undefined;
  remoteSessionId: string | null | undefined;
  compactForRemoteControl: boolean;
  focused: boolean;
  onOpenSubagentSession: ((request: OpenScopedSubagentSideTabRequest) => void) | undefined;
  onOpenSubagentDirectory:
    | ((request: OpenScopedSubagentDirectorySideTabRequest) => void)
    | undefined;
  onOpenSelectionSideChat: ((request: OpenSelectionSideChatRequest) => void) | undefined;
  onOpenPlanDetail: ((request: OpenScopedPlanDetailSideTabRequest) => void) | undefined;
  onOpenWorkflowRun: ((request: OpenScopedWorkflowRunSideTabRequest) => void) | undefined;
  onOpenWorkflowArtifact: ((request: OpenScopedWorkflowArtifactSideTabRequest) => void) | undefined;
  onOpenWorkflowRunDirectory:
    | ((request: OpenScopedWorkflowRunDirectorySideTabRequest) => void)
    | undefined;
  onOpenWorkflowActorSession:
    | ((request: OpenScopedWorkflowActorSessionSideTabRequest) => void)
    | undefined;
  onOpenWorkflowWorkspace:
    | ((request: OpenScopedWorkflowWorkspaceSideTabRequest) => void)
    | undefined;
  zcodeSessionService: IZCodeSessionService;
  intl: IntlInstance;
  slashCommands: Array<ZCodeSlashCommand>;
  state: ConversationStoreState;
  snapshot: ConversationSnapshot | null;
  runtimeReady: boolean;
  isMobileTextInputViewport: boolean;
  snapshotRef: RefObject<ConversationSnapshot | null>;
  workspaceKey: string;
  blockingInteractionId: string | null;
  selectionSideChatKey: string | null;
  selectionSideActionBlocked: boolean;
  handleDraftSwitchMode: (mode: string) => void;
  modelSelectionView: ModelSelectionView | null;
  recommendStartPlan: (selection: ModelSelection) => Promise<ModelSelection | null>;
  dispatchCommand: SessionPaneDispatchCommand;
}

export function useSessionPaneSideTabs(params: UseSessionPaneSideTabsParams) {
  const {
    sessionId,
    rootSessionId,
    readOnly,
    allowWorkspaceFileRewind,
    selectionSideChat,
    activeSelectionSideChatSessionId,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    compactForRemoteControl,
    focused,
    onOpenSubagentSession,
    onOpenSubagentDirectory,
    onOpenSelectionSideChat,
    onOpenPlanDetail,
    onOpenWorkflowRun,
    onOpenWorkflowArtifact,
    onOpenWorkflowRunDirectory,
    onOpenWorkflowActorSession,
    onOpenWorkflowWorkspace,
    zcodeSessionService,
    intl,
    slashCommands,
    state,
    snapshot,
    runtimeReady,
    isMobileTextInputViewport,
    snapshotRef,
    workspaceKey,
    blockingInteractionId,
    selectionSideChatKey,
    selectionSideActionBlocked,
    handleDraftSwitchMode,
    modelSelectionView,
    recommendStartPlan,
    dispatchCommand,
  } = params;

  const handleOpenSubagentSession = useCallback(
    (request: OpenSubagentSideTabRequest) => {
      onOpenSubagentSession?.({
        ...request,
        rootSessionId: request.rootSessionId ?? rootSessionId ?? request.parentSessionId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenSubagentSession, remoteSessionId, rootSessionId, workspaceIdentity, workspacePath],
  );
  const handleOpenSubagentDirectory = useCallback(
    (request: import("@/lib/workspaceSidePane.js").OpenSubagentDirectorySideTabRequest) => {
      if (compactForRemoteControl) return;
      onOpenSubagentDirectory?.({
        ...request,
        rootSessionId: request.rootSessionId ?? rootSessionId ?? request.parentSessionId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [
      compactForRemoteControl,
      onOpenSubagentDirectory,
      remoteSessionId,
      rootSessionId,
      workspaceIdentity,
      workspacePath,
    ],
  );
  const handleOpenPlanDetail = useCallback(
    (request: OpenPlanDetailSideTabRequest) => {
      onOpenPlanDetail?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenPlanDetail, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // 与 plan-detail 完全同构：卡片只发意图（runId + toolCallId + 展示名），
  // 会话与 workspace 身份一律由宿主（这里）补齐，卡片不感知 scope。
  const handleOpenWorkflowRun = useCallback(
    (request: OpenWorkflowRunSideTabRequest) => {
      onOpenWorkflowRun?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowRun, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // 药丸 → 子代理 transcript：与 plan-detail / workflow-run 同构，卡片只交出实例身份，scope 在这里补。
  const handleOpenWorkflowActorSession = useCallback(
    (request: OpenWorkflowActorSessionSideTabRequest) => {
      onOpenWorkflowActorSession?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowActorSession, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // 脚本药丸同构：卡片交出 run + 发起行 + 阶段，scope 在这里补。
  const handleOpenWorkflowWorkspace = useCallback(
    (request: OpenWorkflowWorkspaceSideTabRequest) => {
      onOpenWorkflowWorkspace?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowWorkspace, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // 产物 chip 与 run 详情同构：卡片/通知行只发意图，scope 由这里补齐。
  const handleOpenWorkflowArtifact = useCallback(
    (request: OpenWorkflowArtifactSideTabRequest) => {
      onOpenWorkflowArtifact?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowArtifact, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // 工具卡 → workflow run 的关联表。权威来源是 workflowRuns 投影里每条 run 的 toolCallId
  // （schema 注释就写着它是「工具卡 → 详情页的关联键」）；工具行自己的 output 在 v4 下
  // 只剩 formatCreateWorkflowModelContent 挑出的那句散文，结构化字段拿不到。
  //
  // 值不只是 runId：run 态的卡片本身要渲染状态词与步数，所以联接一次就把摘要算完
  // （计数规则见 buildWorkflowRunByToolCallId，它的单测穷举 settled / observed 语义）。
  // 重启后投影不再为空：CLI 冷物化把 journal 回放进同一个 reducer，
  // 卡片 join 只读投影，不再合并发现查询。发现查询在这里只剩一个用途——
  //
  // `limit` 与 `refreshKey` 服务的是任务列表那条「已结束的工作流 · N」页脚行：
  // - 深度取 run 目录页的同一个常量，否则页脚行的计数与页面上的行会是两套口径；
  // - 触发器取**同一个派生函数**（run 数 + 已结算数），所以页脚行与它开出来的目录页新鲜度一致；
  //   接投影的 `revision` 则会把一次分页读变成一条跟着节点事件走的流。
  const workflowRunJournalSummaries = useWorkflowRunJournalSummaries({
    sessionId,
    // Bug 根因（2026-08-24 实测）：嵌套只读 transcript（dwf actor / subagent）也是 SessionPane，
    // 无差别发这条查询等于拿子会话 id 去问一条按**父会话**建键的 journal；CLI 的冷会话前置
    // 随即为正在运行的 detached actor 会话物化第二个 runtime（幽灵），双写事件日志，
    // 直播冻结在「已工作 xx 秒」。只读 pane 也不消费 join 回退与任务列表页脚，直接关掉。
    enabled: !readOnly && runtimeReady,
    live: state.status === "live" && runtimeReady,
    limit: WORKFLOW_RUN_DIRECTORY_LIMIT,
    refreshKey: workflowRunDirectoryRefreshKey(snapshot?.workflowRuns?.runs),
  });
  const endedWorkflowRunCount = useMemo(
    () => countEndedWorkflowRuns(workflowRunJournalSummaries),
    [workflowRunJournalSummaries],
  );
  const workflowRunByToolCallId = useMemo(
    () => buildWorkflowRunByToolCallId(snapshot?.workflowRuns?.runs),
    [snapshot?.workflowRuns],
  );
  // runId 键的同源表：ResumeWorkflowRun 工具行的联接入口（display 带 runId，投影的
  // toolCallId 跨 resume 沿用原始 CreateWorkflow 行，resume 行按 toolCallId 查不到）。
  const workflowRunByRunId = useMemo(
    () => buildWorkflowRunByRunId(snapshot?.workflowRuns?.runs),
    [snapshot?.workflowRuns],
  );
  // 发起 toolCallId → 静态图：图是 run 的属性，
  // 三种来源的轮尾 run 卡都到这一张表取图。行窗口一遍建成，随窗口重建。
  const workflowGraphByToolCallId = useMemo(
    () => buildWorkflowGraphByToolCallId(snapshot?.rows.window),
    [snapshot?.rows.window],
  );
  // runId → 最新补全的有效脚本图（docs/dynamic-workflow/presentation.md「Holes on the timeline」）：补全之后
  // run 卡与侧板取它。行窗口一遍建成，随窗口重建。
  const workflowFillGraphByRunId = useMemo(
    () => buildWorkflowFillGraphByRunId(snapshot?.rows.window),
    [snapshot?.rows.window],
  );
  // 工作流工具行 → 草稿位置：稿号与
  // 「后面还有更新的一稿」都只能从行序读出，行窗口一遍建成，随窗口重建。
  const workflowDraftByToolCallId = useMemo(
    () => buildWorkflowDraftByToolCallId(snapshot?.rows.window),
    [snapshot?.rows.window],
  );
  // runId → 转写里认领过它的 SaveWorkflow 候选（docs/dynamic-workflow/transcript-and-notifications.md
  // 「Which workflow a run is saved as」规则 1）。行窗口一遍建成，随窗口重建。
  const workflowSaveCandidatesByRunId = useMemo(
    () => buildWorkflowSaveCandidatesByRunId(snapshot?.rows.window),
    [snapshot?.rows.window],
  );
  // Workflow 通知 manifest 的升级条目 Waiting→Answered 联查表（runId → 停驻 qid 集合）。
  const workflowRunPendingQuestionsByRunId = useMemo(
    () => buildWorkflowRunPendingQuestionsByRunId(snapshot?.workflowRuns?.runs),
    [snapshot?.workflowRuns],
  );
  // 详情页入口（面板 Workflows 分区的行）。行只把「打开哪个 run」交出来（runId + toolCallId），
  // 会话与 workspace 身份照旧由这里补齐——与工具卡走的是同一个 handler，不存在第二条打开路径。
  const handleOpenWorkflowRunFromPanel = useCallback(
    (target: ConversationStatusPanelWorkflowRunTarget) => {
      if (!sessionId) return;
      handleOpenWorkflowRun({ ...target, parentSessionId: sessionId });
    },
    [handleOpenWorkflowRun, sessionId],
  );
  // run 目录页的入口（同一条页脚行）。同样只补 scope，不在这里多造一条打开路径。
  const handleOpenWorkflowRunDirectoryFromPanel = useCallback(
    (request: OpenWorkflowRunDirectorySideTabRequest) => {
      onOpenWorkflowRunDirectory?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowRunDirectory, remoteSessionId, workspaceIdentity, workspacePath],
  );
  const handleAddSelectionToCurrentTask = useCallback(
    (reference: ConversationSelectionReference) => {
      if (!sessionId) return;
      dispatchConversationSelectionAdd({
        targetSessionId: sessionId,
        workspaceKey,
        reference,
      });
    },
    [sessionId, workspaceKey],
  );
  const handleOpenSelectionSideConversation = useCallback(
    async (reference?: ConversationSelectionReference, forceNew = false) => {
      if (!sessionId || !selectionSideChatKey || !onOpenSelectionSideChat) return;
      try {
        let targetChildSessionId = reference && !forceNew ? activeSelectionSideChatSessionId : null;
        let replacesChildSessionId: string | undefined;
        if (targetChildSessionId) {
          try {
            await zcodeSessionService.readSession({
              workspacePath,
              ...(workspaceIdentity ? { workspaceIdentity } : {}),
              sessionId: targetChildSessionId,
              messageLimit: 1,
            });
          } catch (error) {
            if (!String(error).includes("sessionNotFound")) throw error;
            // 多开后 tab id 包含 child，旧单例实现依靠新 child 覆盖同一个父 tab
            // 来移除失效项已不成立。这里显式携带 replacesChildSessionId，让宿主原子删旧开新。
            replacesChildSessionId = targetChildSessionId;
            clearSelectionSideChat(targetChildSessionId);
            clearConversationSelectionReferenceScope(targetChildSessionId, workspaceKey);
            targetChildSessionId = null;
          }
        }

        if (targetChildSessionId) {
          onOpenSelectionSideChat({
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            ...(remoteSessionId ? { remoteSessionId } : {}),
            parentSessionId: sessionId,
            childSessionId: targetChildSessionId,
          });
          if (reference) {
            dispatchConversationSelectionAdd({
              targetSessionId: targetChildSessionId,
              workspaceKey,
              reference,
            });
          }
          return;
        }

        const childSessionId = await createSelectionSideChat(selectionSideChatKey, async () => {
          const ack = await dispatchCommand("createSelectionSideSession", {}, sessionId);
          if (
            (ack.status !== "accepted" && ack.status !== "duplicate") ||
            ack.result?.type !== "createSelectionSideSession"
          ) {
            throw new Error(ack.reasonCode ?? "createSelectionSideSession 被拒绝");
          }
          return ack.result.sessionId;
        });
        onOpenSelectionSideChat({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          parentSessionId: sessionId,
          childSessionId,
          ...(replacesChildSessionId ? { replacesChildSessionId } : {}),
        });
        if (reference) {
          dispatchConversationSelectionAdd({
            targetSessionId: childSessionId,
            workspaceKey,
            reference,
          });
        }
      } catch (error) {
        logger.warn("[v4-pane] 创建框选副屏会话失败", {
          error: error instanceof Error ? error.message : String(error),
          parentSessionId: sessionId,
          workspaceKey,
        });
      }
    },
    [
      activeSelectionSideChatSessionId,
      dispatchCommand,
      onOpenSelectionSideChat,
      remoteSessionId,
      selectionSideChatKey,
      sessionId,
      workspaceIdentity,
      workspaceKey,
      workspacePath,
      zcodeSessionService,
    ],
  );

  const handleOpenSelectionSideConversationWithPrompt = useCallback(
    async (text: string, telemetrySeed?: ConversationPromptTelemetrySeed): Promise<boolean> => {
      if (!sessionId || !selectionSideChatKey || !onOpenSelectionSideChat) {
        throw new Error("selection side chat is unavailable");
      }
      const inherited = resolveSelectionSideInheritedModel(
        snapshotRef.current?.config,
        modelSelectionView,
      );
      const chosen = inherited ? await recommendStartPlan(inherited) : undefined;
      if (chosen === null) return false;
      const modelSelection = chosen && chosen !== inherited ? chosen : undefined;
      // 参数命令每次都是新 child；同一条文本在 ACK 未回时重试仍复用 pending，
      // 不同文本则不能与 bare `/side` 或另一条 prompt 合并。
      const pendingKey = `${selectionSideChatKey}\u0000prompt\u0000${text}`;
      const childSessionId = await createSelectionSideChat(pendingKey, async () => {
        const ack = await dispatchCommand(
          "createSelectionSideSession",
          { firstInput: { text, ...(modelSelection ? { modelSelection } : {}) } },
          sessionId,
          undefined,
          undefined,
          telemetrySeed,
        );
        if (
          (ack.status !== "accepted" && ack.status !== "duplicate") ||
          ack.result?.type !== "createSelectionSideSession"
        ) {
          throw new Error(ack.reasonCode ?? "createSelectionSideSession 被拒绝");
        }
        return ack.result.sessionId;
      });
      onOpenSelectionSideChat({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
        parentSessionId: sessionId,
        childSessionId,
      });
      return true;
    },
    [
      dispatchCommand,
      modelSelectionView,
      recommendStartPlan,
      onOpenSelectionSideChat,
      remoteSessionId,
      selectionSideChatKey,
      sessionId,
      workspaceIdentity,
      workspacePath,
    ],
  );

  useEffect(() => {
    if (
      !selectionSideChatKey ||
      !sessionId ||
      readOnly ||
      selectionSideChat ||
      isMobileTextInputViewport ||
      !onOpenSelectionSideChat
    ) {
      return;
    }

    // Side Pane 固定入口没有会话 Provider；这里只注册主 pane 已有的命令编排能力。
    // 父会话即使处于 Permission/AskUser 等阻塞态也保持注册，直接入口仍可创建/激活副屏。
    return registerSelectionSideChatOpener(
      selectionSideChatKey,
      // 合并时曾丢弃 reference，导致 Markdown 入口只建空白副屏；复用现有引用路由。
      (reference) => handleOpenSelectionSideConversation(reference, !reference),
      focused,
      Boolean(blockingInteractionId) || selectionSideActionBlocked,
    );
  }, [
    blockingInteractionId,
    selectionSideActionBlocked,
    focused,
    handleOpenSelectionSideConversation,
    isMobileTextInputViewport,
    onOpenSelectionSideChat,
    readOnly,
    selectionSideChat,
    selectionSideChatKey,
    sessionId,
  ]);

  const cliSlashCommandNames = useMemo(
    () =>
      new Set(
        (slashCommands ?? []).map((command) =>
          normalizeSlashCommandValue(command.name).toLowerCase(),
        ),
      ),
    [slashCommands],
  );
  const availableSelectionSideSlashCommandNames = useMemo(
    () => ["side", "btw"].filter((name) => !cliSlashCommandNames.has(name)),
    [cliSlashCommandNames],
  );

  // Plan 选中即开启标准 Composer 开关，不能等发送时解析文本；与 /side 共用本地操作入口。
  const appSlashCommands = useMemo<AppSlashCommand[] | undefined>(() => {
    if (readOnly) return undefined;
    const planAction: AppSlashCommand = {
      value: "plan",
      label: intl.formatMessage({ id: "chat.slash.app.plan.label" }),
      description: intl.formatMessage({ id: "chat.slash.app.plan.description" }),
      keywords: ["plan", "计划", "计划模式"],
      run: () => handleDraftSwitchMode("plan"),
    };
    if (
      !sessionId ||
      !onOpenSelectionSideChat ||
      !shouldOfferSideSlashCommand({
        isDraft: sessionId === null,
        selectionSideChat,
        readOnly,
        isMobileViewport: isMobileTextInputViewport,
      })
    ) {
      return [planAction];
    }
    const openNewSelectionSideChat = () => {
      void handleOpenSelectionSideConversation(undefined, true);
    };
    // 关键词固定同时包含中英文别名，任一 locale 下输入 side / btw / 辅助 都能搜到。
    // `/btw` 是 `/side` 的等价别名，适配不同用户输入习惯，面板中各自独立展示。
    const sharedKeywords = ["side", "btw", "side chat", "auxiliary", "辅助对话", "辅助", "侧边"];
    const description = intl.formatMessage({ id: "chat.slash.app.side.description" });
    return [
      planAction,
      ...[
        { value: "side", description, keywords: sharedKeywords, run: openNewSelectionSideChat },
        { value: "btw", description, keywords: sharedKeywords, run: openNewSelectionSideChat },
      ].filter((command) => !cliSlashCommandNames.has(command.value)),
    ];
  }, [
    cliSlashCommandNames,
    handleDraftSwitchMode,
    handleOpenSelectionSideConversation,
    intl,
    isMobileTextInputViewport,
    onOpenSelectionSideChat,
    readOnly,
    selectionSideChat,
    sessionId,
  ]);

  const chatLoadingBlockedByInteraction = hasChatLoadingBlockingInteraction(
    snapshot?.pendingInteractions ?? [],
  );
  const chatLoadingBlockedByActiveWork = hasChatLoadingBlockingActiveWork(
    snapshot?.control.activeWorks ?? [],
  );
  // 子智能体详情的会话内容仍只读；文件撤销恢复的是 workspace，必须作为独立能力判断。
  const workspaceFileRewindEnabled = !readOnly || allowWorkspaceFileRewind;
  // cancelBackgroundWork：启动卡 / 后台任务卡的「取消」入口。定义在 rowContext memo 之前，
  // 供其绑定（onOpenWorkflowRun 同样在 memo 前定义）；只读模式下不下发（与 4213 处一致）。
  const handleCancelBackgroundWork = useCallback(
    (workId: string) => {
      if (!sessionId) return;
      void dispatchCommand("cancelBackgroundWork", { workId }, sessionId).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(
            `[v4-pane] cancelBackgroundWork 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`,
          );
        }
      });
    },
    [dispatchCommand, sessionId],
  );

  const handleRespondOpenCodePermission = useCallback(
    async (params: {
      commandId: string;
      runId: string;
      opencodeSessionId: string;
      requestId: string;
      optionId: string;
    }) => {
      if (!sessionId || params.commandId !== params.runId) {
        throw new Error("OpenCode permission run identity is unavailable");
      }
      const ack = await dispatchCommand("respondToOpenCodePermission", params, sessionId);
      if (ack.status !== "accepted") {
        throw new Error(ack.reasonCode ?? "OpenCode permission response was rejected");
      }
    },
    [dispatchCommand, sessionId],
  );

  // 动态工作流灰度快照：只读 store，
  // 取数在 Root 里做一次。未就绪时 enabled 为 false，按未命中处理。
  const { enabled: dynamicWorkflowEnabled } = useDynamicWorkflowAvailability();

  // resumeWorkflowRun：工具卡页脚的 Resume。与详情页
  // 同一条 v4 命令，不携 baseRevision；`name` 喂恢复后完成通知的主题。
  const handleResumeWorkflowRun = useCallback(
    (workId: string, name?: string) => {
      if (!sessionId) return;
      void dispatchCommand(
        "resumeWorkflowRun",
        { workId, ...(name ? { name } : {}) },
        sessionId,
      ).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(`[v4-pane] resumeWorkflowRun 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
        }
      });
    },
    [dispatchCommand, sessionId],
  );

  // amendWorkflowRunSettings：run 卡的「配置」。回 ACK 给弹层——拒绝理由画在弹层里，不是控制台的一行 warn。门与 Resume 相同。
  const handleAmendWorkflowRunSettings = useCallback(
    (workId: string, change: WorkflowRunSettingsChange): Promise<CommandAck> =>
      dispatchCommand("amendWorkflowRunSettings", { workId, ...change }, sessionId),
    [dispatchCommand, sessionId],
  );
  const workflowSessionModel = useMemo(
    () => workflowSessionModelOf(snapshot?.sessionId === sessionId ? snapshot?.config : undefined),
    [sessionId, snapshot?.config, snapshot?.sessionId],
  );

  /**
   * 「让 ZCode 帮我提炼保存」那条用户消息的发送口（docs/dynamic-workflow/transcript-and-notifications.md
   * 「The message the lead sends」）：与中枢的「提升为全局」同一条先例——GUI 写、自动发、用户不再确认。
   *
   * 经 ref 转一手而不是直接引 `handleSendText`：后者定义在本文件更下面，而 rowContext 的 memo
   * 工厂在**同一次渲染里**就会跑到，直接引会落进 TDZ。ref 在渲染中赋值，点击总在挂载之后。
   */
  const sendTextRef = useRef<SessionPaneSendText | null>(null);
  const handleSendWorkflowSaveRequest = useCallback(async (text: string) => {
    const send = sendTextRef.current;
    if (send === null) throw new Error("send path not mounted");
    const result = await send(text);
    // 被挡下（会话忙着确认别的、队列暂停待确认）就不是「已交给 ZCode」：抛回弹层，让它留在原处。
    if (result !== "sent") throw new Error(`workflow save request not sent: ${result}`);
  }, []);

  return {
    handleOpenSubagentSession,
    handleOpenSubagentDirectory,
    handleOpenPlanDetail,
    handleOpenWorkflowRun,
    handleOpenWorkflowActorSession,
    handleOpenWorkflowWorkspace,
    handleOpenWorkflowArtifact,
    endedWorkflowRunCount,
    workflowRunByToolCallId,
    workflowRunByRunId,
    workflowGraphByToolCallId,
    workflowFillGraphByRunId,
    workflowDraftByToolCallId,
    workflowSaveCandidatesByRunId,
    workflowRunPendingQuestionsByRunId,
    handleOpenWorkflowRunFromPanel,
    handleOpenWorkflowRunDirectoryFromPanel,
    handleAddSelectionToCurrentTask,
    handleOpenSelectionSideConversation,
    handleOpenSelectionSideConversationWithPrompt,
    availableSelectionSideSlashCommandNames,
    appSlashCommands,
    chatLoadingBlockedByInteraction,
    chatLoadingBlockedByActiveWork,
    workspaceFileRewindEnabled,
    handleCancelBackgroundWork,
    handleRespondOpenCodePermission,
    dynamicWorkflowEnabled,
    handleResumeWorkflowRun,
    handleAmendWorkflowRunSettings,
    workflowSessionModel,
    sendTextRef,
    handleSendWorkflowSaveRequest,
  };
}
