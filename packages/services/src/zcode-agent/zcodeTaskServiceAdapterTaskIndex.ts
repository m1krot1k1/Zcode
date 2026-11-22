/**
 * zcodeTaskServiceAdapterTaskIndex.ts: Snapshot/legacy resume и синхронизация task index (meta, статусы, presentation).
 */
import type {
  CoreHelpers,
  CreateZCodeTaskServiceAdapterOptions,
  TaskAdapterState,
  TaskTarget,
  TaskTargetWithMcpServers,
} from "./zcodeTaskServiceAdapterCore.js";
import type {
  ZCodeSessionMode,
  ZCodeSessionStateSnapshot,
  ZCodeStreamEvent,
  ZCodeTaskMeta,
  ZCodeTaskSnapshot,
  ZCodeWorkspaceTaskListChanged,
} from "@zcode/shared";
import type { CommandPayloadMap } from "@zcode/shared/zcode-protocol-v4";
import { formatTaskMetaModelSelectionFromSnapshot } from "./zcodeConfigOptions.js";
import { GLM_PROVIDER, logger } from "./zcodeTaskServiceAdapterCore.js";
import { fromZCodeGoal } from "./zcodeTaskServiceAdapterMessageMapping.js";
import {
  deriveTitleFromSnapshot,
  fromZCodeMode,
  parseModelPickerValue,
} from "./zcodeTaskServiceAdapterSnapshotSupport.js";
import { sendHostCasCommandV4 } from "./zcodeV4HostCommand.js";
import {
  createSessionTraceId,
  deriveZCodeTaskStatusFromSessionSnapshot,
  generateTraceId,
  isAuxiliarySessionKind,
} from "@zcode/shared";
import {
  getLegacyDeletedTaskSessionSnapshotPath,
  getLegacyTaskSessionSnapshotPath,
} from "#src/paths.js";
import { repairImportedClaudeSessionSnapshot } from "#src/session/claude-native/importedClaudeHistoryRepair.js";
import { safeParseLegacyTaskSessionFile } from "#src/session/legacyTaskSessionFile.js";
import { existsSync, readFileSync } from "node:fs";

export type TaskIndexHelpers = ReturnType<typeof createTaskIndexHelpers>;

