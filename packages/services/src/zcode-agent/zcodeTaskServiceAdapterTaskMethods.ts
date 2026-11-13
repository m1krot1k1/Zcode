/**
 * zcodeTaskServiceAdapterTaskMethods.ts: Методы IZCodeTaskService: создание, resume, список и snapshot задач.
 */
import type {
  IZCodeTaskService,
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
} from "../session/zcodeTaskService.js";
import type { TaskAdapterContext } from "./zcodeTaskServiceAdapterContext.js";
import type {
  ModelSelection,
  ZCodeAssistantMessageFeedback,
  ZCodeCodexConnectivityCheckResult,
  ZCodeConfigOption,
  ZCodeImportableSessionCandidate,
  ZCodeSessionFile,
  ZCodeSessionStateSnapshot,
  ZCodeSwitchAgentResult,
  ZCodeSyncTaskSessionBindingResult,
  ZCodeTaskCreateResult,
  ZCodeTaskMeta,
  ZCodeTaskSnapshot,
  ZCodeTaskSnapshotBody,
  ZCodeTaskSnapshotRefContent,
  ZCodeTaskSnapshotToolCallsSlice,
} from "@zcode/shared";
import { settingsToConfigOptions } from "./zcodeConfigOptions.js";
import {
  EMPTY_SLASH_COMMANDS,
  GLM_PROVIDER,
  logger,
  unsupported,
} from "./zcodeTaskServiceAdapterCore.js";
import {
  getTaskSnapshotMessageDiagnostics,
  limitTaskSnapshotMessages,
  normalizeWorkspaceParams,
  parseModelPickerValue,
  toZCodeMode,
} from "./zcodeTaskServiceAdapterSnapshotSupport.js";
import { assertV4CommandAckOk, createHostCommandEnvelope } from "./zcodeV4HostCommand.js";
import { createSessionTraceId } from "@zcode/shared";
import { claudeNativeSessionImportRepo } from "#src/session/claude-native/claudeNativeSessionImportRepo.js";
import { createHash } from "node:crypto";

export function createTaskLifecycleMethods(
  context: TaskAdapterContext,
): Pick<
  IZCodeTaskService,
  | "initialize"
  | "releaseWorkspacePreparation"
  | "checkCodexConnectivity"
  | "createTask"
  | "resumeTask"
  | "listTasks"
  | "listPinnedTaskIds"
  | "listPinnedTasks"
  | "listDeletedTaskIds"
  | "listActiveTaskIds"
  | "listTaskList"
  | "listArchivedTasks"
  | "getTaskSnapshot"
  | "getTaskSnapshotWithEtag"
  | "getTaskSnapshotBody"
  | "getTaskSnapshotRef"
  | "getTaskSnapshotToolCallsSlice"
  | "getTaskMeta"
  | "getTaskConfigOptions"
  | "getTaskModelSelection"
  | "setAssistantMessageFeedback"
  | "syncTaskSessionBinding"
  | "switchAgent"
  | "scanImportableClaudeSessions"
