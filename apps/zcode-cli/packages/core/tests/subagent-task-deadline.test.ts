import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSessionEvent,
  createSessionId,
  createTraceId,
  createTurnId,
  SessionEventType,
  type SessionEvent,
  type SessionId,
} from "@zcode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryRuntimeTaskRegistry,
  type RuntimeTaskSnapshot,
} from "../src/runtime-task/registry.js";
import { resolveSubagentTaskTimeoutMs } from "../src/runtime/methods/subagent.js";
import { createExploreSubagentPort } from "../src/subagent/runner.js";
import { normalizeAgentProfiles } from "../src/subagent/profile.js";

const WORKSPACE = "/workspace/zcode";
const REVIEWER_DEADLINE_MS = 45 * 60_000;
const RESEARCHER_DEADLINE_MS = 45 * 60_000;
const WORKER_DEADLINE_MS = 45 * 60_000;
const ORCHESTRATOR_DEADLINE_MS = 60 * 60_000;
const START_DEADLINE_MS = 90 * 60_000;
// Synthesis headroom: orchestrator обязан иметь заметный запас сверх child-бюджета.
const MIN_SYNTHESIS_HEADROOM_MS = 15 * 60_000;
const DEADLINE_ERROR = "Subagent task deadline exceeded";

const directories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function createTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "zcode-subagent-deadline-"));
  directories.push(directory);
  return directory;
}

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

function makeRequest(input: {
  agentType: string;
  sessionId: SessionId;
  turnId: ReturnType<typeof createTurnId>;
  parentToolCallId?: string;
}) {
  return {
    agentType: input.agentType,
    description: `${input.agentType} deadline task`,
    parentToolCallId: input.parentToolCallId ?? `call_${input.agentType}`,
    prompt: "Run until the deadline or stop signal",
    sessionId: input.sessionId,
    trace: {
      traceId: createTraceId(),
      sessionId: input.sessionId,
      turnId: input.turnId,
    },
    turnId: input.turnId,
    workingDirectory: WORKSPACE,
    workspaceRoot: WORKSPACE,
  };
}

function stoppedEvents(events: readonly SessionEvent[]): SessionEvent[] {
  return events.filter((event) => event.type === SessionEventType.SubagentStopped);
}

