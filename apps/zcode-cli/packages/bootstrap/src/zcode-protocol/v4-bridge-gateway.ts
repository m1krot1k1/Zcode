// ConversationV4Gateway 的宿主钩子装配：帧出口、hydration、sessions-index 种子、
// 命令执行/准入、附件、dynamic workflow 读面与错误上报。
import {
  isReadonlyAgentSessionKind,
  parseRemoteWorkspaceIdentity,
  zcodeOpenCodeAgentRunRequestSchema,
  zcodeOpenCodeAgentRunResultSchema,
  zcodeProtocolMethods,
} from "@zcode/shared";
import { V4_NOTIFICATIONS } from "@zcode/shared/zcode-protocol-v4";
import type { CommandPayloadMap } from "@zcode/shared/zcode-protocol-v4";
import { createExternalTurnFaultError } from "@zcode/core";
import type { SessionId } from "@zcode/contracts";
import { V4CapabilityUnsupportedError } from "../zcode-protocol-v4/commands/handlers/interaction-background.js";
import { buildColdFileChangeSummaries } from "../zcode-protocol-v4/cold-file-change-summaries.js";
import {
  loadPersistedConversationMaterialization,
  mergeColdConversationEvents,
} from "../zcode-protocol-v4/cold-event-merge.js";
import { lookupGlobalCreateSessionCommand } from "../zcode-protocol-v4/create-session-command-fact.js";
import type { V4CommandCoreHost } from "../zcode-protocol-v4/commands/types.js";
import {
  V4CommandNotImplementedError,
  type V4GatewayHost,
} from "../zcode-protocol-v4/v4-gateway.js";
import { isTaskListSessionType } from "../zcode-protocol-v4/task-list-session-membership.js";
import { readBackgroundBashOutputFromOwner } from "./background-work-owner.js";
import { cloneModelSelection } from "./fork-model-selection.js";
import { buildLiveWorkspaceConfigStateV4 } from "./v4-workspace-config.js";
import { resolveSessionModelContextWindow } from "./workspace-model-runtime.js";
import { listSessionSubagents, readSessionContextUsage } from "./server-operations.js";
import {
  isConversationInputAdmissionCommand,
  settleOpenCodeStartFailure,
} from "./v4-bridge-admission.js";
import { persistHighspeedTimingOnTurnTerminal } from "./v4-bridge-highspeed.js";
import {
  readConversationFileChanges,
  previewConversationFileRewind,
  replayDynamicWorkflowRunEvents,
  replayOpenCodeAgentRunEvents,
  resolveConversationBackingRecord,
} from "./v4-bridge-hydration.js";
import { autoDrainV4QueueIfReady } from "./v4-bridge-queue.js";
import {
  createSessionLoading,
  normalizeStoredTitleSource,
  sessionUsageSeedFromRuntimeContextUsage,
} from "./v4-bridge-sessions.js";
import type { BridgeState } from "./v4-bridge-state.js";

