/**
 * zcodeTaskServiceAdapterRuntimeCommands.ts: Очередь runtime-команд задачи и её последовательный drain.
 */
import type {
  CoreHelpers,
  TaskAdapterState,
  TaskTarget,
  ZCodeSendPromptRuntimeCommand,
  ZCodeTerminalStreamEvent,
} from "./zcodeTaskServiceAdapterCore.js";
import type { PromptHelpers } from "./zcodeTaskServiceAdapterPrompt.js";
import type { TraceId, ZCodeTaskRuntimeCommand } from "@zcode/shared";
import { logger } from "./zcodeTaskServiceAdapterCore.js";
import { generateTraceId, resolveWorkspaceKey } from "@zcode/shared";

export type RuntimeCommandHelpers = ReturnType<typeof createRuntimeCommandHelpers>;

export function createRuntimeCommandHelpers(
  deps: Pick<
    TaskAdapterState,
    "activePromptInputIds" | "runtimeCommandDrains" | "runtimeCommands"
  > &
    Pick<CoreHelpers, "emitTaskEvent" | "taskKey" | "turnAttributionOf" | "workspaceKey"> &
    Pick<PromptHelpers, "sendPromptToAgent">,
) {
  const {
    activePromptInputIds,
    runtimeCommandDrains,
    runtimeCommands,
    emitTaskEvent,
    taskKey,
    turnAttributionOf,
    workspaceKey,
    sendPromptToAgent,
  } = deps;

  function setRuntimeCommands(params: TaskTarget, commands: ZCodeTaskRuntimeCommand[]): void {
    const key = taskKey(params);
    if (commands.length === 0) {
      runtimeCommands.delete(key);
      return;
    }
    runtimeCommands.set(key, commands);
  }

  function markRuntimeCommandRunning(
    params: TaskTarget,
    command: ZCodeSendPromptRuntimeCommand,
  ): ZCodeSendPromptRuntimeCommand {
    const key = taskKey(params);
    const runningCommand: ZCodeSendPromptRuntimeCommand = {
      ...command,
      status: "running",
      updatedAt: Date.now(),
    };
    runtimeCommands.set(
      key,
      (runtimeCommands.get(key) ?? []).map((item) =>
        item.commandId === command.commandId ? runningCommand : item,
      ),
    );
    return runningCommand;
  }

  function markRuntimeCommandFailed(
    params: TaskTarget,
    command: ZCodeSendPromptRuntimeCommand,
    error: unknown,
  ): void {
    const key = taskKey(params);
    // Bug 原因 (2026-11-12): ① статус failed нужен UI/телефону, чтобы показать причину
    // отклонённого ACK; ② но запись не должна жить вечно. Держим её в очереди как факт
    // ошибки, ограничиваем хвостом из 50 команд и вычищаем при смене процесса/удалении
    // задачи — иначе pendingCommands и память растут без границы.
    const failedCommand: ZCodeSendPromptRuntimeCommand = {
      ...command,
      status: "failed",
      updatedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    };
    const commands = runtimeCommands.get(key) ?? [];
    const next = commands.map((item) =>
      item.commandId === command.commandId ? failedCommand : item,
    );
    runtimeCommands.set(key, next.slice(-50));
    if (activePromptInputIds.get(key) === command.traceId) {
      activePromptInputIds.delete(key);
    }
    logger.info(command.traceId, "ZCode task command drain 失败", {
      commandId: command.commandId,
      error: failedCommand.error,
      taskId: params.taskId,
      workspaceIdentity: params.workspaceIdentity ?? null,
      workspaceKey: resolveWorkspaceKey(params),
      workspacePath: params.workspacePath,
    });
    emitRuntimeCommandSnapshotUpdated(params, command.traceId);
  }

  function removeRuntimeCommand(params: TaskTarget, commandId: string): void {
    setRuntimeCommands(
      params,
      (runtimeCommands.get(taskKey(params)) ?? []).filter(
        (command) => command.commandId !== commandId,
      ),
    );
  }

  function emitRuntimeCommandSnapshotUpdated(params: TaskTarget, traceId?: TraceId): void {
    emitTaskEvent(params, {
      type: "task_snapshot_updated",
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      workspaceKey: workspaceKey(params),
      taskId: params.taskId,
      traceId: traceId ?? generateTraceId(params.taskId),
      reason: "task_status_changed",
    });
  }

  function completeRuntimeCommandByInputId(
    params: TaskTarget,
    terminalInputId: string | undefined,
    terminalType: string,
  ): void {
    if (!terminalInputId) {
      return;
    }
    const command = (runtimeCommands.get(taskKey(params)) ?? []).find(
      (candidate) =>
        candidate.type === "send_prompt" &&
        candidate.status === "running" &&
        candidate.traceId === terminalInputId,
    );
    if (!command) {
      return;
    }
    // 手机 host command 在 sendPrompt ACK 后仍要保持 running，
    // 否则手机刷新拿不到“已开始发送”的 pendingCommands。只有真实终态到达后才能从 host 队列移除。
    removeRuntimeCommand(params, command.commandId);
    logger.info(command.traceId, "ZCode task command 终态收口", {
      commandId: command.commandId,
      terminalType,
      taskId: params.taskId,
      workspaceIdentity: params.workspaceIdentity ?? null,
      workspaceKey: resolveWorkspaceKey(params),
      workspacePath: params.workspacePath,
    });
  }

  function completeRuntimeCommandForTerminalEvent(
    params: TaskTarget,
    event: ZCodeTerminalStreamEvent,
  ): void {
    completeRuntimeCommandByInputId(params, event.inputId ?? event.traceId, event.type);
  }

  async function drainRuntimeCommands(params: TaskTarget, reason: string): Promise<void> {
    const key = taskKey(params);
    if (activePromptInputIds.has(key)) {
      return;
    }
    const commands = runtimeCommands.get(key) ?? [];
    if (commands.some((command) => command.status === "running")) {
      return;
    }
    const command = commands.find(
      (candidate): candidate is ZCodeSendPromptRuntimeCommand =>
        candidate.type === "send_prompt" && candidate.status === "accepted",
    );
    if (!command) {
      return;
    }

    const runningCommand = markRuntimeCommandRunning(params, command);
    logger.info(runningCommand.traceId, "ZCode task command drain 开始", {
      commandId: runningCommand.commandId,
      queryId: runningCommand.queryId ?? null,
      reason,
      taskId: params.taskId,
      workspaceIdentity: params.workspaceIdentity ?? null,
      workspaceKey: resolveWorkspaceKey(params),
      workspacePath: params.workspacePath,
    });
    try {
      await sendPromptToAgent(params, {
        traceId: runningCommand.traceId,
        queryId: runningCommand.queryId,
        messageId: runningCommand.commandId,
        content: runningCommand.content,
        attachments: runningCommand.attachments,
        ...turnAttributionOf(
          runningCommand.automationId ? { automationId: runningCommand.automationId } : {},
        ),
        // v4 sendText 信封保留手机提交端 clientId（pendingCommands 展示与幂等表按提交端区分）。
        clientId: runningCommand.clientId,
        logReason: "host-command-drain",
      });
    } catch (error) {
      markRuntimeCommandFailed(params, runningCommand, error);
      logger.warn(runningCommand.traceId, "ZCode task command drain 失败", {
        commandId: runningCommand.commandId,
        error: error instanceof Error ? error.message : String(error),
        reason,
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
    }
  }

  async function drainRuntimeCommandsSafely(params: TaskTarget, reason: string): Promise<void> {
    try {
      await drainRuntimeCommands(params, reason);
    } catch (error) {
      logger.warn(undefined, "ZCode task command drain 调度失败", {
        error: error instanceof Error ? error.message : String(error),
        reason,
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
    }
  }

  function scheduleRuntimeCommandDrain(params: TaskTarget, reason: string): void {
    const key = taskKey(params);
    const existingDrain = runtimeCommandDrains.get(key);
    if (existingDrain) {
      const nextDrainPromise = existingDrain
        .finally(() => drainRuntimeCommandsSafely(params, reason))
        .finally(() => {
          if (runtimeCommandDrains.get(key) === nextDrainPromise) {
            runtimeCommandDrains.delete(key);
          }
        });
      runtimeCommandDrains.set(key, nextDrainPromise);
      return;
    }
    const drainPromise = (async () => {
      await drainRuntimeCommandsSafely(params, reason);
    })().finally(() => {
      if (runtimeCommandDrains.get(key) === drainPromise) {
        runtimeCommandDrains.delete(key);
      }
    });
    runtimeCommandDrains.set(key, drainPromise);
  }

  return {
    setRuntimeCommands,
    markRuntimeCommandRunning,
    markRuntimeCommandFailed,
    removeRuntimeCommand,
    emitRuntimeCommandSnapshotUpdated,
    completeRuntimeCommandByInputId,
    completeRuntimeCommandForTerminalEvent,
    drainRuntimeCommands,
    drainRuntimeCommandsSafely,
    scheduleRuntimeCommandDrain,
  };
}
