import { describe, expect, it } from "vitest";
import {
  BashInputSchema,
  type BashOutput,
  type CommandExecutionSpanWriter,
  type CommandTraceStart,
  type ExecutionPort,
  type ExecutionRequest,
  type ExecutionResult,
  type ToolExecutionSpanWriter,
} from "@zcode/contracts";
import { bashHandler, bashToolEntry, createBashToolEntry } from "../bash.js";
import { registerBuiltInTools } from "../index.js";
import { projectToolModelContract } from "../../model-contract.js";
import { createToolRegistry } from "../../registry.js";
import type { ToolExecutionContext } from "../../types.js";
import { validateInitialModelToolInput } from "../../executor/validation.js";

// R04 вариант B (удаление): у ZCode нет OS-sandbox для Bash. Provider-visible
// схема не объявляет sandbox-поле, runtime admission отклоняет legacy-аргумент,
// а внутренний trace и телеметрия честно фиксируют отсутствие изоляции.

const SANDBOX_FIELD = "dangerouslyDisableSandbox";

type SchemaWithProperties = {
  properties?: Record<string, Record<string, unknown>>;
  additionalProperties?: boolean;
};

describe("Bash sandbox honesty (R04 variant B: removal)", () => {
  it("does not expose the sandbox field in the registered provider-visible input schema", () => {
    const schema = resolveRegisteredProviderInputSchema();
    const serialized = JSON.stringify(schema);

    expect(schema.properties).toBeDefined();
    expect(schema.properties).not.toHaveProperty(SANDBOX_FIELD);
    expect(serialized).not.toContain("sandbox");
    // Strict object остаётся: неизвестный ключ не проскочит молча.
    expect(schema.additionalProperties).toBe(false);
  });

  it("does not expose the sandbox field from createBashToolEntry()", () => {
    const entry = createBashToolEntry({
      bashTimeoutPolicy: { defaultTimeoutMs: 250, maxTimeoutMs: 900 },
    });
    const schema = entry.inputSchema as unknown as SchemaWithProperties;
    // Отдельная provider-проекция входа больше не нужна: скрывать нечего.
    expect(entry.resolveModelContract).toBeUndefined();

    expect(schema.properties).toBeDefined();
    expect(schema.properties).not.toHaveProperty(SANDBOX_FIELD);
    expect(JSON.stringify(schema)).not.toContain("sandbox");
    // Кастомный timeout из createBashToolEntry сохраняется.
    expect(schema.properties?.timeout?.description).toBe(
      "Optional timeout in milliseconds (max 900)",
    );
  });

  it("keeps the sandbox field out of the provider-visible output schema", () => {
    for (const entry of [bashToolEntry, createBashToolEntry()]) {
      const schema = entry.outputSchema as unknown as SchemaWithProperties;
      expect(schema.properties).toBeDefined();
      expect(schema.properties).not.toHaveProperty(SANDBOX_FIELD);
      expect(JSON.stringify(schema)).not.toContain("sandbox");
    }
  });

  it("rejects a legacy sandbox argument at the runtime input boundary", () => {
    // Единственный парсер входа: strict-схема без sandbox-поля.
    const parsed = BashInputSchema.safeParse({
      command: "npm test",
      [SANDBOX_FIELD]: true,
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.success ? {} : parsed.error.issues)).toContain(SANDBOX_FIELD);
  });

  it("reports the legacy sandbox argument as a recoverable validation error before execution", () => {
    // Тот же provider-visible inputSchema и тот же admission-путь, что у executor:
    // неожиданный ключ возвращается модели как recoverable ошибка, не падение.
    const error = validateInitialModelToolInput(
      { command: "npm test", [SANDBOX_FIELD]: true },
      bashToolEntry,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("inputSchema");
  });

  it("does not execute or start telemetry when the legacy argument reaches the handler", async () => {
    let executionRuns = 0;
    const commandStarts: CommandTraceStart[] = [];
    const executionPort: ExecutionPort = {
      async run() {
        executionRuns += 1;
        return okResult();
      },
    };

    // Handler отвергает вход обычным отклонённым Promise (ZodError), а не
    // исключением на уровне процесса и не частичным выполнением.
    await expect(
      bashHandler(
        { command: "rm -rf /tmp/legacy", [SANDBOX_FIELD]: true },
        contextWith(executionPort, recordingTelemetry(commandStarts)),
      ),
    ).rejects.toBeInstanceOf(Error);

    expect(executionRuns).toBe(0);
    expect(commandStarts).toHaveLength(0);
  });

  it("never reports sandboxed:true to telemetry on a valid execution", async () => {
    const commandStarts: CommandTraceStart[] = [];

    await bashHandler(
      { command: "npm test" },
      contextWith(fakeExecutionPort(okResult()), recordingTelemetry(commandStarts)),
    );

    expect(commandStarts).toHaveLength(1);
    expect(commandStarts[0]?.sandboxed).toBe(false);
  });

  it("records the internal trace as not implemented, not as an applied policy", async () => {
    let capturedRequest: ExecutionRequest | undefined;
    const executionPort: ExecutionPort = {
      async run(request) {
        capturedRequest = request;
        return okResult();
      },
    };

    await bashHandler({ command: "echo hi" }, contextWith(executionPort));

    expect(capturedRequest?.sandbox?.enabled).toBe(false);
    expect(capturedRequest?.sandbox?.metadata).toEqual({ enforcement: "not_implemented" });
    // Сырой legacy-вход в trace не пересылается: его больше нет во входе.
    expect(capturedRequest?.sandbox).not.toHaveProperty(SANDBOX_FIELD);
  });

  it("does not echo the sandbox field in the Bash result", async () => {
    const output = (await bashHandler(
      { command: "echo hi" },
      contextWith(fakeExecutionPort(okResult())),
    )) as BashOutput;

    expect(output).not.toHaveProperty(SANDBOX_FIELD);
    expect(JSON.stringify(output)).not.toContain("sandbox");
  });

  it("does not change execution or permission behaviour", async () => {
    let capturedRequest: ExecutionRequest | undefined;
    const output = (await bashHandler(
      { command: "npm test" },
      contextWith({
        async run(request) {
          capturedRequest = request;
          return okResult();
        },
      }),
    )) as BashOutput;

    // Команда и cwd идут в adapter тем же путём.
    expect(capturedRequest?.command).toEqual({
      mode: "shell",
      command: "npm test",
      shellProfile: "posix-bash",
    });
    expect(capturedRequest?.cwd).toBe("/work/project");
    expect(output).toMatchObject({ stdout: "ok\n", status: "completed" });

    // Sandbox-аргумента больше нет, поэтому capability зависит только от
    // команды и режима: legacy-ключ не читается и не меняет решение.
    const capability = bashToolEntry.resolvePermissionCapability;
    for (const command of ["npm test", "git reset --hard origin/main"]) {
      const plain = capability?.({ command }, { mode: "guarded" });
      const withLegacyKey = capability?.({ command, [SANDBOX_FIELD]: true }, { mode: "guarded" });
      expect(withLegacyKey).toEqual(plain);
    }
    expect(capability?.({ command: "git reset --hard origin/main" }, { mode: "guarded" })).toEqual({
      userApprovalRule: "safety.bash.git-reset-hard",
    });
  });
});

/** Тот же путь, которым runtime отправляет Bash-схему провайдеру. */
function resolveRegisteredProviderInputSchema(): SchemaWithProperties {
  const registry = createToolRegistry();
  registerBuiltInTools(registry);
  const entry = registry.get("Bash");
  const contract = registry.toContracts().find((tool) => tool.name === "Bash");
  if (!entry || !contract) throw new Error("Bash is not registered");
  const inputSchema = projectToolModelContract(contract, entry, {}).inputSchema;
  return inputSchema as unknown as SchemaWithProperties;
}

/** Телеметрия, которая записывает вход `startCommand` и не трогает I/O. */
function recordingTelemetry(commandStarts: CommandTraceStart[]): ToolExecutionSpanWriter {
  const command: CommandExecutionSpanWriter = {
    captureCausation: () => undefined,
    finishBackgrounded() {},
    finishCancelled() {},
    finishCompleted() {},
    finishFailed() {},
    markFirstOutput() {},
    markTerminationRequested() {},
    run: (execute) => execute(),
    setExitCode() {},
    setOutputBytes() {},
    setSignal() {},
    setTimedOut() {},
  };
  return {
    captureCausation: () => undefined,
    finishCancelled() {},
    finishCompleted() {},
    finishDenied() {},
    finishFailed() {},
    markPermissionRequested() {},
    run: (execute) => execute(),
    setOutputBytes() {},
    setOutputTruncated() {},
    setPermissionDecision() {},
    startCommand: (input) => {
      commandStarts.push(input);
      return command;
    },
  };
}

function fakeExecutionPort(result: ExecutionResult): ExecutionPort {
  return {
    async run() {
      return result;
    },
  };
}

function okResult(): ExecutionResult {
  const now = new Date();
  return {
    status: "completed",
    exitCode: 0,
    stdout: { text: "ok\n", bytes: 3, truncated: false },
    stderr: { text: "", bytes: 0, truncated: false },
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    startedAt: now,
    completedAt: now,
  };
}

function contextWith(
  executionPort: ExecutionPort,
  telemetry?: ToolExecutionSpanWriter,
): ToolExecutionContext {
  return {
    toolCallId: "tool_test",
    traceId: "trace_test",
    spanId: "span_test",
    abortSignal: new AbortController().signal,
    executionPort,
    telemetry,
    workingDirectory: "/work/project",
    workspaceRoot: "/work/project",
    sessionId: "sess_test",
    turnId: "turn_test",
  };
}