export function createGatewayHost(state: BridgeState, coreHost: V4CommandCoreHost): V4GatewayHost {
  const { context, log, persistentCommands } = state;
  const { loadStoredSessionSummaries, refreshLegacySessionSummaries, resumePersistedSession } =
    createSessionLoading(state);
  return {
    cliVersion: context.deps.version,
    sessionExists: (sessionId) => context.sessions.has(sessionId),
    reconcileSessions: async ({ workspaceId, sessionIds }) => {
      const store = context.deps.sessionStore;
      if (!store) throw new Error("Session store is unavailable");
      const remote = parseRemoteWorkspaceIdentity(workspaceId);
      const directory = remote?.workspacePath ?? workspaceId;
      const sessions = await Promise.all(
        [...new Set(sessionIds)].map(async (sessionId) => {
          const session = await store.getSession(sessionId as SessionId);
          const sameWorkspace =
            session &&
            session.directory === directory &&
            (remote
              ? session.workspaceID === workspaceId
              : !session.workspaceID || session.workspaceID === workspaceId);
          if (!sameWorkspace) return { sessionId, exists: false as const, deleted: false as const };
          return {
            sessionId,
            exists: true as const,
            deleted: session.time.deleted !== undefined,
            title: session.title,
            titleSource: normalizeStoredTitleSource(session.titleSource),
            createdAt: session.time.created,
            updatedAt: session.time.updated,
            ...(session.lastOutcome ? { lastOutcome: session.lastOutcome } : {}),
          };
        }),
      );
      return { sessions };
    },
    onDebug: (message) => log?.debug(message),
    onTargetCompleted: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return;
      // background task-notification 的 goal verifier 不经过 v4 prompt 的
      // finally/afterLegacyStateMutation；TargetChanged(complete) 虽已提交，future queue
      // 因而没有下一次 mutation 来重评。这里只 detached 触发既有 gate，不能阻塞投影。
      void Promise.resolve()
        .then(() => autoDrainV4QueueIfReady(state, record))
        .catch((error: unknown) => {
          context.logger?.warn("v4 auto-drain reevaluation after target completion failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          });
        });
    },
    onHighspeedTurnTerminal: (sessionId, event, snapshot) => {
      persistHighspeedTimingOnTurnTerminal(context, sessionId, event, snapshot);
    },
    // Gateway 的单一 READY promise 负责并发与水位；binder 只恢复 runtime 并返回 M0/M1。
    retainSessionRuntime: async (sessionId) =>
      (await context.sessionResidentPool?.acquireOperation(sessionId)) ?? (() => undefined),
    loadPersistedMessages: async (sessionId) => {
      const store = context.deps.sessionStore;
      if (!store || !(await store.getSession(sessionId as SessionId)))
        throw new Error("fault.subscribe.sessionNotFound");
      return store.messages({ sessionID: sessionId as SessionId });
    },
    resumePersistedSession,
    emitWireFrame: (wire) =>
      context.notify({
        method: V4_NOTIFICATIONS.conversationFrame,
        params: wire,
      }),
    emitLocalTtftFacts: (facts) =>
      context.notify({ method: V4_NOTIFICATIONS.localTtftFacts, params: facts }),
    emitConversationTelemetryFact: (fact) =>
      context.notify({
        method: V4_NOTIFICATIONS.conversationTelemetryFact,
        params: fact,
      }),
    emitPluginUiToolResult: (result) =>
      context.notify({ method: V4_NOTIFICATIONS.pluginUiToolResult, params: result }),
    emitCuaPermissionObservation: (observation) =>
      context.notify({
        method: V4_NOTIFICATIONS.cuaPermissionObservation,
        params: observation,
      }),
    // ── config 种子：投影初值 = runtime 真值 ─────────────
    // 覆盖三个种子来源：启动缺省（Workspace 模型偏好 + 项目持久化 mode）、
    // createSession.config（handler 先应用到 runtime 再种）、历史会话 resume
    // （App 恢复结果可以只有模型身份，不能为了投影而绑定半成品执行模型）。
    getSessionMemoryEnabled: (sessionId) => context.sessions.get(sessionId)?.memoryEnabled,
    getSessionConfigSeed: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      const selection =
        record.app.runtime.getSessionModelSelection() ?? record.restoredModelSelection;
      return {
        modelSelection: cloneModelSelection(selection),
        provider: selection?.providerId ?? "",
        model: selection?.modelId ?? "",
        thought: selection?.options?.reasoningLevel ?? "",
        thoughtLevels: selection
          ? (record.app
              .listModels()
              .find(
                (model) =>
                  model.ref.providerId === selection.providerId &&
                  model.ref.modelId === selection.modelId,
              )
              ?.reasoning?.levels.map((level) => level.value) ?? [])
          : [],
        mode: record.app.getMode(),
        planEnabled: record.app.runtime.getPlanEnabled(),
        ...(record.app.runtime.lastPermissionGrantId
          ? { permissionGrant: { interactionId: record.app.runtime.lastPermissionGrantId } }
          : {}),
      };
    },
    getSessionUsageSeed: async (sessionId, persistedMessages) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      const contextUsage = await readSessionContextUsage(context, sessionId, persistedMessages);
      // usage seed 会在 hydration 后再次覆盖首帧分母；必须与合成事件
      // 使用同一份当前模型 registry 真值，不能把旧 runtime projection 的窗口写回来。
      return sessionUsageSeedFromRuntimeContextUsage(
        contextUsage,
        resolveSessionModelContextWindow(context, record),
      );
    },
    // ── sessions-index hooks（workspace 分桶 + 冷启动 store 种子）──────────
    getSessionWorkspaceId: (sessionId) => {
      const record = context.sessions.get(sessionId);
      return !record || !isTaskListSessionType(record.taskType)
        ? null
        : record.workspace.workspaceKey;
    },
    getSessionIndexMeta: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      return {
        createdAt: record.createdAt,
        lastActivityAt: record.updatedAt,
        ...(record.lastOutcome ? { lastOutcome: record.lastOutcome } : {}),
        ...(record.parentSessionId ? { parentSessionId: String(record.parentSessionId) } : {}),
      };
    },
    listWorkspaceSessionIds: (workspaceId) =>
      [...context.sessions.values()]
        .filter(
          (record) =>
            isTaskListSessionType(record.taskType) && record.workspace.workspaceKey === workspaceId,
        )
        .map((record) => record.app.sessionId),
    // draft 判定：deferred = 未发首条输入（prompt-turn 首发提升为 immediate）。
    // 旧 workspace prepare 预建的 deferred 会话不得以「新任务」漏进侧栏列表。
    isDraftSession: (sessionId) => context.sessions.get(sessionId)?.persistence === "deferred",
    // ── workspace-config hook（配置目录订阅种子；live session 快路径，避免临时 app）──
    getWorkspaceConfig: (workspaceId) => buildLiveWorkspaceConfigStateV4(context, workspaceId),
    getStoredSessionSummaries: loadStoredSessionSummaries,
    refreshLegacySessionSummaries,
    // 回落面已清零（20 命令全部原生）：supports 未命中（未知命令类型）→
    // notImplemented → ACK failed fault.command.notImplemented。
    executeCommand: async (envelope, admission) => {
      if (
        envelope.type === "sendText" &&
        (envelope.payload as CommandPayloadMap["sendText"]).executionRoute?.kind === "opencode-acp"
      ) {
        const sessionStore = context.deps.sessionStore;
        if (!sessionStore?.getOpenCodeAgentRun || !sessionStore.transitionOpenCodeAgentRun) {
          throw Object.assign(new Error("OpenCode delegated run storage is unavailable"), {
            reasonCode: "fault.command.opencodeAgentAdmissionUnavailable",
          });
        }
        const sessionID = envelope.sessionId as SessionId;
        const runID = envelope.commandId;
        let run = await sessionStore.getOpenCodeAgentRun({ sessionID, runID });
        if (!run || run.commandID !== runID || run.inputID !== envelope.commandId) {
          throw Object.assign(new Error("Admitted OpenCode delegated run was not found"), {
            reasonCode: "fault.command.opencodeAgentAdmissionUnavailable",
          });
        }
        if (run.status === "pending") {
          const transitioned = await sessionStore.transitionOpenCodeAgentRun({
            sessionID,
            runID,
            expectedStatus: "pending",
            expectedEventSequence: run.eventSequence,
            eventSequence: run.eventSequence + 1,
            status: "dispatching",
          });
          if (!transitioned) {
            run = await sessionStore.getOpenCodeAgentRun({ sessionID, runID });
            if (!run || run.status !== "dispatching") {
              throw Object.assign(new Error("OpenCode delegated run lost its dispatch claim"), {
                reasonCode: "fault.command.opencodeAgentAdmissionUnavailable",
              });
            }
          } else {
            run = { ...run, status: "dispatching", eventSequence: run.eventSequence + 1 };
          }
        }
        if (run.status !== "dispatching" && run.status !== "running") {
          // Duplicate command delivery is idempotent; terminal runs are not restarted.
          return undefined;
        }
        const payload = envelope.payload as CommandPayloadMap["sendText"];
        const request = zcodeOpenCodeAgentRunRequestSchema.parse({
          protocolVersion: 1,
          zcodeSessionId: String(sessionID),
          commandId: run.commandID,
          runId: run.runID,
          operation: "startRun",
          text: payload.text,
          model:
            payload.executionRoute?.kind === "opencode-acp"
              ? payload.executionRoute.model
              : { kind: "default" },
        });
        try {
          const result = await context.requestClient(
            zcodeProtocolMethods.interactionRequestOpenCodeAgentRun,
            request,
            zcodeOpenCodeAgentRunResultSchema,
            { timeoutMs: 30_000 },
          );
          if (
            result.status !== "accepted" &&
            result.status !== "starting" &&
            result.status !== "running"
          ) {
            await settleOpenCodeStartFailure(sessionStore, sessionID, runID, result);
          }
        } catch (error) {
          // A lost RPC response is ambiguous: retain the durable dispatch state so a retry
          // uses the same idempotency key with Host instead of falsely claiming no run started.
          context.logger?.warn("OpenCode delegated run Host dispatch did not settle", {
            commandId: runID,
            sessionId: String(sessionID),
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        return undefined;
      }
      return state.nativeExecutor!.supports(envelope.type)
        ? state.nativeExecutor!.execute(envelope, admission)
        : Promise.reject(new V4CommandNotImplementedError(envelope.type));
    },
    admitCommandInput: async (envelope, admission) => {
      // 仅隐藏 composer 不能阻止旧 child 标签页续聊。类型准入必须早于
      // ledger/输入历史写入；detached child 没有 record 时只查元数据，不激活第二个 runtime。
      if (
        envelope.sessionId &&
        (isConversationInputAdmissionCommand(envelope.type) ||
          envelope.type === "resumeGoal" ||
          envelope.type === "sendQueuedNow" ||
          envelope.type === "forkAssistant" ||
          envelope.type === "createSelectionSideSession")
      ) {
        const taskType =
          context.sessions.get(envelope.sessionId)?.taskType ??
          (await context.deps.sessionStore?.getSession(envelope.sessionId as SessionId))?.taskType;
        if (isReadonlyAgentSessionKind(taskType)) {
          throw Object.assign(new Error("Subagent sessions are read-only"), {
            reasonCode: "guard.subagentReadOnly",
          });
        }
      }
      if (!isConversationInputAdmissionCommand(envelope.type)) return null;
      if (!envelope.sessionId) return null;
      return (await coreHost.admitInputCommand?.(envelope, envelope.sessionId, admission)) ?? null;
    },
    cancelCommandInput: async (envelope, queueItemId, reason) => {
      if (!envelope.sessionId) return;
      await coreHost.cancelInputCommand?.(envelope.sessionId, queueItemId, reason);
    },
    terminateTurnForProjectionFault: (sessionId, reasonCode) => {
      const record = context.sessions.get(sessionId);
      const controller = record?.activeAbortController;
      if (!controller || controller.signal.aborted) return;
      // 修复原因：投影越过 16MiB 后继续生成只会让所有后续 snapshot 都无法编码。
      // gateway 先原子拒绝越界事件并登记 protocol fault，再单次调用这里中止模型 turn；
      // abort 的正常终态负责释放 active lock，不能在 gateway 里越层伪造 TurnError。
      controller.abort(createExternalTurnFaultError(reasonCode));
    },
    // commands/query 持久化 fallback：同 session 首次查询惰性建索引，后续四个来源
    // 共用该索引；anchor/marker/child/discarded 写入走 record 增量更新。
    lookupTranscriptCommand: (key) =>
      key.sessionId === null
        ? lookupGlobalCreateSessionCommand(context.deps.sessionStore, key.commandId)
        : persistentCommands.lookup("transcript", key),
    lookupTimelineCommand: (key) => persistentCommands.lookup("timeline", key),
    lookupChildCommand: (key) => persistentCommands.lookup("child", key),
    lookupDiscardedCommand: (key) => persistentCommands.lookup("discarded", key),
    invalidatePersistentCommandFacts: (sessionId) => persistentCommands.invalidate(sessionId),
    // gateway 已完成逐片总量/checksum 校验，只把完整 bytes 原子写 artifact。
    putSessionAttachment: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.attachment.sessionNotFound: ${sessionId}`);
      }
      return record.app.writePromptAttachment(input);
    },
    readBackgroundBashOutput: (sessionId, workId) =>
      readBackgroundBashOutputFromOwner(context, sessionId, workId),
    readSessionAttachment: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.attachment.sessionNotFound: ${sessionId}`);
      }
      return record.app.readPromptAttachment(input);
    },
    statSessionAttachment: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.attachment.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.statPromptAttachment) {
        throw new Error("fault.attachment.statUnsupported");
      }
      return record.app.statPromptAttachment(input);
    },
    resolveSessionAttachmentPreviewSource: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.attachment.sessionNotFound: ${sessionId}`);
      }
      return record.app.resolvePromptAttachmentPreviewSource(input);
    },
    getConversationFileChanges: async (sessionId, _targetRowId, messageIds, targetTurnId) => {
      const record = await resolveConversationBackingRecord(context, sessionId);
      if (!record) {
        throw new Error(`fault.fileChanges.sessionNotFound: ${sessionId}`);
      }
      return readConversationFileChanges(record, sessionId, messageIds, targetTurnId);
    },
    // dwf 事件日志：能力在 app 上（run service 构造成功才有），缺席时不在这里兜底成空页——
    // gateway 会回结构化的能力不支持错误，让 renderer 能区分"没有事件"与"没有这个能力"。
    listDynamicWorkflowRunEvents: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunEvents.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRunEvents) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunEvents", sessionId);
      }
      // 经 app 调用（不可解构：实现可能依赖 this 绑定）。
      return record.app.listDynamicWorkflowRunEvents(input);
    },
    // workflow run 枚举：能力条件同上（run service 构造成功才有）。
    listDynamicWorkflowRuns: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRuns.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRuns) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRuns", sessionId);
      }
      // 经 app 调用（不可解构：实现可能依赖 this 绑定）。
      return record.app.listDynamicWorkflowRuns(input);
    },
    // dwf 用户面产物的三个读面：能力条件同上。
    // ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给用户看的产出，不是 run 的顶层返回值。
    listDynamicWorkflowRunArtifacts: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunArtifacts.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRunArtifacts) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunArtifacts", sessionId);
      }
      return record.app.listDynamicWorkflowRunArtifacts(input);
    },
    listDynamicWorkflowRunArtifactItems: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunArtifactData.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRunArtifactItems) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunArtifactItems", sessionId);
      }
      return record.app.listDynamicWorkflowRunArtifactItems(input);
    },
    readDynamicWorkflowRunArtifact: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunArtifactRead.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.readDynamicWorkflowRunArtifact) {
        throw new V4CapabilityUnsupportedError("readDynamicWorkflowRunArtifact", sessionId);
      }
      return record.app.readDynamicWorkflowRunArtifact(input);
    },
    // dwf 工作区 transcript 的两个读面：能力条件同上。
    listDynamicWorkflowRunWorkspaceNodes: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunWorkspace.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRunWorkspaceNodes) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunWorkspaceNodes", sessionId);
      }
      return record.app.listDynamicWorkflowRunWorkspaceNodes(input);
    },
    readDynamicWorkflowRunNodeResult: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunNodeResult.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.readDynamicWorkflowRunNodeResult) {
        throw new V4CapabilityUnsupportedError("readDynamicWorkflowRunNodeResult", sessionId);
      }
      return record.app.readDynamicWorkflowRunNodeResult(input);
    },
    previewConversationFileRewind: async (sessionId, _targetRowId, messageIds, targetTurnId) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.fileRewindPreview.sessionNotFound: ${sessionId}`);
      }
      return previewConversationFileRewind(record, messageIds, targetTurnId);
    },
    // 冷订阅不再在 eventStore / transcript 之间 XOR。message/part
    // 是已完成正文权威，session_entry 只补 legacy goal，内存事件只补
    // 未持久 in-flight 和 queue/permission/control 等 ephemeral 状态。
    loadPersistedEvents: async (sessionId, persistedMessages) => {
      // dwf workflow actor / subagent 这类 detached live child 没有自己的
      // bootstrap record（事件经 ingestDetachedLiveSession 走父 record 的 sink 路由）。
      // context.sessions.get 取不到 record 时不能直接返回 synthesized:false——
      // 否则首次订阅的 performHydration 会走"保留健康 live publisher"早退分支，
      // durable transcript 三源合并从不执行——只由 live 事件喂养的投影会丢掉所有
      // 不以 live 事件形式出现的持久正文。amend-resume 把前驱 transcript 前缀直接
      // 复制进 session store 来播种 actor 会话，
      // 这段前缀正属于此类，于是侧栏 actor transcript 只剩本次 live 增量；
      // 普通崩溃恢复后 warm 窗口同样看不到 crash 前的 actor 消息。
      // 改用 resolveConversationBackingRecord：child 自身没有 record 时按持久
      // parentID 落到父 record，只借它的共享 event/artifact store，事件读取仍显式用
      // child 自己的 sessionId（script workflow child runtime 共享父 event store，
      // 事件按 child sessionId 归档），因此 sourceEventSeq 仍是 child 的真实水位。
      // 代价：contextWindow 分母会按父 record 的当前模型解析而不是 actor 模型，纯展示层偏差。
      const record = await resolveConversationBackingRecord(context, sessionId);
      if (!record) {
        // detached live child 继续使用在线尾部；仅显式携带 M0 的冷打开可以独立物化历史。
        if (persistedMessages === undefined)
          return { events: [], synthesized: false, sourceEventSeq: 0 };
        // 主对话历史只依赖持久化事实；旧路径在这里返回空数组会把冷会话误画成空白。
        const store = context.deps.sessionStore;
        if (!store) throw new Error("fault.subscribe.sessionNotFound");
        const replayedRuns = await replayOpenCodeAgentRunEvents(context, sessionId, []);
        const source = await loadPersistedConversationMaterialization({
          sessionId,
          persistedMessages,
          memoryEvents: replayedRuns,
          store,
        });
        const merged = mergeColdConversationEvents({ ...source, sessionId });
        return {
          events: merged.events,
          synthesized: true,
          sourceEventSeq: 0,
          ...(source.sharedContextImport
            ? { sharedContextImport: source.sharedContextImport }
            : {}),
        };
      }
      // message/part 与 session_entry 的异步读取期间 live sink 仍可收到新事件。
      // gateway 必须知道 memory eventStore 取快照时的 raw cursor，才能只补 await 窗口内
      // 的尾部，并把 transcript 合成的 1..N 序列稳定映射回后续 runtime raw seq。
      // 内存 event store 会淘汰已完成 turn 的瞬态事件，max(events.seq) 会小于真实
      // 游标，让已淘汰的 delta 被当成 await 窗口尾部重放。两次调用之间没有 await，拿到的是
      // 同一时刻的一致快照。
      const [liveEvents, sourceEventSeq] = await Promise.all([
        record.eventStore.getEvents(sessionId as SessionId),
        record.eventStore.getLatestSequenceNumber(sessionId as SessionId),
      ]);
      // workflow run 的冷回放：journal 回放出的进度
      // 事件前置到内存事件之前——cold merge 已把该类型归为 memory-only 权威（保序进 supplements），
      // 投影经同一个 reducer 归约，`workflowRuns` 因此在重启前后一致。
      const replayed = await replayDynamicWorkflowRunEvents(context, sessionId, record, liveEvents);
      const replayedOpenCodeRuns = await replayOpenCodeAgentRunEvents(
        context,
        sessionId,
        liveEvents,
      );
      const events = [...replayed, ...replayedOpenCodeRuns, ...liveEvents];
      const store = context.deps.sessionStore;
      const source = await loadPersistedConversationMaterialization({
        memoryEvents: events,
        persistedMessages,
        sessionId,
        ...(store
          ? {
              store: {
                getSession: (id) => store.getSession(id),
                messages: (input) => store.messages(input),
                readTarget: (input) => store.readTarget(input),
                ...(store.sessionEntries
                  ? {
                      sessionEntries: (input) =>
                        store.sessionEntries!(input).catch((error) => {
                          context.logger?.warn("v4 hydrate session entries read failed", {
                            error: error instanceof Error ? error.message : String(error),
                            event: "zcode_protocol.v4.hydrate_session_entries_failed",
                            module: "bootstrap.zcode_protocol",
                          });
                          return [];
                        }),
                    }
                  : {}),
              },
            }
          : {}),
      });
      // live ModelComplete.fileChanges 只存在于内存事件；cold merge 以持久
      // transcript 为正文权威时会压掉该事件，而 transcript 本身没有文件摘要字段。
      // workspace checkpoint + artifact 才是跨进程持久事实，这里按 user messageId
      // 重建摘要，再交给 transcript hydration 合成同构 ModelComplete。
      const fileChangeSummariesByMessageId = await buildColdFileChangeSummaries({
        events: source.memoryEvents,
        messageIds: source.messages.map((message) => String(message.info.id)),
        readArtifact: async (snapshotRef) =>
          (await record.app.readToolResultArtifact(snapshotRef)).content,
        onArtifactError: (messageId, error) =>
          context.logger?.warn("v4 cold file change artifact read failed", {
            error: error instanceof Error ? error.message : String(error),
            event: "zcode_protocol.v4.hydrate_file_changes_failed",
            messageId,
            module: "bootstrap.zcode_protocol",
            sessionId,
          }),
      });
      // 冷恢复 transcript 不保存模型能力，旧 hydration 自行填 20 万；
      // provider registry 已在 resume 前同步完成，应按恢复/退避后的当前模型精确取值。
      const contextWindow = resolveSessionModelContextWindow(context, record);
      const usageSeed = sessionUsageSeedFromRuntimeContextUsage(
        await readSessionContextUsage(context, sessionId, source.messages),
        contextWindow,
      );
      const merged = mergeColdConversationEvents({
        contextWindow,
        fileChangeSummariesByMessageId,
        memoryEvents: source.memoryEvents,
        messages: source.messages,
        sessionId,
        goalVerificationEntries: source.goalVerificationEntries,
        ...(Object.prototype.hasOwnProperty.call(source, "target")
          ? { target: source.target }
          : {}),
      });
      for (const diagnostic of merged.diagnostics) {
        const fields = {
          ...diagnostic,
          event: "zcode_protocol.v4.hydrate_three_source_merge",
          module: "bootstrap.zcode_protocol",
          sessionId,
        };
        if (
          diagnostic.code === "cold_merge.ambiguous_legacy_turn_preserved" ||
          diagnostic.code === "cold_merge.memory_boundary_preserved" ||
          diagnostic.code === "cold_merge.unclassified_event_preserved"
        ) {
          context.logger?.warn("v4 hydrate preserved ambiguous cold fact", fields);
        } else {
          log?.debug("v4 hydrate merged duplicate cold facts", fields);
        }
      }
      // transcript 可恢复 Agent row，却不能证明 child session 已经落库。
      // 这里在 gateway 的 raw-event buffer 补回前生成校验种子，既排除旧幽灵引用，
      // 又避免异步查询覆盖 seed 之后新到达的 live spawn/stop。
      const subagents = await listSessionSubagents(
        context,
        { sessionId, endedLimit: 1 },
        persistedMessages,
      );
      return {
        events: merged.events,
        // 与合成事件共用本次查询结果；不在后续回填阶段重新读取另一份容量。
        usageSeed,
        // gateway 旧字段名仍叫 synthesized；这里表示投影已由 durable
        // transcript 重物化，需替换 ingest 抢先建的 cold publisher。
        synthesized: merged.usedDurableTranscript,
        subagentsSeed: {
          revision: subagents.revision,
          childSessionIds: subagents.childSessionIds,
          running: subagents.running,
        },
        ...(source.sharedContextImport ? { sharedContextImport: source.sharedContextImport } : {}),
        sourceEventSeq,
      };
    },
    onError: (scope, error, errorContext) =>
      context.logger?.warn("ZCode Protocol v4 gateway error", {
        ...errorContext,
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.v4.gateway_error",
        module: "bootstrap.zcode_protocol",
        scope,
      }),
  };
}
