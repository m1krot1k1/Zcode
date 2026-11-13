/**
 * task-index/snapshotSync.ts: Прямая запись snapshot в task index — presentation,
 * поисковый текст и точечное обновление модели, плюс чистые мапперы snapshot → meta.
 */
import {
  generateTraceId,
  getZCodeUserVisibleMessages,
  isAuxiliarySessionKind,
  isZCodeGoalContinuationReminderText,
  isZCodeModelOnlySyntheticUserMessage,
  type ZCodeMessagePart,
  type ZCodeSessionMode,
  type ZCodeSessionStateSnapshot,
  type ZCodeTaskGoal,
  type ZCodeTaskMeta,
  type ZCodeTaskMode,
  type ZCodeWorkspaceTaskListChanged,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { SnapshotSyncHelpers, TaskIndexRuntime } from "./contracts.js";
import { formatTaskMetaModelSelectionFromSnapshot } from "../zcodeConfigOptions.js";
import type { ZCodeAgentSessionTarget } from "../zcodeAgent.js";

const logger = createServiceLogger("zcode-task-index-syncer");

export function createSnapshotSyncHelpers(
  ctx: Pick<
    TaskIndexRuntime,
    "taskIndexRepo" | "refreshSessionFacts" | "emitWorkspaceTaskListChanged"
  >,
): SnapshotSyncHelpers {
  const { taskIndexRepo } = ctx;

  async function syncSnapshotAndBroadcast(
    snapshot: ZCodeSessionStateSnapshot,
    options: {
      modelOverride?: string;
      thoughtLevelOverride?: string;
      unreadSignal?: ZCodeWorkspaceTaskListChanged["unreadSignal"];
      broadcastReason: ZCodeWorkspaceTaskListChanged["reason"] | null;
    },
  ): Promise<ZCodeTaskMeta> {
    if (isAuxiliarySessionKind(snapshot.session.sessionKind))
      return {
        ...snapshot.session.workspace,
        taskId: snapshot.session.sessionId,
        traceId: snapshot.session.traceId ?? generateTraceId(snapshot.session.sessionId),
        title: snapshot.session.title,
        createdAt: snapshot.session.createdAt,
        updatedAt: snapshot.session.updatedAt,
        ...buildPresentationFromSnapshot(snapshot, options),
      };
    const target = { ...snapshot.session.workspace, taskId: snapshot.session.sessionId };
    if (hasUserVisibleContent(snapshot)) {
      await ctx.refreshSessionFacts({
        ...snapshot.session.workspace,
        sessionId: snapshot.session.sessionId,
      });
    }
    const presentation = buildPresentationFromSnapshot(snapshot, options);
    // Bugfix: 同时把 snapshot.messages 里可见的聊天正文索引下去，
    // 让 TaskSearchDialog 正文搜索能命中；旧 sqlite 行下次到这里时自然回填。
    const searchableText = buildSearchableTextFromSnapshot(snapshot);
    const persisted = await taskIndexRepo.updateTaskPresentation({
      ...target,
      presentation,
      searchableText,
    });
    // 延迟持久化的草稿没有 CLI 行；只返回本次调用的展示值，不制造索引事实。
    if (!persisted)
      return {
        ...target,
        traceId: snapshot.session.traceId ?? generateTraceId(target.taskId),
        title: snapshot.session.title,
        createdAt: snapshot.session.createdAt,
        updatedAt: snapshot.session.updatedAt,
        ...presentation,
      };
    // 空草稿不是持久会话，不能提前制造列表行或任务变更广播。
    if (!hasUserVisibleContent(snapshot) || options.broadcastReason === null) return persisted;
    ctx.emitWorkspaceTaskListChanged(
      {
        workspacePath: persisted.workspacePath,
        workspaceIdentity: persisted.workspaceIdentity,
        taskId: persisted.taskId,
      },
      persisted,
      options.broadcastReason,
      options.unreadSignal ? { unreadSignal: options.unreadSignal } : undefined,
    );
    return persisted;
  }

  async function syncTaskModel(
    target: ZCodeAgentSessionTarget,
    model: string,
  ): Promise<ZCodeTaskMeta | null> {
    const normalizedModel = model.trim();
    if (!normalizedModel) {
      return null;
    }
    try {
      return await taskIndexRepo.updateTaskPresentation({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        taskId: target.sessionId,
        presentation: { model: normalizedModel },
      });
    } catch (error) {
      logger.warn(undefined, `同步 task 模型到 task index 失败 taskId=${target.sessionId}`, error);
      return null;
    }
  }

  return { syncSnapshotAndBroadcast, syncTaskModel };
}

function buildPresentationFromSnapshot(
  snapshot: ZCodeSessionStateSnapshot,
  options?: {
    modelOverride?: string;
    thoughtLevelOverride?: string;
  },
): Pick<ZCodeTaskMeta, "mode" | "model" | "thoughtLevel" | "lastError" | "target"> {
  const modelOverride = options?.modelOverride?.trim();
  const thoughtLevelOverride = options?.thoughtLevelOverride?.trim();
  const meta: Pick<ZCodeTaskMeta, "mode" | "model" | "thoughtLevel" | "lastError" | "target"> = {
    mode: fromZCodeMode(snapshot.session.mode),
    // 用户显式切模型或历史模型不可用时，session 操作已经带了新的可用模型。
    // 这类场景要同步覆盖 sqlite 的 task model，否则下次恢复仍会从已删除的历史模型起跳；
    // 普通历史快照仍走最近消息模型优先，避免被误污染的 settings.current 反向污染索引。
    model: modelOverride || formatTaskMetaModelSelectionFromSnapshot(snapshot),
    // 历史 task 恢复时 snapshot.settings.thoughtLevel 可能仍是同 workspace 草稿态的最新值。
    // 当恢复入口已经带上 task-local thoughtLevel 时，sqlite 必须写入入口值，避免下次打开继续被污染。
    thoughtLevel: thoughtLevelOverride || snapshot.settings.thoughtLevel.current,
    lastError: snapshot.projection.lastError
      ? {
          code: snapshot.projection.lastError.code ?? snapshot.projection.lastError.type,
          ...(snapshot.projection.lastError.detail
            ? { detail: snapshot.projection.lastError.detail }
            : {}),
          // sessions-index terminal resync 与 task service snapshot 必须共享同一份
          // lastError 归因，否则冷热两条读取路径的错误归因会漂移。
          ...(snapshot.projection.lastError.attribution
            ? { attribution: snapshot.projection.lastError.attribution }
            : {}),
          message: snapshot.projection.lastError.message,
        }
      : undefined,
  };
  if (Object.prototype.hasOwnProperty.call(snapshot.projection, "target")) {
    // target 字段缺席表示本次 snapshot 未提供 goal 信息，不能覆盖旧索引；
    // null 才表示 DB 明确没有 goal，需要清空 task-index 中的目标。
    meta.target = snapshot.projection.target
      ? fromZCodeGoal(snapshot.projection.target)
      : snapshot.projection.target;
  }
  return meta;
}

// Bugfix: createSession 刚返回时 snapshot 既没有真实 title 也没有 user message，
// 把这种"空白会话"广播出去会让侧边栏先闪一个 "New session" 占位符。
// 这里判断"是否已有用户可见内容"，没有就只写 sqlite 不广播，等真实 title 到了再广播。
function hasUserVisibleContent(snapshot: ZCodeSessionStateSnapshot): boolean {
  const title = snapshot.session.title?.trim() ?? "";
  if (title && !isZCodeGoalContinuationReminderText(title)) {
    return true;
  }
  if (snapshot.projection.target?.objective.trim()) {
    return true;
  }
  return snapshot.messages.some((message) => {
    if (message.info.role !== "user") return false;
    if (isZCodeModelOnlySyntheticUserMessage(message)) return false;
    return message.parts.some((part) => part.type === "text" && part.text.trim().length > 0);
  });
}

const TASK_SEARCH_TEXT_MAX_CHARS = 200_000;

// 全局会话搜索只索引默认可见的聊天正文，不包含思考过程、tool 调用和 compaction 折叠区。
// assistant 的 parts 可能既有历史正文又有 latest 正文，这里只取最后一段 text part，
// 与 UI 默认折叠后展示的范围一致。
function buildSearchableTextFromSnapshot(snapshot: ZCodeSessionStateSnapshot): string {
  const parts: string[] = [];
  let total = 0;
  // /goal 自动续跑会把内部 system-reminder 作为 runtime user turn 持久化；
  // 这条内容是 model-only 输入，不是用户可见 query，不能写进侧边栏搜索正文。
  for (const message of getZCodeUserVisibleMessages(snapshot.messages, {
    target: snapshot.projection.target,
  })) {
    const textParts = message.parts.filter(
      (part): part is Extract<ZCodeMessagePart, { type: "text" }> => part.type === "text",
    );
    if (textParts.length === 0) {
      continue;
    }
    const chosen = message.info.role === "assistant" ? textParts.slice(-1) : textParts;
    for (const part of chosen) {
      const content = part.text.trim();
      if (!content) {
        continue;
      }
      parts.push(content);
      total += content.length;
      if (total >= TASK_SEARCH_TEXT_MAX_CHARS) {
        break;
      }
    }
    if (total >= TASK_SEARCH_TEXT_MAX_CHARS) {
      break;
    }
  }
  // 关键业务逻辑：上限截断，避免长任务把 tasks-index.sqlite 放大到影响启动和列表查询。
  return parts.join("\n").slice(0, TASK_SEARCH_TEXT_MAX_CHARS);
}

function fromZCodeMode(mode: ZCodeSessionMode): ZCodeTaskMode {
  return mode === "build" ? "build" : mode;
}

function fromZCodeGoal(
  goal: NonNullable<ZCodeSessionStateSnapshot["projection"]["target"]>,
): ZCodeTaskGoal {
  return {
    sessionID: goal.sessionId,
    targetID: goal.targetId,
    objective: goal.objective,
    summaryTitle: goal.summaryTitle,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    time: {
      created: goal.createdAt,
      updated: goal.updatedAt,
    },
  };
}
