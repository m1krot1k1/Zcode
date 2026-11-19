import { describe, expect, it, vi } from "vitest";
import {
  HookEventName,
  SessionEventType,
  createSessionId,
  createTurnId,
  modelMessageContentToText,
  type BackgroundResultOriginMeta,
  type CreateSessionInput,
  type Logger,
  type ModelMessageContent,
  type MessageInfo,
  type MessagePart,
  type MessageWithParts,
  type PermissionRuleset,
  type SessionEvent,
  type SessionGoal,
  type SessionId,
  type SessionInfo,
  type SessionStorePort,
  type SubagentExecutionTerminalPayload,
  type SubagentTaskSnapshot,
  type TodoItem,
} from "@zcode/contracts";
import { formatTaskNotification } from "../src/runtime-task/notification.js";
import { formatLocalAgentTaskNotification } from "../src/subagent/completion-notification.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createRuntimeCommandId } from "../src/runtime/command-queue.js";
import type { PromptRuntimeCommand } from "../src/runtime/command-queue.js";
import { createTurnFailureError } from "../src/runtime/helpers/turn-errors.js";
import { createInMemoryHookRunner } from "../src/hooks/index.js";
import {
  createExploreSubagentPort,
  restorePreviousTerminalTaskAfterResumeFailure,
} from "../src/subagent/runner.js";
import {
  InMemoryRuntimeTaskRegistry,
  type RuntimeTaskSnapshot,
} from "../src/runtime-task/registry.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