> {
  const {
    taskIndexRepo,
    taskIndexSyncer,
    emitWorkspaceConfig,
    emitWorkspaceTaskListChanged,
    getTaskTarget,
    notifySyncerSession,
    resolveProductMcpServers,
    workspaceKey,
    snapshotToZCode,
    rememberIndexedTaskMeta,
    resolveTaskIndexResumeHints,
    resumeSnapshot,
    resumeSnapshotOrLegacy,
    syncTaskIndexSnapshot,
    updateIndexedPresentation,
    options,
  } = context;
  return {
    async initialize(params) {
      const result = await options.zcodeAgentService.initialize(params);
      return {
        available: result.available,
        version: result.protocolName
          ? `${result.protocolName}/${result.protocolVersion ?? 1}`
          : undefined,
      };
    },

    async releaseWorkspacePreparation(params): Promise<void> {
      // 关闭 workspace UI 只会释放 RPC 使用方，不会自动终止已预热的 Agent。
      // WSL Host 共享后 Host 会继续存活，因此必须按 workspaceKey 显式回收对应 runtime。
      await options.zcodeAgentService.disposeWorkspace(normalizeWorkspaceParams(params));
    },

    async checkCodexConnectivity(): Promise<ZCodeCodexConnectivityCheckResult> {
      return { target: "zcode-agent", reachable: true };
    },

    async createTask(params): Promise<ZCodeTaskCreateResult> {
      const target = normalizeWorkspaceParams(params);
      const requestedSelection =
        params.modelSelection ??
        (params.model
          ? {
              ...parseModelPickerValue(params.model),
              ...(params.thoughtLevel ? { options: { reasoningLevel: params.thoughtLevel } } : {}),
            }
          : undefined);
      const mcpServers = await resolveProductMcpServers(params.mcpServers);
      let snapshot: ZCodeSessionStateSnapshot;
      // M5 ③-2 评估标注（生命周期 op，不迁）：v4 createSession 命令已原生（desktop
      // v4 UI 在用），但 replayable createTask 需要 mcpServers/model/importedHistory
      // 载荷与 snapshot 返回值（task index 同步依赖），v4 命令面均未建模；
      // 迁移属 ③-3/波次 3 生命周期收口。
      if (params.v4Create === true) {
        const model = requestedSelection;
        const ack = assertV4CommandAckOk(
          "createSession",
          await options.zcodeAgentService.sendConversationCommandV4({
            ...target,
            projectId: params.projectId ?? null,
            envelope: createHostCommandEnvelope({
              type: "createSession",
              sessionId: null,
              payload: {
                workspaceId: target.workspaceIdentity?.trim() || target.workspacePath,
                ...(params.additionalDirectories !== undefined
                  ? { additionalDirectories: params.additionalDirectories }
                  : {}),
                ...(params.permissionScope ? { permissionScope: params.permissionScope } : {}),
                config: {
                  ...(model ? { provider: model.providerId, model: model.modelId } : {}),
                  ...(model?.options?.reasoningLevel
                    ? { thought: model.options.reasoningLevel }
                    : {}),
                  ...(params.mode ? { mode: toZCodeMode(params.mode) } : {}),
                },
                ...(mcpServers ? { mcpServers } : {}),
              },
            }),
          }),
          `workspace=${target.workspacePath}`,
        );
        const sessionId = ack.result?.type === "createSession" ? ack.result.sessionId : undefined;
        if (!sessionId) {
          throw new Error("v4 createSession accepted without sessionId result");
        }
        snapshot = await options.zcodeAgentService.readSession({
          ...target,
          sessionId,
        });
      } else {
        snapshot = await options.zcodeAgentService.createSession({
          ...target,
          projectId: params.projectId ?? null,
          additionalDirectories: params.additionalDirectories,
          sessionTraceId: createSessionTraceId(),
          mode: toZCodeMode(params.mode),
          model: requestedSelection,
          thoughtLevel: requestedSelection?.options?.reasoningLevel,
          ...(params.automationId || params.deferPersistenceUntilFirstPrompt
            ? {
                // 修复原因：automation / 闲时任务新建空 session 后会立即 sendText。session_input 有
                // session 外键，必须让 V4 admission 在首发前统一持久化 session 主记录；
                // 否则 create 返回成功后第一条 prompt 会稳定触发 FOREIGN KEY constraint failed。
                persistence: "deferred" as const,
              }
            : {}),
          ...(params.automationId
            ? {
                titleGenerationEnabled: false,
              }
            : {}),
          // Bugfix: replayable task facade 创建 session 时同样会启动 runtime；
          // 之前这里丢掉 mcpServers，导致手机远控路径和 desktop-continuous 的 MCP 行为不一致。
          mcpServers,
        });
      }
      const baseMeta = await syncTaskIndexSnapshot(snapshot, null);
      const meta = await updateIndexedPresentation({
        ...baseMeta,
        ...(params.automationId ? { cronAutomationId: params.automationId } : {}),
        // 闲时派发在创建时即盖章持久归属；月亮图标与后续系统分组归属都只看该标记。
        ...(params.offPeakTaskId ? { offPeakTaskId: params.offPeakTaskId } : {}),
      });

      notifySyncerSession({
        taskId: meta.taskId,
        workspacePath: meta.workspacePath,
        workspaceIdentity: meta.workspaceIdentity,
      });
      emitWorkspaceConfig(target, snapshot.settings);
      // 手机端通过 shared-host 创建 task 时，桌面 renderer 没有本地乐观插入。
      // create 事件必须保留 task_created 语义，否则 UI 会按普通 meta 事件只重排已存在项，远控首页就拿不到新任务。
      emitWorkspaceTaskListChanged(target, meta, "task_created");
      // task 创建结果需要携带 agent 协议快照里的命令列表；否则 replayable 首屏会覆盖为空。
      return {
        ...meta,
        initialSlashCommands: snapshot.slashCommands ?? EMPTY_SLASH_COMMANDS,
      };
    },

    async resumeTask(params): Promise<ZCodeTaskMeta> {
      // v4 侧 resume 已走 subscribe 冷恢复钩子
      // （CLI cold-resume），但 replayable resumeTask 还承担 model/thoughtLevel 回填与
      // snapshot→task index 正文索引回源，旧 resumeSession op 保留到 v4 生命周期收口。
      const explicitModel = params.model?.trim();
      const explicitThoughtLevel = params.thoughtLevel?.trim();
      const indexHints =
        explicitModel && explicitThoughtLevel
          ? {}
          : await resolveTaskIndexResumeHints(params, "resume_task");
      const model = explicitModel || indexHints.model;
      const thoughtLevel = explicitThoughtLevel || indexHints.thoughtLevel;
      const restored = await resumeSnapshotOrLegacy({
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        model,
        thoughtLevel,
        mcpServers: params.mcpServers,
        additionalDirectories: params.additionalDirectories,
      });
      if (restored.kind === "legacy") {
        const meta = await updateIndexedPresentation({
          ...restored.snapshot.meta,
          ...(params.automationId ? { cronAutomationId: params.automationId } : {}),
          // D48：pre-打点会话被闲时续跑恢复时补写归属；backfill 之外的双保险。
          ...(params.offPeakTaskId ? { offPeakTaskId: params.offPeakTaskId } : {}),
        });
        // 打开/恢复任务是快照收敛，不涉及归属，与 resumeSession 广播同语义。
        emitWorkspaceTaskListChanged(params, meta, "task_status_changed");
        return meta;
      }
      const snapshot = restored.snapshot;
      emitWorkspaceConfig(params, snapshot.settings);
      const snapshotMeta = await syncTaskIndexSnapshot(snapshot);
      const meta =
        params.automationId || params.offPeakTaskId
          ? await updateIndexedPresentation({
              ...snapshotMeta,
              ...(params.automationId ? { cronAutomationId: params.automationId } : {}),
              // 续跑时补写闲时归属标记。
              ...(params.offPeakTaskId ? { offPeakTaskId: params.offPeakTaskId } : {}),
            })
          : snapshotMeta;
      notifySyncerSession({
        taskId: meta.taskId,
        workspacePath: meta.workspacePath,
        workspaceIdentity: meta.workspaceIdentity,
      });
      return meta;
    },

    async listTasks(params): Promise<ZCodeTaskMeta[]> {
      const tasks = await taskIndexRepo.listTaskMetas({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        provider: GLM_PROVIDER,
        pinned: false,
        archived: false,
      });
      return tasks.map(rememberIndexedTaskMeta);
    },

    async listPinnedTaskIds(): Promise<string[]> {
      const tasks = await taskIndexRepo.listTaskMetas({
        provider: GLM_PROVIDER,
        pinned: true,
        archived: false,
      });
      return tasks.map((task) => task.taskId);
    },

    async listPinnedTasks(params): Promise<ZCodeTaskMeta[]> {
      const tasks = await taskIndexRepo.listTaskMetas({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        provider: GLM_PROVIDER,
        pinned: true,
        archived: false,
      });
      return tasks.map(rememberIndexedTaskMeta);
    },

    async listDeletedTaskIds(params): Promise<string[]> {
      return taskIndexRepo.listDeletedTaskIds({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        provider: GLM_PROVIDER,
      });
    },

    async listActiveTaskIds(params): Promise<string[]> {
      const key = workspaceKey(params);
      return taskIndexSyncer
        .activeTaskRefs()
        .filter((ref) => workspaceKey(ref) === key)
        .map((ref) => ref.taskId);
    },

    // 保留全局搜索与 Controller 的显式 scopes 查询；项目侧栏不再维护旧远端列表镜像。
    async listTaskList(params: ZCodeTaskListQuery): Promise<ZCodeTaskListResult> {
      const result = await taskIndexRepo.queryTaskList({
        ...params,
        provider: GLM_PROVIDER,
      });
      return {
        ...result,
        items: result.items.map(rememberIndexedTaskMeta),
      };
    },

    async listArchivedTasks(params): Promise<ZCodeTaskMeta[]> {
      const tasks = await taskIndexRepo.listTaskMetas({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        provider: GLM_PROVIDER,
        archived: true,
      });
      return tasks.map(rememberIndexedTaskMeta);
    },

    async getTaskSnapshot(params): Promise<ZCodeTaskSnapshot | null> {
      const startedAt = Date.now();
      const resumeStartedAt = Date.now();
      const explicitModel = params.model?.trim();
      const explicitThoughtLevel = params.thoughtLevel?.trim();
      const shouldBackfillTaskIndexResumeHints =
        params.clientMode === "web-remote-replayable" &&
        params.resumeModelPolicy !== "ui-resolved-only" &&
        (!explicitModel || !explicitThoughtLevel);
      const indexHints = shouldBackfillTaskIndexResumeHints
        ? await resolveTaskIndexResumeHints(params, "replayable_snapshot")
        : {};
      const model = explicitModel || indexHints.model;
      const thoughtLevel = explicitThoughtLevel || indexHints.thoughtLevel;
      const restored = await resumeSnapshotOrLegacy({
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        // 手机 replayable 首屏 snapshot 会先于后续 resumeTask 读取。
        // 这里必须把 task meta 解析出的历史模型和 thoughtLevel 传进 session/resume，
        // 避免冷恢复用 workspace/draft 默认配置污染 context window 与思考强度。
        model,
        thoughtLevel,
      });
      const resumeDurationMs = Date.now() - resumeStartedAt;
      if (restored.kind === "legacy") {
        const limitStartedAt = Date.now();
        const legacySnapshot = limitTaskSnapshotMessages(restored.snapshot, params.messageLimit);
        const limitDurationMs = Date.now() - limitStartedAt;
        const indexStartedAt = Date.now();
        const indexedMeta = (await taskIndexRepo.getTaskMeta(params)) ?? legacySnapshot.meta;
        const indexDurationMs = Date.now() - indexStartedAt;
        logger.info(undefined, "[zcode-task-service] 历史快照读取完成", {
          clientMode: params.clientMode ?? "unknown",
          durationMs: Date.now() - startedAt,
          indexDurationMs,
          limitDurationMs,
          messageLimit: params.messageLimit ?? null,
          resumeDurationMs,
          snapshotKind: "legacy",
          stats: getTaskSnapshotMessageDiagnostics(legacySnapshot),
          taskId: params.taskId,
          workspaceIdentity: params.workspaceIdentity ?? null,
          workspacePath: params.workspacePath,
        });
        return { ...legacySnapshot, meta: indexedMeta };
      }
      const snapshot = restored.snapshot;
      const projectionStartedAt = Date.now();
      const zcodeSnapshot = limitTaskSnapshotMessages(
        snapshotToZCode(snapshot, {
          includeEmptyPendingElicitations: params.clientMode === "web-remote-replayable",
        }),
        params.messageLimit,
      );
      const projectionDurationMs = Date.now() - projectionStartedAt;
      // 恢复先从 CLI 对账事实，再补模型/思考深度/正文；快照不再推导持久状态。
      const indexStartedAt = Date.now();
      const indexedMeta = await syncTaskIndexSnapshot(snapshot);
      const indexDurationMs = Date.now() - indexStartedAt;
      logger.info(undefined, "[zcode-task-service] 历史快照读取完成", {
        clientMode: params.clientMode ?? "unknown",
        durationMs: Date.now() - startedAt,
        indexDurationMs,
        messageLimit: params.messageLimit ?? null,
        projectionDurationMs,
        resumeDurationMs,
        snapshotKind: "session",
        stats: getTaskSnapshotMessageDiagnostics(zcodeSnapshot),
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
      return { ...zcodeSnapshot, meta: indexedMeta };
    },

    async getTaskSnapshotWithEtag(params) {
      const startedAt = Date.now();
      const snapshot = await context.service.getTaskSnapshot(params);
      if (!snapshot) {
        logger.info(undefined, "[zcode-task-service] 历史快照 ETag 读取为空", {
          clientMode: params.clientMode ?? "unknown",
          durationMs: Date.now() - startedAt,
          messageLimit: params.messageLimit ?? null,
          taskId: params.taskId,
          workspaceIdentity: params.workspaceIdentity ?? null,
          workspacePath: params.workspacePath,
        });
        return { snapshot: null };
      }
      const etagStartedAt = Date.now();
      const etag = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
      const etagDurationMs = Date.now() - etagStartedAt;
      if (params.ifNoneMatch && params.ifNoneMatch === etag) {
        logger.info(undefined, "[zcode-task-service] 历史快照 ETag 命中缓存", {
          clientMode: params.clientMode ?? "unknown",
          durationMs: Date.now() - startedAt,
          etagDurationMs,
          messageLimit: params.messageLimit ?? null,
          stats: getTaskSnapshotMessageDiagnostics(snapshot),
          taskId: params.taskId,
          workspaceIdentity: params.workspaceIdentity ?? null,
          workspacePath: params.workspacePath,
        });
        return { snapshot: null, etag, notModified: true };
      }
      logger.info(undefined, "[zcode-task-service] 历史快照 ETag 生成完成", {
        clientMode: params.clientMode ?? "unknown",
        durationMs: Date.now() - startedAt,
        etagDurationMs,
        messageLimit: params.messageLimit ?? null,
        stats: getTaskSnapshotMessageDiagnostics(snapshot),
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
      return { snapshot, etag };
    },

    async getTaskSnapshotBody(): Promise<ZCodeTaskSnapshotBody | null> {
      return null;
    },

    async getTaskSnapshotRef(): Promise<ZCodeTaskSnapshotRefContent | null> {
      return null;
    },

    async getTaskSnapshotToolCallsSlice(): Promise<ZCodeTaskSnapshotToolCallsSlice | null> {
      return null;
    },

    async getTaskMeta(params): Promise<ZCodeTaskMeta | null> {
      const meta = await taskIndexRepo.getTaskMeta(params);
      return meta ? rememberIndexedTaskMeta(meta) : null;
    },

    async getTaskConfigOptions(params): Promise<ZCodeConfigOption[]> {
      const snapshot = await resumeSnapshot(getTaskTarget(params.taskId));
      return settingsToConfigOptions(snapshot.settings);
    },

    async getTaskModelSelection(params): Promise<ModelSelection | null> {
      const target = getTaskTarget(params.taskId);
      const snapshot = await options.zcodeAgentService.readSession({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        sessionId: params.taskId,
      });
      return snapshot.settings.model.current ?? null;
    },

    async setAssistantMessageFeedback(params): Promise<ZCodeSessionFile> {
      const snapshot = await context.service.getTaskSnapshot(params);
      if (!snapshot) {
        unsupported("setAssistantMessageFeedback");
      }
      const assistantMessages = snapshot.messages.filter((message) => message.role === "assistant");
      const targetMessage = assistantMessages[params.turnIndex];
      if (targetMessage) {
        targetMessage.feedback = params.feedback as ZCodeAssistantMessageFeedback | undefined;
      }
      return snapshot;
    },

    async syncTaskSessionBinding(): Promise<ZCodeSyncTaskSessionBindingResult> {
      unsupported("syncTaskSessionBinding");
    },

    async switchAgent(): Promise<ZCodeSwitchAgentResult> {
      unsupported("switchAgent");
    },

    async scanImportableClaudeSessions(params: {
      workspacePath?: string;
      workspaceIdentity?: string;
      modifiedSince?: number;
      limit?: number;
    }): Promise<ZCodeImportableSessionCandidate[]> {
      // legacy ACP 下线后 scanImportableClaudeSessions 被留成空桩，迁移向导扫不到 ~/.claude/projects。
      // workspaceIdentity 仅影响导入落盘目录，扫描仍按 jsonl 内 cwd 与可选 workspacePath 过滤。
      void params.workspaceIdentity;
      return claudeNativeSessionImportRepo.scanImportableSessions({
        workspacePath: params.workspacePath,
        modifiedSince: params.modifiedSince,
        limit: params.limit,
      });
    },
  };
}
