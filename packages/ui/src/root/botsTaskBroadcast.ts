import {
  BOT_TASK_BROADCAST_CHANNEL,
  type ZCodeTaskRuntimeStatus,
  type BotTaskBroadcastPayload,
} from "@zcode/shared";
import type { BroadcastMessage } from "./contract.ts";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import type { WindowTabState } from "@/store/tabStore.js";
import { isWorkspaceTab } from "@/store/tabStore.js";

function isBotTaskBroadcastPayload(payload: unknown): payload is BotTaskBroadcastPayload {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const value = payload as Partial<BotTaskBroadcastPayload>;
  const validEvents = new Set<BotTaskBroadcastPayload["event"]>([
    "created",
    "prompt_sent",
    "resumed",
    "streaming",
    "permission_request",
    "permission_resolved",
    "elicitation_request",
    "elicitation_resolved",
    "updated",
    "completed",
    "error",
  ]);
  return (
    typeof value.workspacePath === "string" &&
    typeof value.taskId === "string" &&
    typeof value.updatedAt === "number" &&
    (value.workspaceIdentity === undefined || typeof value.workspaceIdentity === "string") &&
    typeof value.event === "string" &&
    validEvents.has(value.event) &&
    (value.task === undefined ||
      (typeof value.task === "object" &&
        value.task !== null &&
        typeof value.task.taskId === "string" &&
        typeof value.task.workspacePath === "string")) &&
    (value.provider === undefined || typeof value.provider === "string") &&
    (value.configOptions === undefined || Array.isArray(value.configOptions)) &&
    (value.permissionRequest === undefined ||
      (typeof value.permissionRequest === "object" && value.permissionRequest !== null)) &&
    (value.elicitationRequest === undefined ||
      (typeof value.elicitationRequest === "object" && value.elicitationRequest !== null)) &&
    (value.prompt === undefined ||
      (typeof value.prompt === "object" &&
        value.prompt !== null &&
        typeof value.prompt.content === "string" &&
        typeof value.prompt.messageId === "string" &&
        typeof value.prompt.sentAt === "number")) &&
    (value.requestId === undefined || typeof value.requestId === "string") &&
    (value.error === undefined || typeof value.error === "string")
  );
}

export function resolveBotTaskBroadcastRefresh(
  message: BroadcastMessage,
  tabs: WindowTabState[],
): BotTaskBroadcastPayload | null {
  if (message.channel !== BOT_TASK_BROADCAST_CHANNEL) {
    return null;
  }
  if (!isBotTaskBroadcastPayload(message.payload)) {
    return null;
  }
  const targetWorkspaceKey = buildTaskWorkspaceKey(
    message.payload.workspacePath,
    message.payload.workspaceIdentity,
  );
  const hasOpenWorkspace = tabs.some(
    (tab) =>
      isWorkspaceTab(tab) &&
      buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity) === targetWorkspaceKey,
  );
  return hasOpenWorkspace ? message.payload : null;
}

export function resolveBotTaskBroadcastRuntimeStatus(
  event: BotTaskBroadcastPayload["event"],
): ZCodeTaskRuntimeStatus {
  switch (event) {
    case "created":
      return "creating";
    case "completed":
      return "completed";
    case "error":
      return "failed";
    case "prompt_sent":
    case "resumed":
    case "streaming":
    case "permission_request":
    case "permission_resolved":
    case "elicitation_request":
    case "elicitation_resolved":
      return "streaming";
    case "updated":
      // Bugfix: /model、/mode、/think 这类 Bot 配置更新只同步 task 元数据/configOptions，
      // 并没有启动一次 assistant streaming。之前把 updated 映射成 streaming，
      // 会让当前对话一直显示 loading。
      return "ready";
  }
}

/**
 * task_complete.stopReason 就是 TurnResultType。`success` 与 `cancelled` 都算正常收口，所以都写
 * completed：用户主动中断在会话/转录层按 interrupted 呈现（v4 phase `completedInterrupted`），
 * 不是侧栏 runtime 状态的失败。其余 error_* 是受限/失败终态，不能标记成 completed。
 *
 * docs/specs/max-turns-limit.md MAXTURN-07：error_max_turns 不是成功，
 * 旧实现无条件写 completed，会让 Bot 任务在侧栏/运行态里静默显示为完成。
 */
const FAILED_TASK_COMPLETE_RESULT_TYPES = new Set([
  "error_max_turns",
  "error_max_budget",
  "error_during_execution",
  "error_max_tool_calls",
]);

export function resolveTaskCompleteRuntimeStatus(
  stopReason: string,
): Extract<ZCodeTaskRuntimeStatus, "completed" | "failed"> {
  return FAILED_TASK_COMPLETE_RESULT_TYPES.has(stopReason) ? "failed" : "completed";
}