describe("subagent per-role task deadline", () => {
  it("creates no deadline unless subagentTaskTimeoutMinutes is explicitly set", () => {
    for (const role of [
      "start",
      "orchestrator",
      "researcher",
      "reviewer",
      "security-reviewer",
      "implementer",
      "coder",
      "custom-reviewer",
      "Explore",
      "",
    ] as const) {
      expect(() => resolveSubagentTaskTimeoutMs(role)).not.toThrow();
      expect(resolveSubagentTaskTimeoutMs(role)).toBeUndefined();
    }
    // Ноль и невалидные значения не включают таймер.
    expect(resolveSubagentTaskTimeoutMs("coder", 0)).toBeUndefined();
    expect(resolveSubagentTaskTimeoutMs("coder", -5)).toBeUndefined();
    expect(resolveSubagentTaskTimeoutMs("coder", 181)).toBeUndefined();
    expect(resolveSubagentTaskTimeoutMs("coder", 1.5)).toBeUndefined();
  });

  it("applies the configured minimum to every role and keeps router handoff headroom", () => {
    // Настройка — единый минимум для всех ролей; router-ролям добавляется окно синтеза.
    expect(resolveSubagentTaskTimeoutMs("coder", 50)).toBe(50 * 60_000);
    expect(resolveSubagentTaskTimeoutMs("reviewer", 50)).toBe(50 * 60_000);
    expect(resolveSubagentTaskTimeoutMs("orchestrator", 50)).toBe(65 * 60_000);
    expect(resolveSubagentTaskTimeoutMs("start", 50)).toBe(80 * 60_000);
    // Имена нормализуются так же, как admission каталога.
    expect(resolveSubagentTaskTimeoutMs("Security Reviewer", 50)).toBe(50 * 60_000);
    expect(resolveSubagentTaskTimeoutMs("START", 50)).toBe(80 * 60_000);
  });

  it("terminal-fails a reviewer at its configured role deadline, aborts the child and releases the handle", async () => {
    vi.useFakeTimers();
    const directory = createTempDirectory();
    const registry = new InMemoryRuntimeTaskRegistry();
    const sessionId = createSessionId("subagent-deadline-reviewer");
    const turnId = createTurnId("subagent-deadline-reviewer-turn");
    const agentId = "agent_deadline_reviewer";
    const emittedEvents: SessionEvent[] = [];
    const childStarted = createDeferred<void>();
    let childSignal: AbortSignal | undefined;
    const port = createExploreSubagentPort({
      createAgentId: () => agentId,
      emitParentEvent: async (event) => {
        emittedEvents.push(event);
      },
      // Watchdog не должен сработать раньше per-role deadline.
      inactivityTimeoutMs: 2 * 60 * 60_000,
      outputRootDir: directory,
      profiles: normalizeAgentProfiles([]),
      runtimeTaskRegistry: registry,
      getTaskTimeoutMs: (agentType) => resolveSubagentTaskTimeoutMs(agentType, 45),
      runExploreAgent: (_request, options) => {
        childSignal = options?.signal;
        childStarted.resolve();
        // Child игнорирует abort: terminal-факт обязан появиться по deadline.
        return new Promise(() => {});
      },
    });

    const runPromise = port.run(makeRequest({ agentType: "reviewer", sessionId, turnId }));
    const rejection = expect(runPromise).rejects.toThrow(DEADLINE_ERROR);
    // Deadline стартует раньше setup, но abort обязан дойти до уже запущенного child.
    await childStarted.promise;

    await vi.advanceTimersByTimeAsync(REVIEWER_DEADLINE_MS);
    await rejection;

    expect(childSignal?.aborted).toBe(true);
    await expect(port.waitForTask?.(agentId)).resolves.toMatchObject({
      error: DEADLINE_ERROR,
      status: "failed",
    });
    expect(registry.get(agentId)).toMatchObject({
      error: DEADLINE_ERROR,
      status: "failed",
    });
    // Handle освобождён и finisher завершён: повторный stop не создаёт второй terminal.
    expect(registry.isSubagentTaskFinalizing(agentId)).toBe(false);
    await expect(port.stopTask?.(agentId)).resolves.toMatchObject({ status: "failed" });
    expect(stoppedEvents(emittedEvents)).toHaveLength(1);
    expect((stoppedEvents(emittedEvents)[0]!.payload as { status: string }).status).toBe("failed");
  });

  it("returns committed assistant text as a partial report when the deadline fires", async () => {
    vi.useFakeTimers();
    const directory = createTempDirectory();
    const registry = new InMemoryRuntimeTaskRegistry();
    const sessionId = createSessionId("subagent-deadline-partial");
    const turnId = createTurnId("subagent-deadline-partial-turn");
    const agentId = "agent_deadline_partial";
    const partialText = "collected child evidence and partial synthesis";
    const emittedEvents: SessionEvent[] = [];
    const childStarted = createDeferred<void>();
    const terminalEmitted = createDeferred<void>();
    const readCursors: Array<{ cursor: number; sessionId: SessionId }> = [];
    const port = createExploreSubagentPort({
      createAgentId: () => agentId,
      emitParentEvent: async (event) => {
        emittedEvents.push(event);
        if (event.type === SessionEventType.SubagentStopped) terminalEmitted.resolve();
      },
      // Child events уже закоммичены к моменту deadline: partial обязан попасть в отчёт.
      getChildEventsAfter: async (childSessionId, cursor) => {
        readCursors.push({ cursor, sessionId: childSessionId });
        return [
          createSessionEvent(
            SessionEventType.AssistantMessage,
            childSessionId,
            { content: partialText },
            { turnId, traceId: createTraceId() },
          ),
        ];
      },
      inactivityTimeoutMs: 2 * 60 * 60_000,
      outputRootDir: directory,
      profiles: normalizeAgentProfiles([]),
      runtimeTaskRegistry: registry,
      getTaskTimeoutMs: () => 10_000,
      runExploreAgent: () => {
        childStarted.resolve();
        // Child игнорирует abort: terminal-факт обязан появиться по deadline.
        return new Promise(() => {});
      },
    });

    const runPromise = port.run(makeRequest({ agentType: "orchestrator", sessionId, turnId }));
    const rejection = runPromise.then(
      () => undefined,
      (error: unknown) => error,
    );
    await childStarted.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    const rejected = await rejection;

    // Parent Task получает canonical error вместе с уже собранным partial text.
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toContain(DEADLINE_ERROR);
    expect((rejected as Error).message).toContain(`Partial report:\n${partialText}`);
    expect(readCursors).toEqual([{ cursor: 0, sessionId: expect.any(String) as unknown as SessionId }]);
    // Registry остаётся каноническим: partial не подменяет deadline-факт и не плодит финализаторов.
    expect(registry.get(agentId)).toMatchObject({
      error: DEADLINE_ERROR,
      status: "failed",
    });

    // Abort доставляет rejection раньше artifact/terminal записи: ждём финализатор.
    await terminalEmitted.promise;
    // releaseTaskAbortHandle выполняется в finally после emit; даём континуации пройти.
    await vi.advanceTimersByTimeAsync(0);
    expect(registry.isSubagentTaskFinalizing(agentId)).toBe(false);
    const stopped = stoppedEvents(emittedEvents);
    expect(stopped).toHaveLength(1);
    expect((stopped[0]!.payload as { error: string }).error).toContain(
      `Partial report:\n${partialText}`,
    );
    // Артефакт фиксирует тот же partial, что уходит в abort reason.
    expect(
      readFileSync(join(directory, sessionId, agentId, "output.txt"), "utf8"),
    ).toContain(`Partial report:\n${partialText}`);
  });

  it("clears the deadline on successful completion and ignores a late timer", async () => {
    vi.useFakeTimers();
    const directory = createTempDirectory();
    const registry = new InMemoryRuntimeTaskRegistry();
    const sessionId = createSessionId("subagent-deadline-success");
    const turnId = createTurnId("subagent-deadline-success-turn");
    const agentId = "agent_deadline_success";
    const emittedEvents: SessionEvent[] = [];
    const port = createExploreSubagentPort({
      createAgentId: () => agentId,
      emitParentEvent: async (event) => {
        emittedEvents.push(event);
      },
      inactivityTimeoutMs: 2 * 60 * 60_000,
      outputRootDir: directory,
      profiles: normalizeAgentProfiles([]),
      runtimeTaskRegistry: registry,
      getTaskTimeoutMs: () => 1_000,
      runExploreAgent: async (request) => ({
        events: [],
        response: "review completed",
        traceId: request.traceContext.traceId,
      }),
    });

    await expect(
      port.run(makeRequest({ agentType: "reviewer", sessionId, turnId })),
    ).resolves.toMatchObject({ status: "completed" });
    expect(registry.get(agentId)?.status).toBe("completed");
    // Deadline timer снят вместе с settlement: других pending timers не осталось.
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(registry.get(agentId)?.status).toBe("completed");
    expect(stoppedEvents(emittedEvents)).toHaveLength(1);
    expect((stoppedEvents(emittedEvents)[0]!.payload as { status: string }).status).toBe(
      "completed",
    );
  });

  it("terminal-fails an explicit background start and emits one background notification", async () => {
    vi.useFakeTimers();
    const directory = createTempDirectory();
    const registry = new InMemoryRuntimeTaskRegistry();
    const sessionId = createSessionId("subagent-deadline-background");
    const turnId = createTurnId("subagent-deadline-background-turn");
    const agentId = "agent_deadline_background";
    const emittedEvents: SessionEvent[] = [];
    const notifications: string[] = [];
    const port = createExploreSubagentPort({
      createAgentId: () => agentId,
      emitParentEvent: async (event) => {
        emittedEvents.push(event);
      },
      enqueueParentTaskNotification: (notification) => {
        notifications.push(notification.text);
        return undefined;
      },
      inactivityTimeoutMs: 60 * 60_000,
      outputRootDir: directory,
      profiles: normalizeAgentProfiles([]),
      runtimeTaskRegistry: registry,
      getTaskTimeoutMs: (agentType) => (agentType === "reviewer" ? 10_000 : undefined),
      runExploreAgent: async (request) => {
        await request.onSessionReady?.();
        return new Promise(() => {});
      },
    });

    await expect(
      port.start!(makeRequest({ agentType: "reviewer", sessionId, turnId })),
    ).resolves.toMatchObject({ status: "async_launched" });

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(port.waitForTask?.(agentId)).resolves.toMatchObject({
      error: DEADLINE_ERROR,
      status: "failed",
    });
    expect(registry.isSubagentTaskFinalizing(agentId)).toBe(false);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("<status>failed</status>");
    expect(notifications[0]).toContain(DEADLINE_ERROR);
    const stopped = stoppedEvents(emittedEvents);
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.payload as { background?: boolean; status: string }).toMatchObject({
      background: true,
      status: "failed",
    });
  });

  it("keeps a user stop idempotent when the background deadline fires afterwards", async () => {
    vi.useFakeTimers();
    const directory = createTempDirectory();
    const registry = new InMemoryRuntimeTaskRegistry();
    const sessionId = createSessionId("subagent-deadline-stop-race");
    const turnId = createTurnId("subagent-deadline-stop-race-turn");
    const agentId = "agent_deadline_stop_race";
    const emittedEvents: SessionEvent[] = [];
    const port = createExploreSubagentPort({
      createAgentId: () => agentId,
      emitParentEvent: async (event) => {
        emittedEvents.push(event);
      },
      enqueueParentTaskNotification: () => undefined,
      inactivityTimeoutMs: 60_000,
      outputRootDir: directory,
      profiles: normalizeAgentProfiles([]),
      runtimeTaskRegistry: registry,
      getTaskTimeoutMs: () => 10_000,
      runExploreAgent: async (request, options) => {
        await request.onSessionReady?.();
        return new Promise((_resolve, reject) => {
          // Stop может прийти между readiness и установкой listener — проверяем сразу.
          if (options?.signal?.aborted) {
            reject(options.signal.reason ?? new Error("aborted"));
            return;
          }
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        });
      },
    });

    await port.start!(makeRequest({ agentType: "reviewer", sessionId, turnId }));
    const stopResult = await port.stopTask?.(agentId);
    expect(stopResult).toMatchObject({ status: "killed" });

    // Даём исходному deadline-таймеру истечь: terminal и события не должны задвоиться.
    await vi.advanceTimersByTimeAsync(60_000);
    const task = registry.get(agentId);
    expect(task?.status).toBe("killed");
    expect((task as RuntimeTaskSnapshot | undefined)?.error).not.toBe(DEADLINE_ERROR);
    expect(stoppedEvents(emittedEvents)).toHaveLength(1);
    expect((stoppedEvents(emittedEvents)[0]!.payload as { status: string }).status).toBe("stopped");
  });

  it("applies each role deadline at its own nesting level", async () => {
    vi.useFakeTimers();
    const directory = createTempDirectory();
    const registry = new InMemoryRuntimeTaskRegistry();
    const sessionId = createSessionId("subagent-deadline-nested");
    const turnId = createTurnId("subagent-deadline-nested-turn");
    const parentAgentId = "agent_deadline_nested_orchestrator";
    const childAgentId = "agent_deadline_nested_reviewer";
    const nestedStarted = createDeferred<void>();
    const childStarted = createDeferred<void>();
    const emittedEvents: SessionEvent[] = [];
    let agentSequence = 0;
    let childSignal: AbortSignal | undefined;
    let nestedRun: Promise<unknown> | undefined;
    const port = createExploreSubagentPort({
      createAgentId: () => (agentSequence++ === 0 ? parentAgentId : childAgentId),
      emitParentEvent: async (event) => {
        emittedEvents.push(event);
      },
      inactivityTimeoutMs: 2 * 60 * 60_000,
      outputRootDir: directory,
      profiles: normalizeAgentProfiles([]),
      runtimeTaskRegistry: registry,
      getTaskTimeoutMs: (agentType) => resolveSubagentTaskTimeoutMs(agentType, 45),
      runExploreAgent: (request, options) => {
        if (request.agentType === "reviewer") {
          childSignal = options?.signal;
          childStarted.resolve();
          return new Promise(() => {});
        }
        // Тот же порт имитирует child runtime: nesting-уровень получает собственный таймер.
        nestedRun = port.run(
          makeRequest({
            agentType: "reviewer",
            parentToolCallId: "call_nested_reviewer",
            sessionId,
            turnId,
          }),
        );
        nestedRun.catch(() => undefined);
        nestedStarted.resolve();
        return new Promise(() => {});
      },
    });

    const parentRun = port.run(makeRequest({ agentType: "orchestrator", sessionId, turnId }));
    const parentErrorPromise = parentRun.then(
      () => undefined,
      (error: unknown) => error,
    );
    await nestedStarted.promise;
    await childStarted.promise;

    await vi.advanceTimersByTimeAsync(REVIEWER_DEADLINE_MS);
    await expect(nestedRun).rejects.toThrow(DEADLINE_ERROR);
    await expect(port.waitForTask?.(childAgentId)).resolves.toMatchObject({
      error: DEADLINE_ERROR,
      status: "failed",
    });
    expect(childSignal?.aborted).toBe(true);
    expect(registry.get(childAgentId)).toMatchObject({
      error: DEADLINE_ERROR,
      status: "failed",
    });
    // Родитель продолжает работу до собственного бюджета.
    expect(registry.get(parentAgentId)?.status).toBe("running");

    await vi.advanceTimersByTimeAsync(ORCHESTRATOR_DEADLINE_MS - REVIEWER_DEADLINE_MS);
    const parentError = await parentErrorPromise;
    expect(parentError).toBeInstanceOf(Error);
    expect((parentError as Error).message).toContain(DEADLINE_ERROR);
    await expect(port.waitForTask?.(parentAgentId)).resolves.toMatchObject({
      error: DEADLINE_ERROR,
      status: "failed",
    });
    expect(stoppedEvents(emittedEvents)).toHaveLength(2);
  });

  it("requires the orchestrator to surface partial context without inventing a deadline", () => {
    const orchestrator = normalizeAgentProfiles([]).find(
      (profile) => profile.name === "orchestrator",
    );
    expect(orchestrator).toBeDefined();
    const prompt = orchestrator!.systemPrompt;
    // Контракт: partial из отчётов веток возвращается с накопленным контекстом, но
    // собственный тайм-бюджет или deadline агентом не вводится.
    expect(prompt).toContain("partial");
    expect(prompt).toContain("Не задавай веткам собственный тайм-бюджет");
    expect(prompt).not.toContain("hard deadline");
    expect(prompt).not.toContain("5 минут");
    // Router остаётся routing-only: промпт не добавляет read/exec-capabilities.
    expect(prompt).not.toMatch(/тебе доступн\w* (Read|Glob|Grep|Bash)/i);
  });
});
