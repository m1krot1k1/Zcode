// 会话加载域：sessions-index 的轻量摘要、远端 legacy 认领，以及冷恢复（resume）。
// 只依赖 session store 与 server-operations，不持有桥状态本身。
import {
  parseRemoteWorkspaceIdentity,
  type ZCodeSessionContextUsage,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type { MessageWithParts, SessionId, WorkspaceId } from "@zcode/contracts";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import type { V4GatewayHost } from "../zcode-protocol-v4/v4-gateway.js";
import type { SessionUsageSeed } from "../zcode-protocol-v4/product-projection.js";
import { TASK_LIST_SESSION_TYPES } from "../zcode-protocol-v4/task-list-session-membership.js";
import { activateSessionForResume, discardFailedSessionResume } from "./server-operations.js";
import type { BridgeState } from "./v4-bridge-state.js";

export function normalizeStoredTitleSource(
  source: string | undefined,
): NonNullable<SessionSummary["titleSource"]> {
  if (source === "custom") return "custom";
  if (source === "default") return "default";
  return "generated";
}

export function sessionUsageSeedFromRuntimeContextUsage(
  contextUsage: ZCodeSessionContextUsage | undefined,
  contextWindowOverride?: number,
): SessionUsageSeed | null {
  if (!contextUsage || contextUsage.used <= 0) {
    return null;
  }
  return {
    contextWindow: {
      usedTokens: contextUsage.used,
      maxTokens: contextWindowOverride ?? null,
      autoCompactThresholdTokens: null,
      ...(contextUsage.cache ? { cache: contextUsage.cache } : {}),
      ...(contextUsage.breakdown ? { breakdown: contextUsage.breakdown } : {}),
    },
  };
}

/** 会话加载钩子的窄接口：直接对应 gateway host 的同名方法。 */
export interface SessionLoadingHooks {
  loadStoredSessionSummaries(
    workspaceId: string,
    legacyTaskIds?: readonly string[],
  ): Promise<SessionSummary[]>;
  refreshLegacySessionSummaries(
    workspaceId: string,
    legacyTaskIds: readonly string[],
  ): Promise<SessionSummary[]> | null;
  resumePersistedSession: NonNullable<V4GatewayHost["resumePersistedSession"]>;
}

export function createSessionLoading(state: BridgeState): SessionLoadingHooks {
  const { context } = state;
  const loadStoredSessionSummaries = async (
    workspaceId: string,
    legacyTaskIds?: readonly string[],
  ) => {
    // 未加载会话的轻量摘要：store 元信息 → SessionSummary（phase 取空闲完成态默认、
    // sessionEnded=true 对齐 「成功轮收口即 true」口径；加载后的准确
    // phase/preview/backgroundWork 由 gateway 用 live 投影覆盖）。
    // workspaceKey 的本地 fallback = workspacePath，故用它作 listSessions 的 directory 过滤。
    if (!context.deps.sessionStore) return [];
    try {
      // 远端 sessions-index 的 workspaceId 是隔离 identity，而 session store 的
      // directory 是实际文件路径。查询必须同时带路径和 identity；否则同一路径下其他
      // authority 的会话会被误标成当前 workspace。legacy 空 identity 不能只凭路径
      // claim，只允许使用 host task-index 给出的精确 taskId 归属证明。
      const parsedRemote = parseRemoteWorkspaceIdentity(workspaceId);
      const persistedWorkspacePath = parsedRemote?.workspacePath ?? workspaceId;
      if (
        parsedRemote &&
        legacyTaskIds &&
        legacyTaskIds.length > 0 &&
        context.deps.sessionStore.claimLegacySessionWorkspace
      ) {
        try {
          const claimedCount = await context.deps.sessionStore.claimLegacySessionWorkspace({
            sessionIDs: legacyTaskIds as SessionId[],
            directory: persistedWorkspacePath,
            workspaceID: workspaceId as WorkspaceId,
          });
          if (claimedCount > 0) {
            context.logger?.info("legacy remote sessions claimed by task-index allowlist", {
              claimedCount,
              event: "zcode_protocol.v4.sessions_index_legacy_remote_claimed",
              module: "bootstrap.zcode_protocol",
              workspaceId,
            });
          }
        } catch (error) {
          // claim 只是旧数据兼容步骤；失败后仍要读取已有完整 identity 的会话。
          // 后续携带 allowlist 的订阅会再次进入这里，不能用失败结果封死迁移。
          context.logger?.warn("legacy remote sessions claim failed; continuing strict load", {
            error: error instanceof Error ? error.message : String(error),
            event: "zcode_protocol.v4.sessions_index_legacy_remote_claim_failed",
            module: "bootstrap.zcode_protocol",
            workspaceId,
          });
        }
      }
      const stored = await context.deps.sessionStore.listSessions({
        directory: persistedWorkspacePath,
        limit: 200,
        // parentID 只表达会话层级，不能作为左侧任务 membership。
        // 显式 fork 必然带 parentID，但重启后仍应由 taskType 投影进 sessions-index。
        taskTypes: [...TASK_LIST_SESSION_TYPES],
        workspaceID: parsedRemote ? (workspaceId as WorkspaceId) : null,
      });
      return stored.map((session) => ({
        sessionId: String(session.id),
        workspaceId,
        ...(session.parentID ? { parentSessionId: String(session.parentID) } : {}),
        title: session.title ?? "",
        titleSource: normalizeStoredTitleSource(session.titleSource),
        phase:
          session.lastOutcome === "error"
            ? ("error" as const)
            : session.lastOutcome === "interrupted"
              ? ("completedInterrupted" as const)
              : ("completedSuccess" as const),
        ...(session.lastOutcome ? { lastOutcome: session.lastOutcome } : {}),
        sessionEnded: true,
        hasBackgroundWork: false,
        lastActivityAt: session.time?.updated ?? 0,
        createdAt: session.time?.created ?? 0,
      }));
    } catch (error) {
      context.logger?.warn("sessions-index stored summaries failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.v4.sessions_index_stored_failed",
        module: "bootstrap.zcode_protocol",
      });
      return [];
    }
  };
  const refreshLegacySessionSummaries = (workspaceId: string, legacyTaskIds: readonly string[]) =>
    parseRemoteWorkspaceIdentity(workspaceId)
      ? loadStoredSessionSummaries(workspaceId, legacyTaskIds)
      : null;
  const resumePersistedSession: SessionLoadingHooks["resumePersistedSession"] = async (
    sessionId,
    resumeThoughtLevel,
    workspace?: ZCodeWorkspaceRef,
    additionalDirectories?: string[],
    persistedMessages?: MessageWithParts[],
  ) => {
    const persisted = await context.deps.sessionStore?.getSession(sessionId as SessionId);
    if (!persisted || persisted.time.deleted !== undefined) {
      context.logger?.warn("ZCode Protocol v4 cold resume has no persisted session", {
        activeSessionCount: context.sessions.size,
        event: "zcode_protocol.v4.resume_persisted_missing",
        module: "bootstrap.zcode_protocol",
        sessionId,
      });
      return { status: "notFound" };
    }
    const existingRecord = context.sessions.get(sessionId);
    const activated = await activateSessionForResume(
      context,
      {
        sessionId,
        // session.path 可能是规范化后的执行 cwd，不能覆盖当前 attachment
        // 已知的 workspace 身份。旧 session 没有 attachment 上下文时仍走原有持久化回退。
        ...(workspace ? { workspace } : {}),
        ...(additionalDirectories !== undefined ? { additionalDirectories } : {}),
        ...(resumeThoughtLevel ? { thoughtLevel: resumeThoughtLevel } : {}),
      },
      { reusePersistedMessages: true, persistedMessages },
    );
    return {
      status: "resumed",
      persistedMessages: activated.persistedMessages,
      ...(!existingRecord
        ? {
            disposeOnFailure: () =>
              discardFailedSessionResume(context, sessionId, activated.record),
          }
        : {}),
    };
  };

  return { loadStoredSessionSummaries, refreshLegacySessionSummaries, resumePersistedSession };
}
