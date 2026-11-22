/**
 * task-index/emitters.ts: Shared workspace emitters, task-list broadcasts и terminal/ready события.
 */
import { Emitter } from "@zcode/rpc";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { resolveWorkspaceKey } from "@zcode/shared";
import type {
  ZCodeWorkspaceEvent,
  ZCodeTaskMeta,
  ZCodeWorkspaceTaskListChanged,
} from "@zcode/shared";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import type {
  EmittersHelpers,
  TaskIndexRuntime,
  WorkspaceBroadcastTarget,
  WorkspaceEventInput,
} from "./contracts.js";
import type { ZCodeAgentSessionTarget } from "../zcodeAgent.js";

const logger = createServiceLogger("zcode-task-index-syncer");

export function createEmittersHelpers(
  ctx: Pick<TaskIndexRuntime, "workspaceEmitters" | "terminalEventEmitter" | "readyEventEmitter">,
): EmittersHelpers {
  const { workspaceEmitters, terminalEventEmitter, readyEventEmitter } = ctx;

  function getWorkspaceEmitter(workspace: WorkspaceEventInput): Emitter<ZCodeWorkspaceEvent> {
    const key =
      typeof workspace === "string"
        ? workspace
        : resolveWorkspaceKey({
            workspacePath: workspace.workspacePath,
            workspaceIdentity: workspace.workspaceIdentity,
          });
    let emitter = workspaceEmitters.get(key);
    if (!emitter) {
      emitter = new Emitter<ZCodeWorkspaceEvent>();
      workspaceEmitters.set(key, emitter);
    }
    return emitter;
  }

  function emitWorkspaceTaskListChanged(
    target: WorkspaceBroadcastTarget,
    taskMeta: ZCodeTaskMeta | undefined,
    reason: ZCodeWorkspaceTaskListChanged["reason"],
    options?: Pick<ZCodeWorkspaceTaskListChanged, "unreadSignal">,
  ): void {
    // 排查日志（左侧列表随输入框操作刷新）：确认哪些操作在发 task list 广播、reason 是什么。
    logger.debug(
      undefined,
      `[list-refresh-trace] emitWorkspaceTaskListChanged reason=${reason} taskId=${target.taskId ?? "-"} workspace=${target.workspacePath} hasMeta=${Boolean(taskMeta)}`,
    );
    getWorkspaceEmitter({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
    }).fire({
      type: "workspace_task_list_changed",
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      taskId: target.taskId,
      reason,
      ...(taskMeta ? { taskMeta } : {}),
      ...(options?.unreadSignal ? { unreadSignal: options.unreadSignal } : {}),
    });
  }

  function emitTerminalAndReady(target: ZCodeAgentSessionTarget, summary: SessionSummary): void {
    const phase = summary.phase;
    const failed = phase === "error";
    // 顺序保持旧协议语义：先 turn 终态（收口当前 input），再 prompt ready（放行下一条）。
    terminalEventEmitter.fire({
      target,
      kind: failed ? "turn.failed" : "turn.completed",
    });
    readyEventEmitter.fire({
      target,
      reason: failed ? "prompt_failed" : "prompt_completed",
    });
  }

  return { getWorkspaceEmitter, emitWorkspaceTaskListChanged, emitTerminalAndReady };
}