describe("subagent background notifications", () => {
  it("rejects an aborted background readiness wait but delays terminal state until settlement", async () => {
    const sessionId = createSessionId("subagent-start-abort-parent");
    const turnId = createTurnId("subagent-start-abort-turn");
    const runtimeStarted = createDeferred<void>();
    const runtimeMaySettle = createDeferred<any>();
    const controller = new AbortController();
    const emittedEvents: SessionEvent[] = [];
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_start_abort",
      outputRootDir: "/tmp/zcode-subagent-start-abort",
      async emitParentEvent(event) {
        emittedEvents.push(event);
      },
      runExploreAgent: async () => {
        runtimeStarted.resolve();
        return runtimeMaySettle.promise;
      },
    });

    const startPromise = port.start?.(
      {
        agentType: "Explore",
        description: "Abort startup",
        parentToolCallId: "call_start_abort",
        prompt: "Start the background child.",
        sessionId,
        trace: {
          traceId: "trace_subagent_start_abort",
          spanId: "span_subagent_start_abort",
          sessionId,
          turnId,
        },
        turnId,
        workingDirectory: "/tmp/zcode-subagent-start-abort",
        workspaceRoot: "/tmp/zcode-subagent-start-abort",
      },
      { signal: controller.signal },
    );
    await runtimeStarted.promise;

    controller.abort(new Error("caller cancelled background start"));
    await expect(startPromise).rejects.toThrow(
      "Agent was cancelled before the subagent returned findings or background launch completed",
    );
    expect((await port.getTask?.("agent_start_abort"))?.status).toBe("running");

    runtimeMaySettle.resolve({
      events: [],
      response: "background child settled after start cancellation",
      traceId: "trace_subagent_start_abort",
    });
    expect((await port.waitForTask?.("agent_start_abort"))?.status).toBe(
      "killed",
    );
    expect(emittedEvents).toEqual([]);
  });

  it.each(["completed", "failed"] as const)(
    "stores one safe foreground terminal projection for %s without claiming acceptance",
    async (terminalStatus) => {
      const sessionId = createSessionId(`prism-foreground-${terminalStatus}`);
      const turnId = createTurnId(`prism-foreground-${terminalStatus}-turn`);
      const taskId = `agent_prism_foreground_${terminalStatus}`;
      const secretSentinel = "sk-test-prism-terminal-secret";
      const registry = new InMemoryRuntimeTaskRegistry();
      const { rootRunId, parentTaskId } = seedPrismParentTask(
        registry,
        sessionId,
      );
      const eventStore = createTestSessionEventStore();
      const port = createExploreSubagentPort({
        createAgentId: () => taskId,
        outputRootDir: `/tmp/zcode-${taskId}`,
        runtimeTaskRegistry: registry,
        emitParentEvent: async (event) => {
          await eventStore.append(event);
        },
        runExploreAgent: async (request) => {
          await request.onSessionReady?.();
          if (terminalStatus === "failed") {
            throw new Error(`private-error-${secretSentinel}`);
          }
          return {
            events: [],
            response: `private-output-${secretSentinel}`,
            traceId: request.traceContext.traceId,
          };
        },
      });
      const request = {
        ...createSubagentRunRequest({ sessionId, turnId }),
        prompt: `private-prompt-${secretSentinel}`,
      };

      if (terminalStatus === "failed") {
        await expect(port.run(request)).rejects.toBeDefined();
      } else {
        await port.run(request);
      }

      const persistedEvents = await eventStore.getEvents(sessionId);
      const terminalEvents = persistedEvents.filter(
        (event) => event.type === SessionEventType.SubagentExecutionTerminal,
      );
      expect(terminalEvents).toHaveLength(1);
      const terminalEvent = terminalEvents[0]!;
      const payload = terminalEvent.payload as SubagentExecutionTerminalPayload;
      const task = registry.get(taskId)!;
      expect(payload).toMatchObject({
        acceptanceStatus: "unknown",
        branchGeneration: 7,
        childStarted: true,
        childSessionId: task.childSessionId,
        parentTaskId,
        provenance: "runtime_lifecycle",
        rootRunId,
        schema: "zcode.prism.subagent-terminal.v3",
        attemptId: task.attemptId,
        taskId,
        terminalStatus,
      });
      expect(payload.terminalId).toBe(
        `${rootRunId}/${taskId}/7/${task.attemptId}`,
      );
      expect(payload.observedAt).toEqual(task.completedAt);
      expect(payload).not.toHaveProperty("verified");
      expect(payload).not.toHaveProperty("output");
      expect(payload).not.toHaveProperty("error");
      expect(payload).not.toHaveProperty("prompt");
      expect(JSON.stringify(payload)).not.toContain(secretSentinel);
      await expect(
        eventStore.getEventsAfter(sessionId, terminalEvent.sequenceNumber - 1),
      ).resolves.toContainEqual(terminalEvent);
    },
  );

  it.each(["completed", "failed"] as const)(
    "stores one safe background terminal projection for %s",
    async (terminalStatus) => {
      const sessionId = createSessionId(`prism-background-${terminalStatus}`);
      const turnId = createTurnId(`prism-background-${terminalStatus}-turn`);
      const taskId = `agent_prism_background_${terminalStatus}`;
      const secretSentinel = "sk-test-prism-background-secret";
      const registry = new InMemoryRuntimeTaskRegistry();
      const { rootRunId, parentTaskId } = seedPrismParentTask(
        registry,
        sessionId,
      );
      const eventStore = createTestSessionEventStore();
      const port = createExploreSubagentPort({
        createAgentId: () => taskId,
        outputRootDir: `/tmp/zcode-${taskId}`,
        runtimeTaskRegistry: registry,
        emitParentEvent: async (event) => {
          await eventStore.append(event);
        },
        enqueueParentTaskNotification: () => undefined,
        runExploreAgent: async (request) => {
          await request.onSessionReady?.();
          if (terminalStatus === "failed") {
            throw new Error(`private-error-${secretSentinel}`);
          }
          return {
            events: [],
            response: `private-output-${secretSentinel}`,
            traceId: request.traceContext.traceId,
          };
        },
      });

      await port.start?.({
        ...createSubagentRunRequest({ sessionId, turnId }),
        prompt: `private-prompt-${secretSentinel}`,
      });
      await port.waitForTask?.(taskId);

      const persistedEvents = await eventStore.getEvents(sessionId);
      const terminalEvents = persistedEvents.filter(
        (event) => event.type === SessionEventType.SubagentExecutionTerminal,
      );
      expect(terminalEvents).toHaveLength(1);
      const payload = terminalEvents[0]!
        .payload as SubagentExecutionTerminalPayload;
      expect(payload).toMatchObject({
        acceptanceStatus: "unknown",
        branchGeneration: 7,
        childStarted: true,
        parentTaskId,
        provenance: "runtime_lifecycle",
        rootRunId,
        taskId,
        terminalStatus,
      });
      expect(JSON.stringify(payload)).not.toContain(secretSentinel);
      expect(payload).not.toHaveProperty("verified");
    },
  );

  it("prefers a newly admitted registry attempt over a stale catalog result during SendMessage", async () => {
    const sessionId = createSessionId("subagent-send-message-catalog-race");
    const turnId = createTurnId("subagent-send-message-catalog-race-turn");
    const taskId = "agent_catalog_race";
    const registry = new InMemoryRuntimeTaskRegistry();
    const delivered: string[] = [];
    const staleCatalogTask: RuntimeTaskSnapshot = {
      taskId,
      agentId: taskId,
      agentType: "implementer",
      description: "old completion",
      status: "completed",
      startedAt: new Date(0),
      completedAt: new Date(1),
      attemptId: "attempt-old",
      childSessionId: createSessionId("subagent-send-message-old-child"),
      parentSessionId: sessionId,
      type: "local_agent",
    };
    const port = createExploreSubagentPort({
      runtimeTaskRegistry: registry,
      emitParentEvent: async () => {},
      enqueueParentTaskNotification: () => undefined,
      resolveTerminalTaskCatalog: async () => {
        registry.register({
          ...staleCatalogTask,
          status: "running",
          attemptId: "attempt-current",
          messageSink: {
            async send(message) {
              delivered.push(message.message);
              return "steered";
            },
          },
        });
        return staleCatalogTask;
      },
      runExploreAgent: async () => {
        throw new Error("stale terminal task must not be resumed");
      },
    });

    await expect(
      port.sendMessage?.(createSendMessageRequest(sessionId, turnId, taskId)),
    ).resolves.toMatchObject({ status: "success" });
    expect(delivered).toHaveLength(1);
  });

  it("preserves messages accepted during failed resume setup rollback", () => {
    const sessionId = createSessionId("subagent-resume-rollback-owner");
    const previousTask: RuntimeTaskSnapshot = {
      taskId: "agent_resume_rollback",
      agentId: "agent_resume_rollback",
      agentType: "implementer",
      description: "completed task",
      status: "completed",
      startedAt: new Date(0),
      completedAt: new Date(1),
      attemptId: "attempt-old",
      childSessionId: createSessionId("subagent-resume-rollback-child"),
      parentSessionId: sessionId,
      type: "local_agent",
    };
    const acceptedMessage = {
      id: "message-accepted-during-setup",
      message: "please continue",
      queuedAt: new Date(2),
    };
    const registry = new InMemoryRuntimeTaskRegistry();
    registry.register(previousTask);
    registry.markTerminalTaskArchived(previousTask.taskId, "attempt-old");
    registry.register({
      ...previousTask,
      status: "running",
      completedAt: undefined,
      attemptId: "attempt-resume",
      pendingMessages: [acceptedMessage],
    });

    expect(
      restorePreviousTerminalTaskAfterResumeFailure(
        registry,
        previousTask,
        "attempt-resume",
        true,
      ),
    ).toBe(true);
    expect(registry.get(previousTask.taskId)).toMatchObject({
      status: "completed",
      attemptId: "attempt-old",
      pendingMessages: [acceptedMessage],
    });
    expect(registry.isTerminalTaskArchived(previousTask.taskId, "attempt-old")).toBe(true);
    for (let index = 0; index < 512; index += 1) {
      const taskId = `agent_resume_rollback_fill_${index}`;
      registry.register({
        ...previousTask,
        taskId,
        agentId: taskId,
        attemptId: `attempt-${index}`,
        childSessionId: createSessionId(`subagent-resume-rollback-fill-${index}`),
        pendingMessages: undefined,
      });
      registry.markTerminalTaskArchived(taskId, `attempt-${index}`);
    }
    expect(registry.get(previousTask.taskId)?.pendingMessages).toEqual([acceptedMessage]);
    expect(Object.keys(registry.all())).toHaveLength(512);
  });

  it("aborts SendMessage resume readiness and delays terminal state until runtime settlement", async () => {
    const sessionId = createSessionId("subagent-resume-signal-parent");
    const childSessionId = createSessionId("subagent-resume-signal-child");
    const originalTurnId = createTurnId("subagent-resume-signal-original-turn");
    const resumeTurnId = createTurnId("subagent-resume-signal-resume-turn");
    const taskId = "agent_resume_signal";
    const registry = new InMemoryRuntimeTaskRegistry();
    registry.register({
      taskId,
      agentId: taskId,
      agentType: "implementer",
      description: "Resume signal test",
      status: "completed",
      startedAt: new Date(),
      completedAt: new Date(),
      childSessionId,
      parentSessionId: sessionId,
      parentToolCallId: "call_resume_signal_original",
      outputFile: "/tmp/zcode-subagent-resume-signal/agent/output.txt",
      turnId: originalTurnId,
      type: "local_agent",
    });
    const runtimeSetupStarted = createDeferred<void>();
    const runtimeSetupCanFinish = createDeferred<void>();
    const port = createExploreSubagentPort({
      outputRootDir: "/tmp/zcode-subagent-resume-signal",
      runtimeTaskRegistry: registry,
      emitParentEvent: async () => {},
      enqueueParentTaskNotification: () => undefined,
      runExploreAgent: async (request) => {
        runtimeSetupStarted.resolve();
        await runtimeSetupCanFinish.promise;
        return {
          events: [],
          response: "resumed child stopped during startup",
          traceId: request.traceContext.traceId,
        };
      },
    });
    const controller = new AbortController();
    const sendMessage = port.sendMessage?.(
      {
        to: taskId,
        message: "Resume and inspect this change",
        summary: "Inspect the change",
        parentToolCallId: "call_resume_signal",
        sessionId,
        turnId: resumeTurnId,
        trace: {
          traceId: "trace_subagent_resume_signal",
          spanId: "span_subagent_resume_signal",
          sessionId,
          turnId: resumeTurnId,
        },
        workingDirectory: "/tmp/zcode-subagent-resume-signal",
        workspaceRoot: "/tmp/zcode-subagent-resume-signal",
      },
      { signal: controller.signal },
    );
    await runtimeSetupStarted.promise;

    controller.abort(new Error("caller cancelled resume startup"));
    await expect(sendMessage).rejects.toThrow(
      "Agent was cancelled before the subagent returned findings or background launch completed",
    );
    expect(registry.get(taskId)?.status).toBe("running");

    runtimeSetupCanFinish.resolve();
    await port.waitForTask?.(taskId);
    expect(registry.get(taskId)?.status).toBe("killed");
  });

  it.each([
    ["background completion", "completed", false],
    ["background failure", "failed", false],
    ["foreground completion", "completed", true],
  ] as const)(
    "holds terminal waiters and SendMessage resume until %s events settle",
    async (scenario, terminalStatus, foreground) => {
      const sessionId = createSessionId(`subagent-finalize-${scenario}`);
      const firstTurnId = createTurnId(`subagent-finalize-${scenario}-turn`);
      const secondTurnId = createTurnId(
        `subagent-finalize-${scenario}-resume-turn`,
      );
      const taskId = `agent_finalize_${scenario.replaceAll(" ", "_")}`;
      const childCanFinish = createDeferred<void>();
      const firstRuntimeStarted = createDeferred<void>();
      const finalEventStarted = createDeferred<void>();
      const finalEventCanFinish = createDeferred<void>();
      const resumedChildCanFinish = createDeferred<void>();
      const resumedChildStarted = createDeferred<void>();
      let runCount = 0;
      let gatedFinalEvent = false;
      const registry = new InMemoryRuntimeTaskRegistry();
      const port = createExploreSubagentPort({
        createAgentId: () => taskId,
        outputRootDir: `/tmp/zcode-${taskId}`,
        runtimeTaskRegistry: registry,
        emitParentEvent: async (event) => {
          const payload = event.payload as { status?: string };
          if (
            !gatedFinalEvent &&
            event.type === SessionEventType.SubagentStopped &&
            payload.status === terminalStatus
          ) {
            gatedFinalEvent = true;
            finalEventStarted.resolve();
            await finalEventCanFinish.promise;
          }
        },
        enqueueParentTaskNotification: () => undefined,
        runExploreAgent: async (request) => {
          runCount += 1;
          await request.onSessionReady?.();
          if (runCount === 1) {
            firstRuntimeStarted.resolve();
            await childCanFinish.promise;
            if (terminalStatus === "failed") {
              throw new Error("controlled background failure");
            }
            return {
              events: [],
              response: `first ${scenario} settled`,
              traceId: `trace-${taskId}-first`,
            };
          }
          resumedChildStarted.resolve();
          await resumedChildCanFinish.promise;
          return {
            events: [],
            response: `resumed ${scenario} settled`,
            traceId: `trace-${taskId}-resumed`,
          };
        },
      });
      const initialRequest = createSubagentRunRequest({
        sessionId,
        turnId: firstTurnId,
      });
      if (foreground) {
        const run = port.run?.(initialRequest);
        await firstRuntimeStarted.promise;
        childCanFinish.resolve();
        await finalEventStarted.promise;
        expect(registry.get(taskId)?.status).toBe(terminalStatus);

        let terminalWaitSettled = false;
        const terminalWait = port.waitForTask?.(taskId).then((task) => {
          terminalWaitSettled = true;
          return task;
        });
        const sendMessage = port.sendMessage?.(
          createSendMessageRequest(sessionId, secondTurnId, taskId),
        );
        let sendMessageSettled = false;
        void sendMessage?.then(() => {
          sendMessageSettled = true;
        });
        expect(terminalWaitSettled).toBe(false);
        expect(sendMessageSettled).toBe(false);
        expect(runCount).toBe(1);

        finalEventCanFinish.resolve();
        await expect(run).resolves.toMatchObject({ status: "completed" });
        await expect(terminalWait).resolves.toMatchObject({
          status: terminalStatus,
        });
        await expect(sendMessage).resolves.toMatchObject({ status: "success" });
      } else {
        await port.start?.(initialRequest);
        await firstRuntimeStarted.promise;
        childCanFinish.resolve();
        await finalEventStarted.promise;
        expect(registry.get(taskId)?.status).toBe(terminalStatus);

        let terminalWaitSettled = false;
        const terminalWait = port.waitForTask?.(taskId).then((task) => {
          terminalWaitSettled = true;
          return task;
        });
        const sendMessage = port.sendMessage?.(
          createSendMessageRequest(sessionId, secondTurnId, taskId),
        );
        let sendMessageSettled = false;
        void sendMessage?.then(() => {
          sendMessageSettled = true;
        });
        expect(terminalWaitSettled).toBe(false);
        expect(sendMessageSettled).toBe(false);
        expect(runCount).toBe(1);

        finalEventCanFinish.resolve();
        await expect(terminalWait).resolves.toMatchObject({
          status: terminalStatus,
        });
        await expect(sendMessage).resolves.toMatchObject({ status: "success" });
      }

      await resumedChildStarted.promise;
      expect(runCount).toBe(2);
      resumedChildCanFinish.resolve();
      await expect(port.waitForTask?.(taskId)).resolves.toMatchObject({
        status: "completed",
      });
    },
  );

  it("preserves foreground completion when the completion event is rejected", async () => {
    const sessionId = createSessionId("subagent-foreground-event-rejection");
    const firstTurnId = createTurnId("subagent-foreground-event-turn");
    const resumeTurnId = createTurnId(
      "subagent-foreground-event-resume-turn",
    );
    const taskId = "agent_foreground_event_rejection";
    const runtimeStarted = createDeferred<void>();
    const runtimeCanFinish = createDeferred<void>();
    const completionEventStarted = createDeferred<void>();
    const resumedRuntimeStarted = createDeferred<void>();
    const resumedRuntimeCanFinish = createDeferred<void>();
    let rejectCompletionEvent!: (error: Error) => void;
    const completionEventWillReject = new Promise<void>((_, reject) => {
      rejectCompletionEvent = reject;
    });
    let runCount = 0;
    let firstCompletionEvent = true;
    let logger!: Logger;
    logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: () => logger,
    };
    const registry = new InMemoryRuntimeTaskRegistry();
    const port = createExploreSubagentPort({
      createAgentId: () => taskId,
      outputRootDir: `/tmp/zcode-${taskId}`,
      runtimeTaskRegistry: registry,
      logger,
      emitParentEvent: async (event) => {
        const payload = event.payload as { status?: string };
        if (
          firstCompletionEvent &&
          event.type === SessionEventType.SubagentStopped &&
          payload.status === "completed"
        ) {
          firstCompletionEvent = false;
          completionEventStarted.resolve();
          await completionEventWillReject;
        }
      },
      enqueueParentTaskNotification: () => undefined,
      runExploreAgent: async (request) => {
        runCount += 1;
        await request.onSessionReady?.();
        if (runCount === 1) {
          runtimeStarted.resolve();
          await runtimeCanFinish.promise;
          return {
            events: [],
            response: "foreground runtime completed successfully",
            traceId: `trace-${taskId}-first`,
          };
        }
        resumedRuntimeStarted.resolve();
        await resumedRuntimeCanFinish.promise;
        return {
          events: [],
          response: "resumed after event delivery failure",
          traceId: `trace-${taskId}-resumed`,
        };
      },
    });

    let run: ReturnType<NonNullable<typeof port.run>> | undefined;
    let sendMessage: ReturnType<NonNullable<typeof port.sendMessage>> | undefined;
    try {
      run = port.run?.(
        createSubagentRunRequest({ sessionId, turnId: firstTurnId }),
      );
      await runtimeStarted.promise;
      runtimeCanFinish.resolve();
      await completionEventStarted.promise;
      expect(registry.get(taskId)?.status).toBe("completed");

      let terminalWaitSettled = false;
      const terminalWait = port.waitForTask?.(taskId).then((task) => {
        terminalWaitSettled = true;
        return task;
      });
      sendMessage = port.sendMessage?.(
        createSendMessageRequest(sessionId, resumeTurnId, taskId),
      );
      expect(terminalWaitSettled).toBe(false);

      rejectCompletionEvent(new Error("controlled event-store rejection"));
      await expect(run).resolves.toMatchObject({ status: "completed" });
      await expect(terminalWait).resolves.toMatchObject({
        status: "completed",
      });
      await expect(sendMessage).resolves.toMatchObject({ status: "success" });
      await resumedRuntimeStarted.promise;
      expect(runCount).toBe(2);
      expect(logger.warn).toHaveBeenCalledWith(
        "Explore subagent completion event emit failed",
        expect.objectContaining({
          errorMessage: "controlled event-store rejection",
          event: "subagent.completion_event_failed",
          status: "completed",
        }),
      );

      resumedRuntimeCanFinish.resolve();
      await expect(port.waitForTask?.(taskId)).resolves.toMatchObject({
        status: "completed",
      });
    } finally {
      runtimeCanFinish.resolve();
      resumedRuntimeCanFinish.resolve();
      rejectCompletionEvent(new Error("test cleanup released final event"));
      await Promise.all([
        run?.catch(() => undefined),
        sendMessage?.catch(() => undefined),
      ]);
    }
  });

  it("waits for stopped artifacts and events before resuming and returns the cancelled lifecycle", async () => {
    const sessionId = createSessionId("subagent-stopped-finalizer-barrier");
    const firstTurnId = createTurnId("subagent-stopped-finalizer-turn");
    const secondTurnId = createTurnId("subagent-stopped-finalizer-resume-turn");
    const taskId = "agent_stopped_finalizer_barrier";
    const stoppedArtifactStarted = createDeferred<void>();
    const stoppedArtifactCanFinish = createDeferred<void>();
    const stoppedEventStarted = createDeferred<void>();
    const stoppedEventCanFinish = createDeferred<void>();
    const terminalEvents: SessionEvent[] = [];
    const firstRuntimeStarted = createDeferred<void>();
    const firstRuntimeCanSettle = createDeferred<void>();
    const firstRuntimeAborted = createDeferred<void>();
    const resumedRuntimeStarted = createDeferred<void>();
    const resumedRuntimeCanFinish = createDeferred<void>();
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({
      ...actualFs,
      writeFile: vi.fn(
        async (...args: Parameters<typeof actualFs.writeFile>) => {
          const [path, contents] = args;
          if (
            String(path).endsWith("/output.txt") &&
            String(contents).includes("Background agent task stopped.")
          ) {
            stoppedArtifactStarted.resolve();
            await stoppedArtifactCanFinish.promise;
          }
          return actualFs.writeFile(...args);
        },
      ),
    }));

    let stopPromise:
      | Promise<SubagentTaskSnapshot | undefined>
      | undefined;
    try {
      const [{ createExploreSubagentPort: createPortWithGatedWriter }, registryModule] =
        await Promise.all([
          import("../src/subagent/runner.js"),
          import("../src/runtime-task/registry.js"),
        ]);
      const registry = new registryModule.InMemoryRuntimeTaskRegistry();
      let runCount = 0;
      const port = createPortWithGatedWriter({
        createAgentId: () => taskId,
        outputRootDir: `/tmp/zcode-${taskId}`,
        runtimeTaskRegistry: registry,
        emitParentEvent: async (event) => {
          if (event.type === SessionEventType.SubagentExecutionTerminal) {
            terminalEvents.push(event);
          }
          const payload = event.payload as { status?: string };
          if (
            event.type === SessionEventType.SubagentStopped &&
            payload.status === "stopped"
          ) {
            stoppedEventStarted.resolve();
            await stoppedEventCanFinish.promise;
          }
        },
        enqueueParentTaskNotification: () => undefined,
        runExploreAgent: async (request, runOptions) => {
          runCount += 1;
          await request.onSessionReady?.();
          if (runCount === 1) {
            runOptions?.signal?.addEventListener(
              "abort",
              () => firstRuntimeAborted.resolve(),
              { once: true },
            );
            firstRuntimeStarted.resolve();
            await firstRuntimeCanSettle.promise;
            throw runOptions?.signal?.reason ?? new Error("stopped");
          }
          resumedRuntimeStarted.resolve();
          await resumedRuntimeCanFinish.promise;
          return {
            events: [],
            response: "resumed stopped child",
            traceId: `trace-${taskId}-resumed`,
          };
        },
      });

      await port.start?.(
        createSubagentRunRequest({ sessionId, turnId: firstTurnId }),
      );
      await firstRuntimeStarted.promise;
      stopPromise = port.stopTask?.(taskId);
      await firstRuntimeAborted.promise;
      firstRuntimeCanSettle.resolve();
      await stoppedArtifactStarted.promise;

      expect(registry.get(taskId)?.status).toBe("killed");
      let terminalWaitSettled = false;
      const terminalWait = port.waitForTask?.(taskId).then((task) => {
        terminalWaitSettled = true;
        return task;
      });
      const sendMessage = port.sendMessage?.(
        createSendMessageRequest(sessionId, secondTurnId, taskId),
      );
      let sendMessageSettled = false;
      void sendMessage?.then(() => {
        sendMessageSettled = true;
      });
      expect(terminalWaitSettled).toBe(false);
      expect(sendMessageSettled).toBe(false);
      expect(runCount).toBe(1);

      stoppedArtifactCanFinish.resolve();
      await stoppedEventStarted.promise;
      expect(terminalWaitSettled).toBe(false);
      expect(sendMessageSettled).toBe(false);
      expect(runCount).toBe(1);

      stoppedEventCanFinish.resolve();
      await expect(stopPromise).resolves.toMatchObject({ status: "killed" });
      await expect(terminalWait).resolves.toMatchObject({ status: "killed" });
      expect(terminalEvents).toHaveLength(1);
      expect(
        terminalEvents[0]!.payload as SubagentExecutionTerminalPayload,
      ).toMatchObject({
        acceptanceStatus: "unknown",
        childStarted: true,
        taskId,
        terminalStatus: "killed",
      });
      await expect(sendMessage).resolves.toMatchObject({ status: "success" });
      await resumedRuntimeStarted.promise;
      expect(runCount).toBe(2);

      const outputDir = `/tmp/zcode-${taskId}/${sessionId}/${taskId}`;
      const metadata = JSON.parse(
        await actualFs.readFile(`${outputDir}/metadata.json`, "utf8"),
      ) as { resumedFromMessageId?: string; status?: string };
      expect(metadata.status).toBe("running");
      expect(metadata.resumedFromMessageId).toMatch(/^msg_/);

      resumedRuntimeCanFinish.resolve();
      await expect(port.waitForTask?.(taskId)).resolves.toMatchObject({
        status: "completed",
      });
    } finally {
      firstRuntimeCanSettle.resolve();
      stoppedArtifactCanFinish.resolve();
      stoppedEventCanFinish.resolve();
      resumedRuntimeCanFinish.resolve();
      await stopPromise?.catch(() => undefined);
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("resolves finalization as failed and resumes after completion artifact writes reject", async () => {
    const sessionId = createSessionId("subagent-finalizer-write-failure");
    const firstTurnId = createTurnId("subagent-finalizer-write-failure-turn");
    const resumeTurnId = createTurnId(
      "subagent-finalizer-write-failure-resume-turn",
    );
    const taskId = "agent_finalizer_write_failure";
    const firstRuntimeStarted = createDeferred<void>();
    const firstRuntimeCanFinish = createDeferred<void>();
    const firstArtifactWriteFailed = createDeferred<void>();
    const fallbackArtifactWriteFailed = createDeferred<void>();
    const resumedRuntimeStarted = createDeferred<void>();
    const resumedRuntimeCanFinish = createDeferred<void>();
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
    vi.resetModules();
    let rejectedArtifactWrites = 2;
    vi.doMock("node:fs/promises", () => ({
      ...actualFs,
      writeFile: vi.fn(
        async (...args: Parameters<typeof actualFs.writeFile>) => {
          const [path] = args;
          if (
            String(path).endsWith("/output.txt") &&
            rejectedArtifactWrites > 0
          ) {
            rejectedArtifactWrites -= 1;
            if (rejectedArtifactWrites === 1) {
              firstArtifactWriteFailed.resolve();
            } else {
              fallbackArtifactWriteFailed.resolve();
            }
            throw new Error("controlled artifact disk failure");
          }
          return actualFs.writeFile(...args);
        },
      ),
    }));

    try {
      const [{ createExploreSubagentPort: createPortWithFailingWriter }, registryModule] =
        await Promise.all([
          import("../src/subagent/runner.js"),
          import("../src/runtime-task/registry.js"),
        ]);
      const registry = new registryModule.InMemoryRuntimeTaskRegistry();
      let runCount = 0;
      const port = createPortWithFailingWriter({
        createAgentId: () => taskId,
        outputRootDir: `/tmp/zcode-${taskId}`,
        runtimeTaskRegistry: registry,
        emitParentEvent: async () => undefined,
        enqueueParentTaskNotification: () => undefined,
        runExploreAgent: async (request) => {
          runCount += 1;
          await request.onSessionReady?.();
          if (runCount === 1) {
            firstRuntimeStarted.resolve();
            await firstRuntimeCanFinish.promise;
            return {
              events: [],
              response: "runtime completed before artifact failure",
              traceId: `trace-${taskId}-first`,
            };
          }
          resumedRuntimeStarted.resolve();
          await resumedRuntimeCanFinish.promise;
          return {
            events: [],
            response: "resumed after uncertain finalization",
            traceId: `trace-${taskId}-resumed`,
          };
        },
      });

      await port.start?.(
        createSubagentRunRequest({ sessionId, turnId: firstTurnId }),
      );
      await firstRuntimeStarted.promise;
      const terminalWait = port.waitForTask?.(taskId);
      firstRuntimeCanFinish.resolve();
      await firstArtifactWriteFailed.promise;
      expect(registry.get(taskId)?.status).toBe("running");
      await fallbackArtifactWriteFailed.promise;

      await expect(terminalWait).resolves.toMatchObject({
        status: "failed",
        error: "Subagent finalization ended without recording a terminal state.",
      });
      expect(registry.isSubagentTaskFinalizing(taskId)).toBe(false);

      await expect(
        port.sendMessage?.(
          createSendMessageRequest(sessionId, resumeTurnId, taskId),
        ),
      ).resolves.toMatchObject({ status: "success" });
      await resumedRuntimeStarted.promise;
      expect(runCount).toBe(2);

      resumedRuntimeCanFinish.resolve();
      await expect(port.waitForTask?.(taskId)).resolves.toMatchObject({
        status: "completed",
      });
    } finally {
      firstRuntimeCanFinish.resolve();
      resumedRuntimeCanFinish.resolve();
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("formats local_agent task notification as user-role XML", () => {
    const notification = formatTaskNotification({
      outputFile: "/tmp/zcode-agents/sess/agent/output.txt",
      result: "child result",
      status: "completed",
      summary: 'Agent "Audit tests" completed',
      taskId: "agent_123",
      taskType: "local_agent",
      toolUseId: "toolu_123",
      usage: {
        durationMs: 42,
        toolUseCount: 2,
        totalTokens: 9,
      },
    });

    expect(notification).toBe(
      [
        "<task-notification>",
        "<task-id>agent_123</task-id>",
        "<tool-use-id>toolu_123</tool-use-id>",
        "<output-file>/tmp/zcode-agents/sess/agent/output.txt</output-file>",
        "<status>completed</status>",
        "<summary>Agent &quot;Audit tests&quot; completed</summary>",
        "<result>child result</result>",
        "<usage><subagent_tokens>9</subagent_tokens><tool_uses>2</tool_uses><duration_ms>42</duration_ms></usage>",
        "</task-notification>",
      ].join("\n"),
    );
  });

  it("omits unavailable local_agent usage fields", () => {
    const notification = formatTaskNotification({
      outputFile: "/tmp/output.txt",
      status: "completed",
      summary: "Agent completed",
      taskId: "agent_456",
      taskType: "local_agent",
      usage: {
        durationMs: 25,
      },
    });

    expect(notification).toContain(
      "<usage><duration_ms>25</duration_ms></usage>",
    );
    expect(notification).not.toContain("subagent_tokens");
    expect(notification).not.toContain("tool_uses");
  });

  it("formats completed, failed, and stopped local-agent notifications through one helper", () => {
    const base = {
      agentId: "agent_helper",
      agentType: "custom-reviewer",
      description: "Review changes",
      outputFile: "/tmp/agent_helper/output.txt",
      parentToolCallId: "toolu_helper",
      totalDurationMs: 12,
    };

    const completed = formatLocalAgentTaskNotification({
      ...base,
      acceptanceStatus: "verified",
      result: "looks good",
      status: "completed",
      totalTokens: 7,
      totalToolUseCount: 1,
    });
    const failed = formatLocalAgentTaskNotification({
      ...base,
      error: "child failed",
      status: "failed",
    });
    const stopped = formatLocalAgentTaskNotification({
      ...base,
      status: "stopped",
    });

    expect(completed).toContain("<status>completed</status>");
    expect(completed).toContain("<result>looks good</result>");
    expect(completed).toContain(
      "<summary>Agent custom-reviewer task &quot;Review changes&quot; completed. Host acceptance: verified.</summary>",
    );
    expect(completed).not.toContain("<error>");
    expect(completed).toContain("<subagent_tokens>7</subagent_tokens>");
    expect(failed).toContain("<status>failed</status>");
    expect(failed).toContain(
      "<summary>Agent custom-reviewer task &quot;Review changes&quot; failed. child failed</summary>",
    );
    expect(failed).toContain("<error>child failed</error>");
    expect(stopped).toContain("<status>stopped</status>");
    expect(stopped).toContain(
      "<summary>Agent custom-reviewer task &quot;Review changes&quot; stopped.</summary>",
    );
    expect(stopped).not.toContain("<error>");
    expect(stopped).not.toContain("Explore");
  });

  it("drains pending background notifications as strict snapshot batches", async () => {
    const sessionId = createSessionId("background-notification-idle-wake");
    const sessionStore = new RecordingSessionStore();
    const eventStore = createTestSessionEventStore();
    const hookEvents: string[] = [];
    const requestMessages: Array<
      readonly { content: ModelMessageContent; role?: string }[]
    > = [];
    const firstRequestMayFinish = createDeferred<void>();
    const secondRequestMayFinish = createDeferred<void>();
    let requestCount = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        workingDirectory: "/tmp/zcode-background-notification-idle-wake",
      },
      {
        eventStore,
        hookRunner: createInMemoryHookRunner({
          hooks: [
            {
              event: HookEventName.UserPromptSubmit,
              callback: async (input) => {
                hookEvents.push(input.prompt);
                return {
                  hookSpecificOutput: {
                    hookEventName: HookEventName.UserPromptSubmit,
                  },
                };
              },
            },
          ],
        }),
        modelFactory: createTestModelFactory({
          async generateText(request: {
            messages: readonly {
              content: ModelMessageContent;
              role?: string;
            }[];
          }) {
            requestCount += 1;
            requestMessages.push(request.messages);
            if (requestCount === 1) await firstRequestMayFinish.promise;
            if (requestCount === 2) await secondRequestMayFinish.promise;
            return modelTextResult(
              `processed background notification ${requestCount}`,
            );
          },
        } as never),
        sessionStore: sessionStore as unknown as SessionStorePort,
      },
    ) as unknown as {
      enqueueBackgroundTaskNotification(notification: {
        originMeta: {
          backgroundSource: "bash" | "subagent";
          title: string;
          workId: string;
        };
        taskId?: string;
        text: string;
        traceContext: {
          traceId: string;
          spanId: string;
          sessionId: SessionId;
        };
      }): void;
    };
    const traceContext = {
      traceId: "trace_background_idle_wake",
      spanId: "span_background_idle_wake",
      sessionId,
    };

    runtime.enqueueBackgroundTaskNotification({
      originMeta: {
        backgroundSource: "subagent",
        title: "Inspect renderer state",
        workId: "agent_idle_1",
      },
      taskId: "agent_idle_1",
      text: "<task-notification>\n<task-id>agent_idle_1</task-id>\n</task-notification>",
      traceContext,
    });
    await waitForCondition(() => requestMessages.length === 1);

    runtime.enqueueBackgroundTaskNotification({
      originMeta: {
        backgroundSource: "bash",
        title: "pnpm test",
        workId: "agent_idle_2",
      },
      taskId: "agent_idle_2",
      text: "<task-notification>\n<task-id>agent_idle_2</task-id>\n</task-notification>",
      traceContext,
    });
    runtime.enqueueBackgroundTaskNotification({
      originMeta: {
        backgroundSource: "subagent",
        title: "Inspect service state",
        workId: "agent_idle_3",
      },
      taskId: "agent_idle_3",
      text: "<task-notification>\n<task-id>agent_idle_3</task-id>\n</task-notification>",
      traceContext,
    });

    firstRequestMayFinish.resolve(undefined);
    await waitForCondition(() => requestMessages.length === 2);

    runtime.enqueueBackgroundTaskNotification({
      originMeta: {
        backgroundSource: "bash",
        title: "pnpm lint",
        workId: "agent_idle_4",
      },
      taskId: "agent_idle_4",
      text: "<task-notification>\n<task-id>agent_idle_4</task-id>\n</task-notification>",
      traceContext,
    });

    secondRequestMayFinish.resolve(undefined);
    await waitForCondition(() => requestMessages.length === 3);

    const notificationInputs = requestMessages.map((messages) =>
      [...messages]
        .reverse()
        .find((message) =>
          modelMessageContentToText(message.content).includes(
            "<task-notification>",
          ),
        ),
    );
    const notificationTexts = notificationInputs.map((message) =>
      modelMessageContentToText(message?.content),
    );
    expect(notificationTexts[0]).toContain("<task-id>agent_idle_1</task-id>");
    expect(notificationTexts[0]).not.toContain(
      "<task-id>agent_idle_2</task-id>",
    );
    expect(notificationTexts[1]).toContain("<task-id>agent_idle_2</task-id>");
    expect(notificationTexts[1]).toContain("<task-id>agent_idle_3</task-id>");
    expect(notificationTexts[1]).not.toContain(
      "<task-id>agent_idle_4</task-id>",
    );
    expect(notificationTexts[2]).toContain("<task-id>agent_idle_4</task-id>");
    expect(notificationTexts[2]).not.toContain(
      "<task-id>agent_idle_3</task-id>",
    );
    const firstNotificationMessage = notificationInputs[0];
    expect(firstNotificationMessage?.role).toBe("user");
    expect(
      modelMessageContentToText(firstNotificationMessage?.content),
    ).toContain("<system-reminder>");
    expect(hookEvents).toEqual([]);
    expect(requestCount).toBe(3);
    const backgroundMessages = sessionStore.savedMessages.filter(
      (message) => message.source === "background_task",
    );
    expect(
      sessionStore.savedParts.filter(
        (part) =>
          part.type === "text" &&
          part.metadata?.source === "background_task" &&
          part.metadata?.visibility === "model-only",
      ),
    ).toHaveLength(3);
    expect(
      backgroundMessages.map((message) => message.metadata?.originMeta),
    ).toEqual([
      {
        backgroundSource: "subagent",
        title: "Inspect renderer state",
        workId: "agent_idle_1",
      },
      {
        backgroundSource: "bash",
        title: "pnpm test · Inspect service state",
        workId: "agent_idle_2",
      },
      {
        backgroundSource: "bash",
        title: "pnpm lint",
        workId: "agent_idle_4",
      },
    ]);
    const liveBackgroundOriginMetas = (await eventStore.getEvents(sessionId))
      .filter((event) => event.type === SessionEventType.TurnStarted)
      .map(
        (event) =>
          event.payload as {
            inputSource?: string;
            originMeta?: {
              backgroundSource: "bash" | "subagent";
              title: string;
              workId: string;
            };
          },
      )
      .filter((payload) => payload.inputSource === "background_task")
      .map((payload) => payload.originMeta);
    expect(liveBackgroundOriginMetas).toEqual(
      backgroundMessages.map((message) => message.metadata?.originMeta),
    );
    const wakeTurns = (await eventStore.getEvents(sessionId))
      .filter((event) => event.type === SessionEventType.TurnStarted)
      .map(
        (event) =>
          event.payload as {
            inputSource?: string;
            inputId?: string;
            messageId?: string;
          },
      )
      .filter((payload) => payload.inputSource === "background_task");
    expect(wakeTurns).toHaveLength(3);
    expect(new Set(wakeTurns.map((turn) => turn.inputId)).size).toBe(3);
    for (const turn of wakeTurns) {
      expect(turn.inputId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(turn.inputId).not.toBe(turn.messageId);
      expect(
        backgroundMessages.some((message) => message.id === turn.messageId),
      ).toBe(true);
    }
    expect(sessionStore.savedSessionInputs).toHaveLength(4);
    expect(sessionStore.promotedSessionInputs).toHaveLength(4);
    expect(sessionStore.promotedSessionInputs.map((input) => input.id)).toEqual(
      sessionStore.savedSessionInputs.map((input) => input.id),
    );
    expect(sessionStore.promotedSessionInputs[1]?.promotedMessageID).toBe(
      sessionStore.promotedSessionInputs[2]?.promotedMessageID,
    );
    expect(sessionStore.promotedSessionInputs[0]?.promotedMessageID).not.toBe(
      sessionStore.promotedSessionInputs[1]?.promotedMessageID,
    );
    expect(sessionStore.promotedSessionInputs[2]?.promotedMessageID).not.toBe(
      sessionStore.promotedSessionInputs[3]?.promotedMessageID,
    );
  });

  it("reuses ordinary origin metadata for a composed title without guessing missing members", async () => {
    const scenarios: Array<{
      expectedBackgroundSource?: "bash" | "subagent" | "workflow";
      expectedOriginMeta?: BackgroundResultOriginMeta;
      expectedBackgroundSubagentResultConsumed?: boolean;
      /** 批里有 dynamic-workflow run 的通知（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Token telemetry for subagents」）。 */
      expectedWorkflowResultConsumed?: boolean;
      id: string;
      originMetas: Array<BackgroundResultOriginMeta | undefined>;
    }> = [
      {
        // 整批都是 dynamic-workflow run 的通知：backgroundSource 冻结为 workflow，只置 wf 维度。
        expectedBackgroundSource: "workflow",
        expectedOriginMeta: {
          backgroundSource: "workflow",
          title: "Nightly report · Weekly digest",
          workId: "dwfrun-title-1",
        },
        expectedWorkflowResultConsumed: true,
        id: "all-workflow",
        originMetas: [
          {
            backgroundSource: "workflow",
            title: "Nightly report",
            workId: "dwfrun-title-1",
          },
          {
            backgroundSource: "workflow",
            title: "Weekly digest",
            workId: "dwfrun-title-2",
          },
        ],
      },
      {
        // 混批：来源不一致时 backgroundSource 不冻结（既有规则），但两个维度各自按成员置位。
        expectedOriginMeta: {
          backgroundSource: "workflow",
          title: "Nightly report · Inspect service",
          workId: "dwfrun-title-3",
        },
        expectedBackgroundSubagentResultConsumed: true,
        expectedWorkflowResultConsumed: true,
        id: "workflow-and-subagent",
        originMetas: [
          {
            backgroundSource: "workflow",
            title: "Nightly report",
            workId: "dwfrun-title-3",
          },
          {
            backgroundSource: "subagent",
            title: "Inspect service",
            workId: "agent-title-9",
          },
        ],
      },
      {
        expectedOriginMeta: {
          backgroundSource: "subagent",
          title: "Inspect renderer · Run tests · Inspect service · +1",
          workId: "agent-title-1",
        },
        expectedBackgroundSubagentResultConsumed: true,
        id: "complete-metadata",
        originMetas: [
          {
            backgroundSource: "subagent",
            title: "Inspect renderer",
            workId: "agent-title-1",
          },
          {
            backgroundSource: "bash",
            title: "Run tests",
            workId: "bash-title-2",
          },
          {
            backgroundSource: "subagent",
            title: "Inspect service",
            workId: "agent-title-3",
          },
          {
            backgroundSource: "bash",
            title: "Run lint",
            workId: "bash-title-4",
          },
        ],
      },
      {
        expectedOriginMeta: {
          backgroundSource: "bash",
          title: "Run tests · Inspect renderer · Run lint · +1",
          workId: "bash-title-1",
        },
        expectedBackgroundSubagentResultConsumed: true,
        id: "complete-metadata-reversed",
        originMetas: [
          {
            backgroundSource: "bash",
            title: "Run tests",
            workId: "bash-title-1",
          },
          {
            backgroundSource: "subagent",
            title: "Inspect renderer",
            workId: "agent-title-2",
          },
          {
            backgroundSource: "bash",
            title: "Run lint",
            workId: "bash-title-3",
          },
          {
            backgroundSource: "subagent",
            title: "Inspect service",
            workId: "agent-title-4",
          },
        ],
      },
      {
        expectedBackgroundSource: "subagent",
        expectedOriginMeta: {
          backgroundSource: "subagent",
          title: "Inspect renderer · Inspect service",
          workId: "agent-title-5",
        },
        expectedBackgroundSubagentResultConsumed: true,
        id: "all-subagent",
        originMetas: [
          {
            backgroundSource: "subagent",
            title: "Inspect renderer",
            workId: "agent-title-5",
          },
          {
            backgroundSource: "subagent",
            title: "Inspect service",
            workId: "agent-title-6",
          },
        ],
      },
      {
        expectedBackgroundSource: "bash",
        expectedOriginMeta: {
          backgroundSource: "bash",
          title: "Run tests · Run lint",
          workId: "bash-title-7",
        },
        id: "all-bash",
        originMetas: [
          {
            backgroundSource: "bash",
            title: "Run tests",
            workId: "bash-title-7",
          },
          {
            backgroundSource: "bash",
            title: "Run lint",
            workId: "bash-title-8",
          },
        ],
      },
      {
        expectedBackgroundSubagentResultConsumed: true,
        id: "missing-metadata",
        originMetas: [
          {
            backgroundSource: "subagent",
            title: "Inspect renderer",
            workId: "agent-title-legacy-1",
          },
          undefined,
        ],
      },
    ];

    for (const scenario of scenarios) {
      const sessionId = createSessionId(`background-title-${scenario.id}`);
      const sessionStore = new RecordingSessionStore();
      const eventStore = createTestSessionEventStore();
      let requestCount = 0;
      const runtime = createTestAgentRuntime(
        sessionId,
        { workingDirectory: `/tmp/zcode-background-title-${scenario.id}` },
        {
          eventStore,
          modelFactory: createTestModelFactory({
            async generateText() {
              requestCount += 1;
              return modelTextResult("processed notification metadata batch");
            },
          } as never),
          sessionStore: sessionStore as unknown as SessionStorePort,
        },
      ) as unknown as AgentRuntime & {
        drainRuntimeCommandQueue(): Promise<void>;
        enqueueBackgroundTaskNotification(notification: {
          originMeta?: BackgroundResultOriginMeta;
          taskId: string;
          text: string;
          traceContext: {
            sessionId: SessionId;
            spanId: string;
            traceId: string;
          };
        }): void;
        runtimeCommandDrainActive: boolean;
      };
      const traceContext = {
        sessionId,
        spanId: `span_${scenario.id}`,
        traceId: `trace_${scenario.id}`,
      };

      runtime.runtimeCommandDrainActive = true;
      scenario.originMetas.forEach((originMeta, index) => {
        const taskId = `${scenario.id}-${index + 1}`;
        runtime.enqueueBackgroundTaskNotification({
          ...(originMeta ? { originMeta } : {}),
          taskId,
          text: `<task-notification><task-id>${taskId}</task-id></task-notification>`,
          traceContext,
        });
      });
      runtime.runtimeCommandDrainActive = false;

      await runtime.drainRuntimeCommandQueue();

      expect(requestCount).toBe(1);
      const backgroundMessages = sessionStore.savedMessages.filter(
        (message) => message.source === "background_task",
      );
      expect(backgroundMessages).toHaveLength(1);
      expect(backgroundMessages[0]?.metadata?.originMeta).toEqual(
        scenario.expectedOriginMeta,
      );
      const turnStarts = (await eventStore.getEvents(sessionId))
        .filter((event) => event.type === SessionEventType.TurnStarted)
        .map(
          (event) =>
            event.payload as {
              backgroundSource?: "bash" | "subagent" | "workflow";
              inputSource?: string;
              originMeta?: BackgroundResultOriginMeta;
            },
        )
        .filter((payload) => payload.inputSource === "background_task");
      expect(turnStarts).toHaveLength(1);
      expect(turnStarts[0]?.originMeta).toEqual(scenario.expectedOriginMeta);
      expect(turnStarts[0]?.backgroundSource).toBe(
        scenario.expectedBackgroundSource,
      );
      const turnCompletes = (await eventStore.getEvents(sessionId))
        .filter((event) => event.type === SessionEventType.TurnComplete)
        .map(
          (event) =>
            event.payload as {
              backgroundSubagentResultConsumed?: boolean;
              workflowResultConsumed?: boolean;
            },
        );
      expect(turnCompletes).toHaveLength(1);
      expect(turnCompletes[0]?.backgroundSubagentResultConsumed).toBe(
        scenario.expectedBackgroundSubagentResultConsumed,
      );
      expect(turnCompletes[0]?.workflowResultConsumed).toBe(
        scenario.expectedWorkflowResultConsumed,
      );
    }
  });

  it.each(["provider failure", "stop"] as const)(
    "keeps a claimed notification batch durable without command requeue after %s",
    async (terminalOutcome) => {
      const sessionId = createSessionId(
        `background-notification-${terminalOutcome}`,
      );
      const sessionStore = new RecordingSessionStore();
      const firstRequestMayFinish = createDeferred<void>();
      const secondRequestStarted = createDeferred<AbortSignal | undefined>();
      const requestMessages: Array<
        readonly { content: ModelMessageContent }[]
      > = [];
      let requestCount = 0;
      const runtime = createTestAgentRuntime(
        sessionId,
        {
          workingDirectory: `/tmp/zcode-background-notification-${terminalOutcome}`,
        },
        {
          eventStore: createTestSessionEventStore(),
          modelFactory: createTestModelFactory({
            async generateText(request: {
              abortSignal?: AbortSignal;
              messages: readonly { content: ModelMessageContent }[];
            }) {
              requestCount += 1;
              requestMessages.push(request.messages);
              if (requestCount === 1) {
                await firstRequestMayFinish.promise;
                return modelTextResult(
                  "processed first background notification",
                );
              }
              if (requestCount === 2) {
                secondRequestStarted.resolve(request.abortSignal);
                if (terminalOutcome === "stop") {
                  await waitForAbort(request.abortSignal);
                  throw (
                    request.abortSignal?.reason ??
                    new Error("notification batch stopped")
                  );
                }
                throw new Error("notification batch provider failure");
              }
              return modelTextResult(
                "continued after terminal notification batch",
              );
            },
          } as never),
          sessionStore: sessionStore as unknown as SessionStorePort,
        },
      ) as AgentRuntime & {
        enqueueBackgroundTaskNotification(notification: {
          taskId?: string;
          text: string;
          traceContext: {
            traceId: string;
            spanId: string;
            sessionId: SessionId;
          };
        }): void;
      };
      const traceContext = {
        traceId: `trace_background_notification_${terminalOutcome}`,
        spanId: `span_background_notification_${terminalOutcome}`,
        sessionId,
      };

      runtime.enqueueBackgroundTaskNotification({
        taskId: "agent_terminal_1",
        text: "<task-notification><task-id>agent_terminal_1</task-id></task-notification>",
        traceContext,
      });
      await waitForCondition(() => requestCount === 1);
      runtime.enqueueBackgroundTaskNotification({
        taskId: "agent_terminal_2",
        text: "<task-notification><task-id>agent_terminal_2</task-id></task-notification>",
        traceContext,
      });
      runtime.enqueueBackgroundTaskNotification({
        taskId: "agent_terminal_3",
        text: "<task-notification><task-id>agent_terminal_3</task-id></task-notification>",
        traceContext,
      });

      firstRequestMayFinish.resolve(undefined);
      await secondRequestStarted.promise;
      if (terminalOutcome === "stop") {
        expect(
          runtime.stopActiveForegroundExecution({
            reason: "stop notification batch test",
          }),
        ).toMatchObject({ kind: "stopped" });
      }

      const continuation = await runtime.executeTurn(
        "continue after terminal notification batch",
      );
      expect(continuation.response).toBe(
        "continued after terminal notification batch",
      );
      expect(requestCount).toBe(3);
      const secondRequestText = providerMessagesToText(requestMessages[1]!);
      expect(secondRequestText).toContain(
        "<task-id>agent_terminal_2</task-id>",
      );
      expect(secondRequestText).toContain(
        "<task-id>agent_terminal_3</task-id>",
      );
      const continuationText = providerMessagesToText(requestMessages[2]!);
      expect(
        continuationText.match(/<task-id>agent_terminal_2<\/task-id>/g) ?? [],
      ).toHaveLength(1);
      expect(
        continuationText.match(/<task-id>agent_terminal_3<\/task-id>/g) ?? [],
      ).toHaveLength(1);
      expect(
        sessionStore.savedMessages.filter(
          (message) => message.source === "background_task",
        ),
      ).toHaveLength(2);
      expect(sessionStore.promotedSessionInputs).toHaveLength(3);
      expect(sessionStore.promotedSessionInputs[1]?.promotedMessageID).toBe(
        sessionStore.promotedSessionInputs[2]?.promotedMessageID,
      );
    },
  );

  it("wakes idle background notifications without scheduling a timeout", async () => {
    const sessionId = createSessionId("background-notification-idle-wake-ref");
    const sessionStore = new RecordingSessionStore();
    const firstRequest =
      createDeferred<readonly { content: ModelMessageContent }[]>();
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        workingDirectory: "/tmp/zcode-background-notification-idle-wake-ref",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request: {
            messages: readonly { content: ModelMessageContent }[];
          }) {
            firstRequest.resolve(request.messages);
            return modelTextResult(
              "processed referenced background notification",
            );
          },
        } as never),
        sessionStore: sessionStore as unknown as SessionStorePort,
      },
    ) as unknown as {
      enqueueBackgroundTaskNotification(notification: {
        text: string;
        traceContext: {
          traceId: string;
          spanId: string;
          sessionId: SessionId;
        };
      }): void;
    };
    const traceContext = {
      traceId: "trace_background_idle_wake_ref",
      spanId: "span_background_idle_wake_ref",
      sessionId,
    };
    const timeoutRecorder = recordSetTimeoutCalls();

    runtime.enqueueBackgroundTaskNotification({
      text: "<task-notification>\n<task-id>agent_idle_ref</task-id>\n</task-notification>",
      traceContext,
    });
    timeoutRecorder.restore();

    const requestMessages = await firstRequest.promise;
    expect(providerMessagesToText(requestMessages)).toContain(
      "<task-id>agent_idle_ref</task-id>",
    );
    expect(timeoutRecorder.calls).toEqual([]);
  });

  it("保留 loopState 初始化前取消的 background subagent composition 标记", async () => {
    const sessionId = createSessionId(
      "background-notification-pre-loop-cancel",
    );
    const eventStore = createTestSessionEventStore();
    const setupStarted = createDeferred<void>();
    const setupMayFinish = createDeferred<void>();
    const abortController = new AbortController();
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        workingDirectory: "/tmp/zcode-background-notification-pre-loop-cancel",
      },
      {
        eventStore,
        modelAdapter: {
          async generateText() {
            throw new Error("provider request must not start");
          },
        } as never,
      },
    );
    (runtime as any).runUserPromptSubmitHooks = async (...args: any[]) => {
      setupStarted.resolve();
      await setupMayFinish.promise;
      throw args[3]?.reason ?? new Error("cancelled before loop state");
    };

    const turn = (runtime as any).executeTurnCommand(
      "consume background result",
      undefined,
      {
        abortSignal: abortController.signal,
        backgroundSubagentResultConsumed: true,
        inputSource: "background_task",
        inputVisibility: "model-only",
        recordedInputMessageId: "background-result-message",
        skipInputRecord: true,
        traceContext: {
          sessionId,
          spanId: "span_background_notification_pre_loop_cancel",
          traceId: "trace_background_notification_pre_loop_cancel",
        },
      },
    );
    await setupStarted.promise;
    abortController.abort(new Error("user stopped before model loop"));
    setupMayFinish.resolve();

    await expect(turn).rejects.toBeDefined();
    const cancelled = (await eventStore.getEvents(sessionId)).find(
      (event) => event.type === SessionEventType.TurnComplete,
    );
    expect(cancelled?.payload).toMatchObject({
      backgroundSubagentResultConsumed: true,
      resultType: "cancelled",
    });
  });

  it("drains active-loop background notifications into model-only history without starting a turn", async () => {
    const sessionId = createSessionId("background-active-loop-drain");
    const sessionStore = new RecordingSessionStore();
    const generateText = vi.fn();
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        workingDirectory: "/tmp/zcode-background-active-loop-drain",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({ generateText } as never),
        sessionStore: sessionStore as unknown as SessionStorePort,
      },
    ) as unknown as AgentRuntime & {
      drainPendingRuntimeCommandsForActiveLoop(): Promise<{
        consumedCommandIds: readonly string[];
        drained: number;
        messageIds: readonly string[];
      }>;
      messageHistory: {
        toRuntimeEntries(): readonly {
          message: { content: ModelMessageContent };
        }[];
      };
      runtimeCommandQueue: {
        enqueue(command: {
          branchGeneration: number;
          createdAt: Date;
          id: string;
          mode: "task-notification";
          priority: "next";
          source: "background_task";
          text: string;
          traceContext: {
            sessionId: SessionId;
            spanId: string;
            traceId: string;
          };
        }): void;
      };
    };
    const traceContext = {
      traceId: "trace_background_active_loop_drain",
      spanId: "span_background_active_loop_drain",
      sessionId,
    };

    runtime.runtimeCommandQueue.enqueue({
      branchGeneration: 0,
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      mode: "task-notification",
      priority: "next",
      source: "background_task",
      text: "<task-notification><task-id>active-drain-1</task-id></task-notification>",
      traceContext,
    });
    runtime.runtimeCommandQueue.enqueue({
      branchGeneration: 0,
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      mode: "task-notification",
      priority: "next",
      source: "background_task",
      text: "<task-notification><task-id>active-drain-2</task-id></task-notification>",
      traceContext,
    });

    const result = await runtime.drainPendingRuntimeCommandsForActiveLoop();

    expect(result.drained).toBe(2);
    expect(result.messageIds).toHaveLength(2);
    expect(result.consumedCommandIds).toHaveLength(2);
    expect(generateText).not.toHaveBeenCalled();
    const persisted = sessionStore.savedMessages.filter(
      (message) => message.source === "background_task",
    );
    expect(persisted).toHaveLength(2);
    expect(
      persisted.every((message) => message.visibility === "model-only"),
    ).toBe(true);
    const runtimeText = runtime.messageHistory
      .toRuntimeEntries()
      .map((entry) => modelMessageContentToText(entry.message.content))
      .join("\n");
    expect(runtimeText).toContain("<task-id>active-drain-1</task-id>");
    expect(runtimeText).toContain("<task-id>active-drain-2</task-id>");
  });

  it("drops active-loop notifications queued by an older rewind branch generation", async () => {
    const sessionId = createSessionId("background-active-loop-stale-branch");
    const sessionStore = new RecordingSessionStore();
    const runtime = createTestAgentRuntime(
      sessionId,
      { workingDirectory: "/tmp/zcode-background-active-loop-stale-branch" },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          generateText: vi.fn(),
        } as never),
        sessionStore: sessionStore as unknown as SessionStorePort,
      },
    ) as unknown as AgentRuntime & {
      branchGeneration: number;
      drainPendingRuntimeCommandsForActiveLoop(): Promise<{
        consumedCommandIds: readonly string[];
        drained: number;
        messageIds: readonly string[];
      }>;
      runtimeCommandQueue: {
        enqueue(command: {
          branchGeneration: number;
          createdAt: Date;
          id: string;
          mode: "task-notification";
          priority: "next";
          source: "background_task";
          text: string;
          traceContext: {
            sessionId: SessionId;
            spanId: string;
            traceId: string;
          };
        }): void;
      };
    };
    runtime.runtimeCommandQueue.enqueue({
      branchGeneration: 0,
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      mode: "task-notification",
      priority: "next",
      source: "background_task",
      text: "<task-notification><task-id>stale-task</task-id></task-notification>",
      traceContext: {
        traceId: "trace_background_active_loop_stale",
        spanId: "span_background_active_loop_stale",
        sessionId,
      },
    });
    runtime.branchGeneration = 1;

    const result = await runtime.drainPendingRuntimeCommandsForActiveLoop();

    expect(result).toMatchObject({
      drained: 0,
      consumedCommandIds: [],
      messageIds: [],
    });
    expect(sessionStore.savedMessages).toEqual([]);
  });

  it("leaves commands arriving after the active-loop snapshot for the next drain", async () => {
    const sessionId = createSessionId(
      "background-active-loop-continuous-drain",
    );
    const firstSaveStarted = createDeferred<void>();
    const firstSaveMayFinish = createDeferred<void>();
    const sessionStore = new RecordingSessionStore();
    const saveMessage = sessionStore.saveMessage.bind(sessionStore);
    let saveMessageCallCount = 0;
    sessionStore.saveMessage = async (input) => {
      saveMessageCallCount++;
      if (saveMessageCallCount === 1) {
        firstSaveStarted.resolve(undefined);
        await firstSaveMayFinish.promise;
      }
      await saveMessage(input);
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        workingDirectory: "/tmp/zcode-background-active-loop-continuous-drain",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          generateText: vi.fn(),
        } as never),
        sessionStore: sessionStore as unknown as SessionStorePort,
      },
    ) as unknown as AgentRuntime & {
      drainPendingRuntimeCommandsForActiveLoop(): Promise<{
        consumedCommandIds: readonly string[];
        drained: number;
        messageIds: readonly string[];
      }>;
      runtimeCommandQueue: {
        enqueue(command: {
          branchGeneration: number;
          createdAt: Date;
          id: string;
          mode: "task-notification";
          priority: "next";
          source: "background_task";
          text: string;
          traceContext: {
            sessionId: SessionId;
            spanId: string;
            traceId: string;
          };
        }): void;
      };
    };
    const traceContext = {
      traceId: "trace_background_active_loop_continuous_drain",
      spanId: "span_background_active_loop_continuous_drain",
      sessionId,
    };
    const enqueueNotification = (taskId: string) => {
      runtime.runtimeCommandQueue.enqueue({
        branchGeneration: 0,
        createdAt: new Date(),
        id: createRuntimeCommandId(),
        mode: "task-notification",
        priority: "next",
        source: "background_task",
        text: `<task-notification><task-id>${taskId}</task-id></task-notification>`,
        traceContext,
      });
    };

    enqueueNotification("continuous-drain-1");
    const drain = runtime.drainPendingRuntimeCommandsForActiveLoop();
    await firstSaveStarted.promise;
    enqueueNotification("continuous-drain-2");
    firstSaveMayFinish.resolve(undefined);

    const result = await drain;

    expect(result.drained).toBe(1);
    expect(result.messageIds).toHaveLength(1);
    expect(result.consumedCommandIds).toHaveLength(1);
    expect(sessionStore.savedMessages).toHaveLength(1);

    const nextResult = await runtime.drainPendingRuntimeCommandsForActiveLoop();

    expect(nextResult.drained).toBe(1);
    expect(sessionStore.savedMessages).toHaveLength(2);
  });

  it("leaves prompt commands queued when draining active-loop runtime commands", async () => {
    const sessionId = createSessionId("background-active-loop-prompt-drain");
    const sessionStore = new RecordingSessionStore();
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        workingDirectory: "/tmp/zcode-background-active-loop-prompt-drain",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          generateText: vi.fn(),
        } as never),
        sessionStore: sessionStore as unknown as SessionStorePort,
      },
    ) as unknown as AgentRuntime & {
      drainPendingRuntimeCommandsForActiveLoop(): Promise<{
        consumedCommandIds: readonly string[];
        drained: number;
        messageIds: readonly string[];
      }>;
      messageHistory: {
        toRuntimeEntries(): readonly {
          message: { content: ModelMessageContent };
        }[];
      };
      runtimeCommandQueue: {
        enqueue(command: PromptRuntimeCommand): void;
        size(): number;
      };
    };
    const traceContext = {
      traceId: "trace_background_active_loop_prompt",
      spanId: "span_background_active_loop_prompt",
      sessionId,
    };
    const command: PromptRuntimeCommand = {
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      input: "queued prompt stays in outer queue",
      mode: "prompt",
      priority: "next",
      reject: vi.fn(),
      resolve: vi.fn(),
      traceContext,
    };

    runtime.runtimeCommandQueue.enqueue(command);
    const result = await runtime.drainPendingRuntimeCommandsForActiveLoop();

    expect(result.drained).toBe(0);
    expect(result.consumedCommandIds).toEqual([]);
    expect(result.messageIds).toEqual([]);
    expect(runtime.runtimeCommandQueue.size()).toBe(1);
    expect(command.resolve).not.toHaveBeenCalled();
    expect(command.reject).not.toHaveBeenCalled();
    const runtimeText = runtime.messageHistory
      .toRuntimeEntries()
      .map((entry) => modelMessageContentToText(entry.message.content))
      .join("\n");
    expect(runtimeText).not.toContain("queued prompt stays in outer queue");
  });

  it("drops queued child Bash task notifications after the subagent runtime is sealed", async () => {
    const sessionId = createSessionId("background-sealed-child-queued-bash");
    const sessionStore = new RecordingSessionStore();
    const generateText = vi.fn();
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        taskType: "subagent_child",
        workingDirectory: "/tmp/zcode-background-sealed-child-queued-bash",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({ generateText } as never),
        sessionStore: sessionStore as unknown as SessionStorePort,
      },
    ) as unknown as AgentRuntime & {
      backgroundTaskNotificationsSealed: boolean;
      drainRuntimeCommandQueue(): Promise<void>;
      enqueueBackgroundTaskNotification(notification: {
        taskId?: string;
        text: string;
        toolName?: string;
        traceContext: {
          sessionId: SessionId;
          spanId: string;
          traceId: string;
        };
      }): void;
      runtimeCommandDrainActive: boolean;
      runtimeCommandQueue: {
        size(): number;
      };
      sealBackgroundTaskNotifications(input: {
        reason: string;
        traceContext: {
          sessionId: SessionId;
          spanId: string;
          traceId: string;
        };
      }): void;
    };
    const traceContext = {
      traceId: "trace_background_sealed_child_queued_bash",
      spanId: "span_background_sealed_child_queued_bash",
      sessionId,
    };

    runtime.runtimeCommandDrainActive = true;
    runtime.enqueueBackgroundTaskNotification({
      taskId: "child_bash_queued_before_seal",
      text:
        "<task-notification>\n" +
        "<task-id>child_bash_queued_before_seal</task-id>\n" +
        "<status>completed</status>\n" +
        "</task-notification>",
      toolName: "Bash",
      traceContext,
    });
    expect(runtime.runtimeCommandQueue.size()).toBe(1);

    runtime.sealBackgroundTaskNotifications({
      reason: "subagent_terminal",
      traceContext,
    });
    runtime.runtimeCommandDrainActive = false;
    await runtime.drainRuntimeCommandQueue();

    expect(runtime.runtimeCommandQueue.size()).toBe(0);
    expect(generateText).not.toHaveBeenCalled();
    expect(JSON.stringify(sessionStore.savedMessages)).not.toContain(
      "child_bash_queued_before_seal",
    );
  });

  it("filters stale and suppressed members without dropping a valid notification batch member", async () => {
    const sessionId = createSessionId("background-filtered-batch-members");
    const sessionStore = new RecordingSessionStore();
    const requestMessages: Array<readonly { content: ModelMessageContent }[]> =
      [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        taskType: "subagent_child",
        workingDirectory: "/tmp/zcode-background-filtered-batch-members",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request: {
            messages: readonly { content: ModelMessageContent }[];
          }) {
            requestMessages.push(request.messages);
            return modelTextResult("processed valid notification");
          },
        } as never),
        sessionStore: sessionStore as unknown as SessionStorePort,
      },
    ) as unknown as AgentRuntime & {
      branchGeneration: number;
      drainRuntimeCommandQueue(): Promise<void>;
      enqueueBackgroundTaskNotification(notification: {
        taskId?: string;
        text: string;
        toolName?: string;
        traceContext: {
          sessionId: SessionId;
          spanId: string;
          traceId: string;
        };
      }): void;
      runtimeCommandDrainActive: boolean;
      runtimeCommandQueue: {
        enqueue(command: {
          branchGeneration: number;
          createdAt: Date;
          id: string;
          mode: "task-notification";
          priority: "next";
          source: "background_task";
          text: string;
          traceContext: {
            sessionId: SessionId;
            spanId: string;
            traceId: string;
          };
        }): void;
      };
      sealBackgroundTaskNotifications(input: {
        reason: string;
        traceContext: {
          sessionId: SessionId;
          spanId: string;
          traceId: string;
        };
      }): void;
    };
    const traceContext = {
      traceId: "trace_background_filtered_batch_members",
      spanId: "span_background_filtered_batch_members",
      sessionId,
    };

    runtime.branchGeneration = 1;
    runtime.runtimeCommandDrainActive = true;
    runtime.enqueueBackgroundTaskNotification({
      taskId: "suppressed-bash",
      text: "<task-notification><task-id>suppressed-bash</task-id></task-notification>",
      toolName: "Bash",
      traceContext,
    });
    runtime.enqueueBackgroundTaskNotification({
      taskId: "valid-agent",
      text: "<task-notification><task-id>valid-agent</task-id></task-notification>",
      toolName: "Agent",
      traceContext,
    });
    runtime.runtimeCommandQueue.enqueue({
      branchGeneration: 0,
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      mode: "task-notification",
      priority: "next",
      source: "background_task",
      text: "<task-notification><task-id>stale-agent</task-id></task-notification>",
      traceContext,
    });
    runtime.sealBackgroundTaskNotifications({
      reason: "subagent_terminal",
      traceContext,
    });
    runtime.runtimeCommandDrainActive = false;

    await runtime.drainRuntimeCommandQueue();

    expect(requestMessages).toHaveLength(1);
    const requestText = providerMessagesToText(requestMessages[0]!);
    expect(requestText).toContain("<task-id>valid-agent</task-id>");
    expect(requestText).not.toContain("<task-id>suppressed-bash</task-id>");
    expect(requestText).not.toContain("<task-id>stale-agent</task-id>");
    expect(
      sessionStore.savedMessages.filter(
        (message) => message.source === "background_task",
      ),
    ).toHaveLength(1);
  });

  it("queues task-notification commands behind an active prompt command", async () => {
    const sessionId = createSessionId(
      "background-notification-waits-for-prompt",
    );
    const sessionStore = new RecordingSessionStore();
    const firstPromptRequest =
      createDeferred<readonly { content: ModelMessageContent }[]>();
    const firstPromptCanFinish = createDeferred<void>();
    const notificationRequest =
      createDeferred<readonly { content: ModelMessageContent }[]>();
    let requestCount = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        workingDirectory: "/tmp/zcode-background-notification-waits-for-prompt",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request: {
            messages: readonly { content: ModelMessageContent }[];
          }) {
            requestCount += 1;
            if (requestCount === 1) {
              firstPromptRequest.resolve(request.messages);
              await firstPromptCanFinish.promise;
              return modelTextResult("prompt done");
            }
            notificationRequest.resolve(request.messages);
            return modelTextResult("notification done");
          },
        } as never),
        sessionStore: sessionStore as unknown as SessionStorePort,
      },
    ) as unknown as AgentRuntime & {
      enqueueBackgroundTaskNotification(notification: {
        text: string;
        traceContext: {
          traceId: string;
          spanId: string;
          sessionId: SessionId;
        };
      }): void;
    };
    const traceContext = {
      traceId: "trace_background_waits_for_prompt",
      spanId: "span_background_waits_for_prompt",
      sessionId,
    };

    const promptTurn = runtime.executeTurn("user prompt");
    await firstPromptRequest.promise;
    runtime.enqueueBackgroundTaskNotification({
      text: "<task-notification>\n<task-id>agent_waits_for_prompt</task-id>\n</task-notification>",
      traceContext,
    });
    await waitForMacrotask();
    expect(requestCount).toBe(1);

    firstPromptCanFinish.resolve();
    await expect(promptTurn).resolves.toMatchObject({
      response: "prompt done",
    });
    const requestMessages = await notificationRequest.promise;
    expect(providerMessagesToText(requestMessages)).toContain(
      "<task-id>agent_waits_for_prompt</task-id>",
    );
    expect(requestCount).toBe(2);
  });

  it("preserves the provider cause across failed background local-agent surfaces", async () => {
    const providerMessage = [
      "Requests are too frequent.",
      `  Provider spacing and full payload must remain unchanged: ${"x".repeat(520)}`,
      "Request id: unit-background-subagent-rate-limit",
    ].join("\n");
    const sessionId = createSessionId("subagent-background-rate-limit");
    const turnId = createTurnId("subagent-background-rate-limit-turn");
    const notifications: string[] = [];
    const emittedEvents: SessionEvent[] = [];
    const providerError = Object.assign(new Error(providerMessage), {
      code: "model_rate_limited",
      context: {
        providerCode: "AccountRateLimitExceeded",
        statusCode: 429,
      },
      name: "AiSdkModelAdapterError",
    });
    const turnError = createTurnFailureError(
      providerError,
      undefined,
      "Turn execution failed",
    );
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_background_rate_limit",
      emitParentEvent: async (event) => {
        emittedEvents.push(event);
      },
      enqueueParentTaskNotification: ({ text }) => {
        notifications.push(text);
      },
      runExploreAgent: async (request) => {
        await request.onSessionReady?.();
        throw turnError;
      },
    });

    await port.start?.(createSubagentRunRequest({ sessionId, turnId }));
    await waitForCondition(() => notifications.length === 1);
    await waitForCondition(() =>
      emittedEvents.some(
        (event) => event.type === SessionEventType.SubagentStopped,
      ),
    );

    const notification = notifications[0]!;
    expect(notification).toContain(
      `<summary>Agent implementer task &quot;Auto background test&quot; failed. ${providerMessage}</summary>`,
    );
    expect(notification).toContain(`<error>${providerMessage}</error>`);
    expect(notification).not.toContain("Turn execution failed");
    expect(await port.getTask?.("agent_background_rate_limit")).toMatchObject({
      status: "failed",
      error: providerMessage,
    });
    expect(emittedEvents).toContainEqual(
      expect.objectContaining({
        type: SessionEventType.SubagentStopped,
        payload: expect.objectContaining({
          status: "failed",
          error: providerMessage,
        }),
      }),
    );
  });

  it("queues parent notification before emitting background completion", async () => {
    const sessionId = createSessionId(
      "subagent-notification-before-completion-event",
    );
    const turnId = createTurnId(
      "subagent-notification-before-completion-event-turn",
    );
    const childGate = createDeferred<void>();
    const completionEventStarted = createDeferred<void>();
    const completionEventMayFinish = createDeferred<void>();
    const observed: string[] = [];
    let childRuntimeBackground: boolean | undefined;
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_notification_before_completion_event",
      emitParentEvent: async (event) => {
        observed.push(`event:${event.type}`);
        if (event.type === SessionEventType.BackgroundTaskCompleted) {
          completionEventStarted.resolve();
          await completionEventMayFinish.promise;
        }
      },
      enqueueParentTaskNotification: () => {
        observed.push("notification");
      },
      runExploreAgent: async (request) => {
        await request.onSessionReady?.();
        childRuntimeBackground = request.background;
        await childGate.promise;
        return {
          events: [],
          response: "child finished before completion event",
          traceId: "trace_subagent_notification_before_completion_event",
        };
      },
    });

    const output = await port.start?.(
      createSubagentRunRequest({ sessionId, turnId }),
    );
    expect(output).toMatchObject({
      status: "async_launched",
      agentId: "agent_notification_before_completion_event",
    });
    await waitForCondition(() => childRuntimeBackground === true);
    expect(childRuntimeBackground).toBe(true);

    childGate.resolve();
    await completionEventStarted.promise;

    const completedIndex = observed.indexOf(
      `event:${SessionEventType.BackgroundTaskCompleted}`,
    );
    const notificationIndex = observed.indexOf("notification");
    expect(notificationIndex).toBeGreaterThan(-1);
    expect(notificationIndex).toBeLessThan(completedIndex);
    completionEventMayFinish.resolve();
    await waitForCondition(() =>
      observed.includes(`event:${SessionEventType.SubagentStopped}`),
    );
    const stoppedIndex = observed.indexOf(
      `event:${SessionEventType.SubagentStopped}`,
    );
    expect(completedIndex).toBeGreaterThan(-1);
    expect(stoppedIndex).toBeGreaterThan(completedIndex);
  });

  it("auto-backgrounds with a referenced timeout and publishes the child result", async () => {
    const sessionId = createSessionId("subagent-auto-background-timeout-ref");
    const turnId = createTurnId("subagent-auto-background-timeout-ref-turn");
    const childGate = createDeferred<void>();
    const notifications: Array<Record<string, unknown>> = [];
    const port = createExploreSubagentPort({
      autoBackgroundMs: 1,
      createAgentId: () => "agent_auto_background_timeout_ref",
      emitParentEvent: async () => {},
      enqueueParentTaskNotification: (notification) => {
        notifications.push(notification);
      },
      runExploreAgent: async (request) => {
        await request.onSessionReady?.();
        await childGate.promise;
        return {
          events: [],
          response: "auto background timeout ref child finished",
          traceId: "trace_subagent_auto_background_timeout_ref",
        };
      },
    });
    const unrefRecorder = recordSetTimeoutUnrefCalls();

    const outputPromise = port.run(
      createSubagentRunRequest({ sessionId, turnId }),
    );
    let output: Awaited<typeof outputPromise>;
    try {
      output = await outputPromise;
    } finally {
      unrefRecorder.restore();
    }

    expect(output).toMatchObject({
      status: "async_launched",
      agentId: "agent_auto_background_timeout_ref",
      backgroundTaskId: "agent_auto_background_timeout_ref",
    });
    expect(unrefRecorder.calls).toEqual([]);
    childGate.resolve();
    await waitForCondition(() => notifications.length === 1);
    expect(notifications[0]).toMatchObject({
      originMeta: {
        backgroundSource: "subagent",
        title: "Auto background test",
        workId: "agent_auto_background_timeout_ref",
      },
      taskId: "agent_auto_background_timeout_ref",
    });
    expect(notifications[0]?.text).toContain(
      "<task-id>agent_auto_background_timeout_ref</task-id>",
    );
    expect(notifications[0]?.text).toContain("<status>completed</status>");
    expect(notifications[0]?.text).toContain(
      "auto background timeout ref child finished",
    );
  });

  it("keeps allowBackground:false child in the foreground despite autoBackgroundMs", async () => {
    const sessionId = createSessionId("subagent-nested-foreground-auto-background");
    const turnId = createTurnId("subagent-nested-foreground-auto-background-turn");
    const childGate = createDeferred<void>();
    const port = createExploreSubagentPort({
      autoBackgroundMs: 1,
      createAgentId: () => "agent_nested_foreground_auto_background",
      emitParentEvent: async () => {},
      runExploreAgent: async (request) => {
        await request.onSessionReady?.();
        await childGate.promise;
        return {
          events: [],
          response: "nested foreground child finished",
          traceId: "trace_subagent_nested_foreground_auto_background",
        };
      },
    });
    let settled = false;
    const outputPromise = port
      .run(createSubagentRunRequest({ sessionId, turnId }), {
        allowBackground: false,
      })
      .finally(() => {
        settled = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);
    childGate.resolve();
    await expect(outputPromise).resolves.toMatchObject({ status: "completed" });
  });

  it("rejects explicit nested background even when called through the port", async () => {
    const sessionId = createSessionId("subagent-nested-explicit-background");
    const turnId = createTurnId("subagent-nested-explicit-background-turn");
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_nested_explicit_background",
      emitParentEvent: async () => {},
      runExploreAgent: async () => ({
        events: [],
        response: "must not start",
        traceId: "trace_subagent_nested_explicit_background",
      }),
    });

    await expect(
      port.launch?.(
        { ...createSubagentRunRequest({ sessionId, turnId }), runInBackground: true },
        { allowBackground: false },
      ),
    ).rejects.toThrow("Nested subagents cannot run in the background");
  });

  it("does not mark background local agents notified without a parent notification queue", async () => {
    const sessionId = createSessionId("subagent-notification-queue-missing");
    const turnId = createTurnId("subagent-notification-queue-missing-turn");
    const childGate = createDeferred<void>();
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_notification_queue_missing",
      emitParentEvent: async () => {},
      runExploreAgent: async (request) => {
        await request.onSessionReady?.();
        await childGate.promise;
        return {
          events: [],
          response: "child finished without parent queue",
          traceId: "trace_subagent_notification_queue_missing",
        };
      },
    });

    const output = await port.start?.(
      createSubagentRunRequest({ sessionId, turnId }),
    );
    expect(output).toMatchObject({
      status: "async_launched",
      agentId: "agent_notification_queue_missing",
    });

    childGate.resolve();
    await waitForCondition(async () => {
      const task = await port.getTask?.("agent_notification_queue_missing");
      return task?.status === "completed";
    });

    const task = await port.getTask?.("agent_notification_queue_missing");
    expect(task).toMatchObject({
      status: "completed",
      agentId: "agent_notification_queue_missing",
    });
    expect(task?.notified).not.toBe(true);
  });

  it("does not fake-notify background local agents when parent notification enqueue fails", async () => {
    const sessionId = createSessionId("subagent-notification-enqueue-fails");
    const turnId = createTurnId("subagent-notification-enqueue-fails-turn");
    const childGate = createDeferred<void>();
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_notification_enqueue_fails",
      emitParentEvent: async () => {},
      enqueueParentTaskNotification: () => {
        throw new Error("parent queue unavailable");
      },
      runExploreAgent: async (request) => {
        await request.onSessionReady?.();
        await childGate.promise;
        return {
          events: [],
          response: "child finished but parent queue failed",
          traceId: "trace_subagent_notification_enqueue_fails",
        };
      },
    });

    const output = await port.start?.(
      createSubagentRunRequest({ sessionId, turnId }),
    );
    expect(output).toMatchObject({
      status: "async_launched",
      agentId: "agent_notification_enqueue_fails",
    });

    childGate.resolve();
    await waitForCondition(async () => {
      const task = await port.getTask?.("agent_notification_enqueue_fails");
      return task?.status === "completed" || task?.status === "failed";
    });

    const task = await port.getTask?.("agent_notification_enqueue_fails");
    expect(task).toMatchObject({
      status: "completed",
      agentId: "agent_notification_enqueue_fails",
    });
    expect(task?.notified).not.toBe(true);
  });

  it("cancels auto-background timeout when a foreground local agent completes first", async () => {
    const sessionId = createSessionId("subagent-auto-background-cancelled");
    const turnId = createTurnId("subagent-auto-background-cancelled-turn");
    const blockedArtifactWrite = createDeferred<void>();
    let outputWriteStarted = false;
    const notifications: string[] = [];
    const actualFs =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({
      ...actualFs,
      writeFile: vi.fn(
        async (...args: Parameters<typeof actualFs.writeFile>) => {
          const [path] = args;
          if (String(path).endsWith("/output.txt") && !outputWriteStarted) {
            outputWriteStarted = true;
            await blockedArtifactWrite.promise;
          }
          return actualFs.writeFile(...args);
        },
      ),
    }));

    try {
      const { createExploreSubagentPort: createPortWithBlockedArtifactWrite } =
        await import("../src/subagent/runner.js");
      const port = createPortWithBlockedArtifactWrite({
        autoBackgroundMs: 1,
        createAgentId: () => "agent_auto_background_cancelled",
        emitParentEvent: async () => {},
        enqueueParentTaskNotification: ({ text }) => {
          notifications.push(text);
        },
        runExploreAgent: async (request) => {
          await request.onSessionReady?.();
          return {
            events: [],
            response: "foreground child beat timeout",
            traceId: "trace_subagent_auto_background_cancelled",
          };
        },
      });

      const outputPromise = port.run(
        createSubagentRunRequest({ sessionId, turnId }),
      );
      await waitForCondition(() => outputWriteStarted);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const taskWhileArtifactWriteIsPending = await port.getTask?.(
        "agent_auto_background_cancelled",
      );
      blockedArtifactWrite.resolve();

      const output = await outputPromise;
      expect(output).toMatchObject({
        status: "completed",
        agentId: "agent_auto_background_cancelled",
      });
      expect(taskWhileArtifactWriteIsPending).toMatchObject({
        status: "running",
        isBackgrounded: false,
      });

      const task = await port.getTask?.("agent_auto_background_cancelled");
      expect(task).toMatchObject({
        status: "completed",
        isBackgrounded: false,
      });
      expect(notifications).toEqual([]);
    } finally {
      blockedArtifactWrite.resolve();
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("keeps foreground local agents inline when auto-background timeout is not configured", async () => {
    const sessionId = createSessionId("subagent-no-auto-background");
    const turnId = createTurnId("subagent-no-auto-background-turn");
    const notifications: string[] = [];
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_no_auto_background",
      emitParentEvent: async () => {},
      enqueueParentTaskNotification: ({ text }) => {
        notifications.push(text);
      },
      runExploreAgent: async (request) => {
        await request.onSessionReady?.();
        return {
          events: [],
          response: "foreground child finished",
          traceId: "trace_subagent_no_auto_background",
        };
      },
    });

    const output = await port.run(
      createSubagentRunRequest({ sessionId, turnId }),
    );

    expect(output).toMatchObject({
      status: "completed",
      agentId: "agent_no_auto_background",
    });
    expect(notifications).toEqual([]);
  });

  it.each(["explicit", "profile", "timeout"])(
    "supports off-peak background model overrides: %s",
    async (kind) => {
      const gate = createDeferred<void>();
      const calls: unknown[] = [];
      const port = createExploreSubagentPort({
        createAgentId: () => "idle-background",
        ...(kind === "timeout" ? { autoBackgroundMs: 1 } : {}),
        emitParentEvent: async () => {},
        profiles: [
          {
            name: "Idle Reviewer",
            description: "Review",
            source: "user",
            systemPrompt: "Review",
            tools: ["Read"],
            background: kind === "profile",
          },
        ],
        runExploreAgent: async (request, options) => {
          calls.push(options);
          await request.onSessionReady?.();
          await gate.promise;
          return {
            events: [],
            response: "done",
            traceId: "idle-background-trace",
          };
        },
      });
      const modelOverride = {
        selection: { providerId: "idle", modelId: "model" },
        background: "allow" as const,
      };
      try {
        const output = await port.launch(
          {
            ...createSubagentRunRequest({
              sessionId: createSessionId("idle-parent"),
              turnId: createTurnId("idle-turn"),
            }),
            agentType: "Idle Reviewer",
            runInBackground: kind === "explicit",
          },
          { modelOverride },
        );
        expect(output.status).toBe("async_launched");
        expect(calls).toEqual([expect.objectContaining({ modelOverride })]);
      } finally {
        gate.resolve();
      }
    },
  );

  it("rejects background launch when an execution model override is present", async () => {
    const sessionId = createSessionId(
      "subagent-background-turn-execution-model",
    );
    const turnId = createTurnId(
      "subagent-background-turn-execution-model-turn",
    );
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_background_turn_execution_model",
      emitParentEvent: async () => {},
      runExploreAgent: async () => {
        throw new Error("background child must not start");
      },
    });

    await expect(
      port.launch(
        {
          ...createSubagentRunRequest({ sessionId, turnId }),
          runInBackground: true,
        },
        {
          signal: new AbortController().signal,
          modelOverride: {
            selection: {
              providerId: "account:zai-offpeak-idle-plan",
              modelId: "GLM-5.2",
            },
            background: "deny",
          },
        },
      ),
    ).rejects.toThrow("Idle-time tasks do not support background agents");
    expect(
      await port.getTask?.("agent_background_turn_execution_model"),
    ).toBeUndefined();
  });

  it("rejects a profile-configured background agent when an execution model override is present", async () => {
    const sessionId = createSessionId(
      "subagent-profile-background-turn-execution-model",
    );
    const turnId = createTurnId(
      "subagent-profile-background-turn-execution-model-turn",
    );
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_profile_background_turn_execution_model",
      emitParentEvent: async () => {},
      profiles: [
        {
          background: true,
          description: "Background reviewer",
          name: "Background Reviewer",
          source: "user",
          systemPrompt: "Review in background.",
          tools: ["Read"],
        },
      ],
      runExploreAgent: async () => {
        throw new Error("profile background child must not start");
      },
    });

    await expect(
      port.launch(
        {
          ...createSubagentRunRequest({ sessionId, turnId }),
          agentType: "Background Reviewer",
        },
        {
          modelOverride: {
            selection: {
              providerId: "account:zai-offpeak-idle-plan",
              modelId: "GLM-5.2",
            },
            background: "deny",
          },
        },
      ),
    ).rejects.toThrow("Idle-time tasks do not support background agents");
    expect(
      await port.getTask?.("agent_profile_background_turn_execution_model"),
    ).toBeUndefined();
  });
});

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function modelTextResult(text: string) {
  return {
    finishReason: "stop",
    model: "test",
    providerMetadata: undefined,
    text,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    },
  };
}