export function createTaskIndexHelpers(
  deps: { options: CreateZCodeTaskServiceAdapterOptions } & Pick<
    TaskAdapterState,
    | "apiRetryByTaskKey"
    | "legacySnapshotTaskKeys"
    | "runtimeCommands"
    | "taskIndexRepo"
    | "taskIndexSyncer"
    | "taskTargets"
  > &
    Pick<CoreHelpers, "rememberTaskTarget" | "resolveProductMcpServers" | "taskKey">,
) {
  const {
    apiRetryByTaskKey,
    legacySnapshotTaskKeys,
    runtimeCommands,
    taskIndexRepo,
    taskIndexSyncer,
    taskTargets,
    rememberTaskTarget,
    resolveProductMcpServers,
    taskKey,
    options,
  } = deps;

  async function resumeSnapshot(
    params: TaskTargetWithMcpServers,
  ): Promise<ZCodeSessionStateSnapshot> {
    rememberTaskTarget(params);
    const thoughtLevel = params.thoughtLevel?.trim();
    const mcpServers = await resolveProductMcpServers(params.mcpServers);
    return options.zcodeAgentService.resumeSession({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      sessionId: params.taskId,
      ...(params.additionalDirectories !== undefined
        ? { additionalDirectories: params.additionalDirectories }
        : {}),
      // Bugfix: replayable 手机端恢复仍经 task adapter，但 stale model guard 在
      // session resume 内执行；这里带上当前 UI 模型，避免只保护 desktop continuous 主链路。
      model: params.model ? parseModelPickerValue(params.model) : undefined,
      ...(thoughtLevel ? { thoughtLevel } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(params.toolDenylist ? { toolDenylist: params.toolDenylist } : {}),
    });
  }

  /**
   * 会话级配置写（模型/思考深度/模式）的 v4 CAS 命令提交。
   * host 无本地 v4 投影，revision 用 stale ACK 的 revisionAtDecision 收敛（sendHostCasCommandV4）。
   * 注意与 compact/goal 标注同一坑位：旧协议 stateRevision 与 v4 conversation revision
   * 是两套计数器，这里全程只用 v4 ACK 回报的 revision，绝不混入旧 expectedRevision。
   */
  async function sendConfigCasCommandV4<T extends "switchModelConfig" | "switchCollaborationMode">(
    target: TaskTarget,
    type: T,
    payload: CommandPayloadMap[T],
    contextMessage: string,
  ): Promise<void> {
    await sendHostCasCommandV4({
      send: (envelope) =>
        options.zcodeAgentService.sendConversationCommandV4({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          envelope,
        }),
      type,
      payload,
      sessionId: target.taskId,
      contextMessage,
    });
  }

  /**
   * session/setMode → v4 switchCollaborationMode。
   * auto 例外保真：v4 命令值域刻意排除 auto（「auto 非用户可切，不进 UI 命令面」，
   * command.ts 裁决），而旧协议 ZCodeSessionMode 含 auto 且旧 op 接受它——为 UI 行为
   * 零变化，auto 继续走旧 op，其余值一律 v4 原生。过渡归宿 = auto 语义在 v4 侧裁决后收口。
   */
  async function switchCollaborationModeViaProtocol(
    target: TaskTarget,
    mode: ZCodeSessionMode,
  ): Promise<void> {
    if (mode === "auto") {
      await options.zcodeAgentService.setMode({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        sessionId: target.taskId,
        mode,
      });
      return;
    }
    await sendConfigCasCommandV4(
      target,
      "switchCollaborationMode",
      { mode },
      `session=${target.taskId} mode=${mode}`,
    );
  }

  async function repairEmptyImportedClaudeSnapshot(
    params: TaskTargetWithMcpServers,
    snapshot: ZCodeSessionStateSnapshot,
  ): Promise<ZCodeSessionStateSnapshot> {
    const repaired = await repairImportedClaudeSessionSnapshot({
      snapshot,
      target: params,
      createSession: (input) => options.zcodeAgentService.createSession(input),
      onRepair: (history) => {
        logger.warn(
          undefined,
          `Claude 导入 protocol session 历史异常，按 ${history.source} 回填 taskId=${params.taskId}`,
        );
      },
    });
    if (!repaired) {
      return snapshot;
    }
    const meta = await syncTaskIndexSnapshot(repaired);
    await updateIndexedPresentation({ ...meta, migrationSource: "claudeCode" });
    return repaired;
  }

  function isSessionMissingError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /\bSession (not found|is not active):/i.test(message);
  }

  async function readLegacyTaskSnapshot(params: TaskTarget): Promise<ZCodeTaskSnapshot | null> {
    const paths = [
      getLegacyTaskSessionSnapshotPath(
        params.workspacePath,
        params.taskId,
        params.workspaceIdentity,
      ),
      getLegacyDeletedTaskSessionSnapshotPath(
        params.workspacePath,
        params.taskId,
        params.workspaceIdentity,
      ),
    ];
    const snapshotPath = paths.find((path) => existsSync(path));
    if (!snapshotPath) {
      return null;
    }

    try {
      const rawSnapshot = JSON.parse(readFileSync(snapshotPath, "utf-8")) as unknown;
      const parsed = safeParseLegacyTaskSessionFile(rawSnapshot);
      if (!parsed.success) {
        logger.warn(
          undefined,
          `读取 legacy task snapshot 非法 taskId=${params.taskId}`,
          parsed.error.flatten(),
        );
        return null;
      }

      const legacyFile = parsed.data;
      const indexedMeta = await taskIndexRepo.getTaskMeta(params).catch(() => null);
      const legacyMeta: ZCodeTaskMeta = {
        ...legacyFile.meta,
        // Bugfix: 旧 ACP task 只落在 ~/.zcode/v2/sessions/*.json，没有写入
        // zcode-cli 的 sqlite session 表。新协议 resume 会把 taskId 当 sessionId
        // 直接报 Session not found；这里按旧快照恢复只读历史内容，并用 task index
        // 补齐用户改名、归档状态和终态 status，避免把旧 task 误当成可订阅的新 session。
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity ?? legacyFile.meta.workspaceIdentity,
        title: indexedMeta?.title ?? legacyFile.meta.title,
        updatedAt: indexedMeta?.updatedAt ?? legacyFile.meta.updatedAt,
        mode: legacyFile.meta.mode ?? indexedMeta?.mode ?? "default",
        provider: legacyFile.meta.provider ?? indexedMeta?.provider ?? GLM_PROVIDER,
        status: legacyFile.meta.status ?? indexedMeta?.status ?? "completed",
        lastError: legacyFile.meta.lastError ?? indexedMeta?.lastError,
      };
      const snapshot: ZCodeTaskSnapshot = {
        ...legacyFile,
        meta: {
          ...legacyMeta,
          ...(indexedMeta ? { title: indexedMeta.title, unreadAt: indexedMeta.unreadAt } : {}),
        },
        runtime: {
          apiRetry: apiRetryByTaskKey.get(taskKey(params)) ?? null,
          pendingCommands: runtimeCommands.get(taskKey(params)) ?? [],
        },
      };
      legacySnapshotTaskKeys.add(taskKey(params));
      rememberIndexedTaskMeta(snapshot.meta);
      return snapshot;
    } catch (error) {
      logger.warn(undefined, `读取 legacy task snapshot 失败 taskId=${params.taskId}`, error);
      return null;
    }
  }

  async function resumeSnapshotOrLegacy(
    params: TaskTargetWithMcpServers,
  ): Promise<
    | { kind: "session"; snapshot: ZCodeSessionStateSnapshot }
    | { kind: "legacy"; snapshot: ZCodeTaskSnapshot }
  > {
    try {
      const snapshot = await resumeSnapshot(params);
      return {
        kind: "session",
        snapshot: await repairEmptyImportedClaudeSnapshot(params, snapshot),
      };
    } catch (error) {
      if (!isSessionMissingError(error)) {
        throw error;
      }
      const legacySnapshot = await readLegacyTaskSnapshot(params);
      if (!legacySnapshot) {
        throw error;
      }
      if (legacySnapshot.meta.migrationSource === "claudeCode") {
        try {
          const mcpServers = await resolveProductMcpServers(params.mcpServers);
          const snapshot = await options.zcodeAgentService.createSession({
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
            sessionId: params.taskId,
            sessionTraceId: legacySnapshot.meta.traceId ?? createSessionTraceId(),
            persistence: "immediate",
            model: params.model ? parseModelPickerValue(params.model) : undefined,
            ...(mcpServers ? { mcpServers } : {}),
            ...(params.toolDenylist ? { toolDenylist: params.toolDenylist } : {}),
            importedHistory: {
              source: "claudeCode",
              title: legacySnapshot.meta.title,
              createdAt: legacySnapshot.meta.createdAt,
              updatedAt: legacySnapshot.meta.updatedAt,
              messages: legacySnapshot.messages.map((message) => ({
                role: message.role,
                content: message.content,
                timestamp: message.timestamp,
              })),
            },
          });
          const meta = await syncTaskIndexSnapshot(snapshot);
          await updateIndexedPresentation({ ...meta, migrationSource: "claudeCode" });
          logger.info(
            undefined,
            `legacy Claude 导入 task 已升级为 ZCode session taskId=${params.taskId}`,
          );
          return { kind: "session", snapshot };
        } catch (upgradeError) {
          logger.warn(
            undefined,
            `legacy Claude 导入 task 升级为 ZCode session 失败，继续只读恢复 taskId=${params.taskId}`,
            upgradeError,
          );
        }
      }
      logger.warn(
        undefined,
        `ZCode Protocol session 缺失，已按 legacy task snapshot 恢复 taskId=${params.taskId}`,
        error,
      );
      return { kind: "legacy", snapshot: legacySnapshot };
    }
  }

  function snapshotToMeta(snapshot: ZCodeSessionStateSnapshot): ZCodeTaskMeta {
    const target = {
      taskId: snapshot.session.sessionId,
      workspacePath: snapshot.session.workspace.workspacePath,
      workspaceIdentity: snapshot.session.workspace.workspaceIdentity,
    };
    rememberTaskTarget(target);
    return {
      taskId: snapshot.session.sessionId,
      traceId: snapshot.session.traceId ?? generateTraceId(snapshot.session.sessionId),
      title: deriveTitleFromSnapshot(snapshot),
      workspacePath: snapshot.session.workspace.workspacePath,
      workspaceIdentity: snapshot.session.workspace.workspaceIdentity,
      createdAt: snapshot.session.createdAt,
      updatedAt: snapshot.session.updatedAt,
      mode: fromZCodeMode(snapshot.session.mode),
      model: formatTaskMetaModelSelectionFromSnapshot(snapshot),
      thoughtLevel: snapshot.settings.thoughtLevel.current,
      provider: GLM_PROVIDER,
      status: deriveZCodeTaskStatusFromSessionSnapshot(snapshot),
      lastError: snapshot.projection.lastError
        ? {
            code: snapshot.projection.lastError.code ?? snapshot.projection.lastError.type,
            ...(snapshot.projection.lastError.detail
              ? { detail: snapshot.projection.lastError.detail }
              : {}),
            // 修复原因：service snapshot 是 mobile replayable/cold task meta 的来源，不能
            // 让它与 UI 直接投影的 lastError 产生归因漂移。
            ...(snapshot.projection.lastError.attribution
              ? { attribution: snapshot.projection.lastError.attribution }
              : {}),
            message: snapshot.projection.lastError.message,
          }
        : undefined,
      target: snapshot.projection.target
        ? fromZCodeGoal(snapshot.projection.target)
        : snapshot.projection.target,
    };
  }

  function rememberIndexedTaskMeta(meta: ZCodeTaskMeta): ZCodeTaskMeta {
    const existing = taskTargets.get(meta.taskId);
    // 权威归属刷新：index meta 是唯一可以设置/清除 cronAutomationId 的来源，直接以 meta 为准
    // 写入（绕过 rememberTaskTarget 的 merge-preserve），以便解绑/删除 automation 后能真正清空。
    taskTargets.set(meta.taskId, {
      ...existing,
      taskId: meta.taskId,
      workspacePath: meta.workspacePath,
      workspaceIdentity: meta.workspaceIdentity,
      cronAutomationId: meta.cronAutomationId,
    });
    return meta;
  }

  async function resolveTaskIndexResumeHints(
    params: TaskTarget,
    reason: "replayable_snapshot" | "resume_task",
  ): Promise<{ model?: string; thoughtLevel?: string }> {
    const meta = await taskIndexRepo.getTaskMeta(params).catch((error) => {
      logger.warn(undefined, "读取 task index resume hint 失败，继续不带历史配置恢复", {
        error: error instanceof Error ? error.message : String(error),
        reason,
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
      return null;
    });
    const model = meta?.model?.trim();
    const thoughtLevel = meta?.thoughtLevel?.trim();
    if (model || thoughtLevel) {
      // task-local thoughtLevel 和 model 一样属于历史 session 恢复 hint。
      // 不回填 thoughtLevel 时，同 workspace 的 draft 默认值会在 session/resume 后覆盖 active task。
      logger.info(undefined, "从 task index 回填 ZCode session resume 配置", {
        model: model || null,
        thoughtLevel: thoughtLevel || null,
        reason,
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
    }
    return {
      ...(model ? { model } : {}),
      ...(thoughtLevel ? { thoughtLevel } : {}),
    };
  }

  async function updateIndexedPresentation(meta: ZCodeTaskMeta): Promise<ZCodeTaskMeta> {
    const {
      mode,
      model,
      thoughtLevel,
      lastError,
      target,
      migrationSource,
      cronAutomationId,
      offPeakTaskId,
    } = meta;
    const presentation = Object.fromEntries(
      Object.entries({
        mode,
        model,
        thoughtLevel,
        lastError,
        target,
        migrationSource,
        cronAutomationId,
        offPeakTaskId,
      }).filter(([, value]) => value !== undefined),
    );
    const indexedMeta = await taskIndexRepo.updateTaskPresentation({ ...meta, presentation });
    return rememberIndexedTaskMeta(indexedMeta ?? meta);
  }

  async function syncTaskIndexSnapshot(
    snapshot: ZCodeSessionStateSnapshot,
    broadcastReason: ZCodeWorkspaceTaskListChanged["reason"] | null = "task_status_changed",
  ): Promise<ZCodeTaskMeta> {
    if (isAuxiliarySessionKind(snapshot.session.sessionKind)) return snapshotToMeta(snapshot);
    return rememberIndexedTaskMeta(
      await taskIndexSyncer.syncSnapshotAndBroadcast(snapshot, {
        broadcastReason,
      }),
    );
  }

  async function updateIndexedTaskState(
    params: TaskTarget,
    patch: { pinned?: boolean; archived?: boolean; unreadAt?: number },
  ): Promise<ZCodeTaskMeta> {
    return taskIndexRepo.updateTaskState({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      taskId: params.taskId,
      patch,
    });
  }

  function updateTaskApiRetryFromStreamEvent(params: TaskTarget, event: ZCodeStreamEvent): void {
    const key = taskKey(params);
    if (event.type === "session_info_update" && event.apiRetry !== undefined) {
      apiRetryByTaskKey.set(key, event.apiRetry ?? null);
      return;
    }
    if (event.type === "task_complete" || event.type === "task_error") {
      apiRetryByTaskKey.set(key, null);
    }
  }

  function hasActiveTaskApiRetry(params: TaskTarget): boolean {
    return apiRetryByTaskKey.get(taskKey(params)) != null;
  }

  return {
    resumeSnapshot,
    sendConfigCasCommandV4,
    switchCollaborationModeViaProtocol,
    repairEmptyImportedClaudeSnapshot,
    isSessionMissingError,
    readLegacyTaskSnapshot,
    resumeSnapshotOrLegacy,
    snapshotToMeta,
    rememberIndexedTaskMeta,
    resolveTaskIndexResumeHints,
    updateIndexedPresentation,
    syncTaskIndexSnapshot,
    updateIndexedTaskState,
    updateTaskApiRetryFromStreamEvent,
    hasActiveTaskApiRetry,
  };
}
