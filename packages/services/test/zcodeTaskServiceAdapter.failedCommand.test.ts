import { describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { CommandAck, TraceId } from "@zcode/shared";
import { createZCodeTaskServiceAdapter } from "#src/zcode-agent/zcodeTaskServiceAdapter.js";
import { collectServiceMemoryDiagnostics } from "#src/memoryDiagnostics.js";
import type {
  IZCodeAgentService,
  ZCodeAgentRuntimeLifecycleEvent,
} from "#src/zcode-agent/zcodeAgent.js";
import type {
  ZCodeTaskIndexReadyEvent,
  ZCodeTaskIndexSyncer,
  ZCodeTaskIndexTerminalEvent,
} from "#src/zcode-agent/zcodeTaskIndexSyncer.js";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

const WORKSPACE_PATH = "/repo";
const WORKSPACE_KEY = WORKSPACE_PATH;
const TASK_ID = "task-1";

function createHarness() {
  const lifecycleEmitter = new Emitter<ZCodeAgentRuntimeLifecycleEvent>();
  const terminalEmitter = new Emitter<ZCodeTaskIndexTerminalEvent>();
  const readyEmitter = new Emitter<ZCodeTaskIndexReadyEvent>();
  let nextAckStatus: CommandAck["status"] = "rejected";

  const sendConversationCommandV4 = vi.fn(async (params: { envelope: { commandId: string } }) => {
    const ack: CommandAck = {
      commandId: params.envelope.commandId,
      status: nextAckStatus,
      revisionAtDecision: 1,
      ...(nextAckStatus === "rejected" ? { reasonCode: "fault.test.rejected" } : {}),
    };
    return ack;
  });

  const agent = {
    sendConversationCommandV4,
    onAgentRuntimeLifecycle: lifecycleEmitter.event,
    onDynamicSessionEvent: vi.fn(() => new Emitter<never>().event),
    disposeWorkspace: vi.fn(async () => undefined),
    disposeAll: vi.fn(),
    forgetSession: vi.fn(),
  } as unknown as IZCodeAgentService;

  const syncer = {
    ensureSessionSubscription: vi.fn(),
    onSessionTerminalEvent: terminalEmitter.event,
    onSessionReadyEvent: readyEmitter.event,
    disposeAll: vi.fn(),
  } as unknown as ZCodeTaskIndexSyncer;

  const repo = {
    close: vi.fn(),
    getTaskMeta: vi.fn(async () => undefined),
  } as unknown as TaskIndexRepo;
  const service = createZCodeTaskServiceAdapter({
    zcodeAgentService: agent,
    taskIndexRepo: repo,
    taskIndexSyncer: syncer,
  }) as ReturnType<typeof createZCodeTaskServiceAdapter> & {
    disposeAll(): void;
  };

  return {
    agent,
    lifecycleEmitter,
    sendConversationCommandV4,
    service,
    setAckStatus(status: CommandAck["status"]) {
      nextAckStatus = status;
    },
  };
}

function enqueue(
  service: ReturnType<typeof createZCodeTaskServiceAdapter>,
  commandId: string,
): Promise<unknown> {
  return service.enqueueTaskCommand({
    workspacePath: WORKSPACE_PATH,
    taskId: TASK_ID,
    commandId,
    traceId: `input-${commandId}` as TraceId,
    type: "send_prompt",
    content: `content-${commandId}`,
  });
}

describe("zcodeTaskServiceAdapter runtime command lifecycle", () => {
  it("keeps a failed command as a bounded error fact and clears it on runtime loss", async () => {
    const harness = createHarness();
    try {
      await enqueue(harness.service, "cmd-1");
      await vi.waitFor(() => expect(harness.sendConversationCommandV4).toHaveBeenCalledTimes(1), {
        timeout: 5000,
        interval: 10,
      });

      const diagnostics = collectServiceMemoryDiagnostics();
      // 失败项 остаётся видимой ошибкой (телефон/UI показывает причину), но reservation снят.
      expect(diagnostics["task.runtimeCommands"]).toBe(1);
      expect(diagnostics["task.activePromptInputs"]).toBe(0);

      // При смене runtime старая ошибка не наследуется: очередь очищается.
      harness.lifecycleEmitter.fire({
        workspacePath: WORKSPACE_PATH,
        workspaceKey: WORKSPACE_KEY,
        runtimeIdentity: { generation: 1, identity: "runtime-1", workspaceKey: WORKSPACE_KEY },
        state: "unavailable",
      });
      expect(collectServiceMemoryDiagnostics()["task.runtimeCommands"]).toBe(0);
    } finally {
      harness.service.disposeAll();
    }
  });

  it("clears residual active input and running command after runtime loss so drain resumes", async () => {
    const harness = createHarness();
    try {
      harness.setAckStatus("accepted");
      await enqueue(harness.service, "cmd-1");
      await vi.waitFor(() => expect(harness.sendConversationCommandV4).toHaveBeenCalledTimes(1), {
        timeout: 5000,
        interval: 10,
      });
      expect(collectServiceMemoryDiagnostics()["task.activePromptInputs"]).toBe(1);

      harness.lifecycleEmitter.fire({
        workspacePath: WORKSPACE_PATH,
        workspaceKey: WORKSPACE_KEY,
        runtimeIdentity: { generation: 1, identity: "runtime-1", workspaceKey: WORKSPACE_KEY },
        state: "unavailable",
      });

      const afterLoss = collectServiceMemoryDiagnostics();
      expect(afterLoss["task.activePromptInputs"]).toBe(0);
      // 旧 runtime 的 running 命令不会再有终态，也必须离队，否则 drain 的 running 闸门永久关闭。
      expect(afterLoss["task.runtimeCommands"]).toBe(0);

      await enqueue(harness.service, "cmd-2");
      await vi.waitFor(() => expect(harness.sendConversationCommandV4).toHaveBeenCalledTimes(2), {
        timeout: 5000,
        interval: 10,
      });
    } finally {
      harness.service.disposeAll();
    }
  });
});