function providerMessagesToText(
  messages: readonly { content: ModelMessageContent }[],
): string {
  return messages
    .map((message) => modelMessageContentToText(message.content))
    .join("\n");
}

async function waitForMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

async function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (!signal || signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function recordSetTimeoutUnrefCalls(): {
  calls: number[];
  restore: () => void;
} {
  const calls: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: Parameters<typeof setTimeout>[0],
    timeout?: Parameters<typeof setTimeout>[1],
    ...args: any[]
  ) => {
    const timer = originalSetTimeout(handler, timeout, ...args);
    if (
      typeof timer === "object" &&
      timer !== null &&
      "unref" in timer &&
      typeof timer.unref === "function"
    ) {
      const originalUnref = timer.unref.bind(timer);
      timer.unref = () => {
        calls.push(
          typeof timeout === "number" ? timeout : Number(timeout ?? 0),
        );
        return originalUnref();
      };
    }
    return timer;
  }) as typeof setTimeout);
  return {
    calls,
    restore: () => {
      setTimeoutSpy.mockRestore();
    },
  };
}

function recordSetTimeoutCalls(): {
  calls: number[];
  restore: () => void;
} {
  const calls: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: Parameters<typeof setTimeout>[0],
    timeout?: Parameters<typeof setTimeout>[1],
    ...args: any[]
  ) => {
    calls.push(typeof timeout === "number" ? timeout : Number(timeout ?? 0));
    const timer = originalSetTimeout(handler, timeout, ...args);
    return timer;
  }) as typeof setTimeout);
  return {
    calls,
    restore: () => {
      setTimeoutSpy.mockRestore();
    },
  };
}

function seedPrismParentTask(
  registry: InMemoryRuntimeTaskRegistry,
  childOwnerSessionId: SessionId,
): { parentTaskId: string; rootRunId: string } {
  const parentTaskId = `agent_prism_parent_${childOwnerSessionId}`;
  const rootRunId = `root-run-${childOwnerSessionId}`;
  const rootSessionId = createSessionId(`root-${childOwnerSessionId}`);
  registry.setBranchGenerationForSession(childOwnerSessionId, 7);
  registry.register({
    taskId: parentTaskId,
    agentId: parentTaskId,
    agentType: "implementer",
    description: "PRISM test parent",
    status: "running",
    startedAt: new Date(0),
    childSessionId: childOwnerSessionId,
    parentSessionId: rootSessionId,
    rootSessionId,
    rootRunId,
    type: "local_agent",
  });
  return { parentTaskId, rootRunId };
}

function createSubagentRunRequest(input: {
  sessionId: SessionId;
  turnId: ReturnType<typeof createTurnId>;
}) {
  return {
    agentType: "implementer",
    description: "Auto background test",
    parentToolCallId: "call_auto_background",
    prompt: "Run slowly",
    sessionId: input.sessionId,
    trace: {
      traceId: "trace_subagent_auto_background_parent",
      spanId: "span_subagent_auto_background_parent",
      sessionId: input.sessionId,
      turnId: input.turnId,
    },
    turnId: input.turnId,
    workingDirectory: "/tmp/zcode-subagent-auto-background",
    workspaceRoot: "/tmp/zcode-subagent-auto-background",
  };
}

function createSendMessageRequest(
  sessionId: SessionId,
  turnId: ReturnType<typeof createTurnId>,
  to: string,
) {
  return {
    to,
    message: "Resume after finalization completes",
    summary: "Resume the child task",
    parentToolCallId: "call_resume_after_finalization",
    sessionId,
    turnId,
    trace: {
      traceId: `trace-${to}-resume`,
      spanId: `span-${to}-resume`,
      sessionId,
      turnId,
    },
    workingDirectory: "/tmp/zcode-subagent-finalization",
    workspaceRoot: "/tmp/zcode-subagent-finalization",
  };
}

class RecordingSessionStore {
  readonly createdSessions: CreateSessionInput[] = [];
  readonly projectPermissions = new Map<string, PermissionRuleset>();
  readonly savedMessages: MessageInfo[] = [];
  readonly savedParts: MessagePart[] = [];
  readonly savedSessionInputs: Array<
    Parameters<NonNullable<SessionStorePort["saveSessionInput"]>>[0]
  > = [];
  readonly promotedSessionInputs: Array<
    Parameters<NonNullable<SessionStorePort["markSessionInputPromoted"]>>[0]
  > = [];
  readonly sessions = new Map<string, SessionInfo>();
  readonly targets = new Map<string, SessionGoal>();
  readonly todos = new Map<string, TodoItem[]>();

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    this.createdSessions.push(input);
    const now = Date.now();
    const session: SessionInfo = {
      ...input,
      taskType: input.taskType ?? "interactive",
      time: {
        created: input.time?.created ?? now,
        updated: input.time?.updated ?? now,
      },
    };
    this.sessions.set(input.id, session);
    return session;
  }

  async updateSession(
    input: Parameters<SessionStorePort["updateSession"]>[0],
  ): Promise<SessionInfo> {
    const session = this.sessions.get(input.id);
    if (!session) throw new Error(`missing session: ${input.id}`);
    const next: SessionInfo = {
      ...session,
      title: input.title ?? session.title,
      shareURL:
        input.shareURL === null
          ? undefined
          : (input.shareURL ?? session.shareURL),
      summaryAdditions:
        input.summary === null
          ? undefined
          : (input.summary?.additions ?? session.summaryAdditions),
      summaryDeletions:
        input.summary === null
          ? undefined
          : (input.summary?.deletions ?? session.summaryDeletions),
      summaryFiles:
        input.summary === null
          ? undefined
          : (input.summary?.files ?? session.summaryFiles),
      summaryDiffs:
        input.summary === null
          ? undefined
          : (input.summary?.diffs ?? session.summaryDiffs),
      permission:
        input.permission === null
          ? undefined
          : (input.permission ?? session.permission),
      time: {
        ...session.time,
        updated: Date.now(),
        compacting:
          input.timeCompacting === null
            ? undefined
            : (input.timeCompacting ?? session.time.compacting),
      },
    };
    this.sessions.set(input.id, next);
    return next;
  }

  async getSession(sessionID: SessionId): Promise<SessionInfo | null> {
    return this.sessions.get(sessionID) ?? null;
  }

  async listSessions(): Promise<SessionInfo[]> {
    return Array.from(this.sessions.values());
  }

  async saveMessage(input: MessageInfo): Promise<void> {
    this.savedMessages.push(input);
  }

  async removeMessage(input: {
    messageID: MessageInfo["id"];
    sessionID: SessionId;
  }): Promise<void> {
    removeWhere(
      this.savedMessages,
      (message) =>
        message.sessionID === input.sessionID && message.id === input.messageID,
    );
  }

  async savePart(input: MessagePart): Promise<void> {
    this.savedParts.push(input);
  }

  async saveSessionInput(
    input: Parameters<NonNullable<SessionStorePort["saveSessionInput"]>>[0],
  ): Promise<void> {
    this.savedSessionInputs.push(input);
  }

  async markSessionInputPromoted(
    input: Parameters<
      NonNullable<SessionStorePort["markSessionInputPromoted"]>
    >[0],
  ): Promise<void> {
    this.promotedSessionInputs.push(input);
  }

  async removePart(input: {
    messageID: MessageInfo["id"];
    partID: MessagePart["id"];
    sessionID: SessionId;
  }): Promise<void> {
    removeWhere(
      this.savedParts,
      (part) =>
        part.sessionID === input.sessionID &&
        part.messageID === input.messageID &&
        part.id === input.partID,
    );
  }

  async messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]> {
    return this.savedMessages
      .filter((message) => message.sessionID === input.sessionID)
      .map((info) => ({
        info,
        parts: this.savedParts.filter(
          (part) =>
            part.sessionID === input.sessionID && part.messageID === info.id,
        ),
      }));
  }

  async readTodos(input: { sessionID: SessionId }): Promise<TodoItem[]> {
    return [...(this.todos.get(input.sessionID) ?? [])];
  }

  async updateTodos(input: {
    sessionID: SessionId;
    todos: TodoItem[];
  }): Promise<void> {
    this.todos.set(input.sessionID, [...input.todos]);
  }

  async readTarget(input: {
    sessionID: SessionId;
  }): Promise<SessionGoal | null> {
    return this.targets.get(input.sessionID) ?? null;
  }

  async updateTarget(input: {
    sessionID: SessionId;
    target: SessionGoal | null;
  }): Promise<void> {
    if (input.target === null) {
      this.targets.delete(input.sessionID);
      return;
    }
    this.targets.set(input.sessionID, input.target);
  }

  async readProjectPermissions(input: {
    projectID: string;
  }): Promise<PermissionRuleset | null> {
    return this.projectPermissions.get(input.projectID) ?? null;
  }

  async updateProjectPermissions(input: {
    projectID: string;
    permission: PermissionRuleset | null;
  }): Promise<void> {
    if (input.permission === null) {
      this.projectPermissions.delete(input.projectID);
      return;
    }
    this.projectPermissions.set(input.projectID, input.permission);
  }
}

function removeWhere<T>(items: T[], predicate: (item: T) => boolean): void {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index]!)) items.splice(index, 1);
  }
}
