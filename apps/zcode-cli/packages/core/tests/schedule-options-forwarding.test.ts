// 回归：executeToolSchedule 的调度分支曾手工重建 executeBatch 选项，丢掉
// offPeakTurn / finishReason / consecutiveSchemaFailuresByTool：
// - offPeakTurn 丢失会让 assertNotOffPeakTurn 提前 return，绕过闲时轮 handler 级拒绝；
// - finishReason 丢失会让 finishReason=length 的截断输入进入普通自修复，而不是截断恢复；
// - consecutiveSchemaFailuresByTool 丢失会让调用方的连续失败计数不被更新。
// 这里经真实 ToolExecutor 的 executeSchedule 覆盖快路径与分块并发路径。
import { describe, expect, it } from "vitest";
import {
  CoreErrorType,
  createRootTraceContext,
  createSessionId,
  createTurnId,
  type ToolCallId,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { assertNotOffPeakTurn } from "../src/tool/handlers/off-peak.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ToolSchedule } from "../src/tool/scheduler.js";
import type {
  ExecutableToolCall,
  ToolBatchEvent,
  ToolEntry,
  ToolExecutionResult,
  ToolHandler,
} from "../src/tool/types.js";

const STRICT_INPUT_SCHEMA: ToolEntry["inputSchema"] = {
  additionalProperties: false,
  properties: { text: { type: "string" } },
  required: ["text"],
  type: "object",
};

function createFixture(name: string, options: { maxConcurrency?: number } = {}) {
  const sessionId = createSessionId(name);
  const turnId = createTurnId(`${name}-turn`);
  const traceContext = createRootTraceContext({ sessionId, turnId });
  const registry = createToolRegistry();
  return {
    registry,
    traceContext,
    createExecutor() {
      return createToolExecutor({
        emitEvent: async () => {},
        permissionService: new PermissionService(defaultPermissionConfig),
        registry,
        sessionId,
        traceContext,
        turnId,
        ...(options.maxConcurrency === undefined
          ? {}
          : { maxConcurrency: options.maxConcurrency }),
      });
    },
  };
}

function createTestToolEntry(
  name: string,
  handler: ToolHandler,
  inputSchema: ToolEntry["inputSchema"] = { additionalProperties: true, type: "object" },
): ToolEntry {
  return {
    capability: `${name} test capability`,
    handler,
    inputSchema,
    metadata: {
      concurrentSafe: true,
      destructive: false,
      name,
      needsApproval: false,
      readOnly: true,
      riskLevel: "low",
      sideEffectScope: "none",
      timeoutMs: 30000,
    },
    outputSchema: { type: "string" },
    permission: {
      denyPriority: "beforeAsk",
      needsApproval: false,
      patternSources: ["none"],
      permission: "test",
      reason: "test tool",
      riskLevel: "low",
      sideEffectScope: "none",
    },
    resultBudget: {
      maxInlineBytes: 100_000,
      maxModelBytes: 100_000,
      strategy: "truncate",
    },
  };
}

function scheduleFor(ids: readonly string[]): ToolSchedule {
  const toolCallIds = ids.map((id) => id as ToolCallId);
  return {
    items: toolCallIds.map((toolCallId) => ({
      toolCallId,
      dependencies: [],
      canRunParallel: true,
    })),
    parallelGroups: [toolCallIds],
    executionOrder: toolCallIds,
  };
}

async function collectResults(
  generator: AsyncGenerator<ToolBatchEvent, ToolExecutionResult[], void>,
): Promise<ToolExecutionResult[]> {
  for (;;) {
    const next = await generator.next();
    if (next.done) return next.value;
  }
}

describe("executeSchedule 工具选项透传", () => {
  it("快路径把 offPeakTurn 透传到工具执行上下文", async () => {
    const fixture = createFixture("schedule-off-peak-context");
    let seenOffPeakTurn: boolean | undefined;
    fixture.registry.register(
      createTestToolEntry("ObserveOffPeak", async (_input, context) => {
        seenOffPeakTurn = context.offPeakTurn;
        return "ok";
      }),
    );
    const executor = fixture.createExecutor();
    const tools: ExecutableToolCall[] = [
      { id: "observe-1", name: "ObserveOffPeak", input: {} },
    ];

    const results = await collectResults(
      executor.executeSchedule(tools, scheduleFor(["observe-1"]), { offPeakTurn: true }),
    );

    expect(results[0]?.success).toBe(true);
    expect(seenOffPeakTurn).toBe(true);
  });

  it("闲时轮经调度路径仍触发 assertNotOffPeakTurn 的 handler 级拒绝", async () => {
    const fixture = createFixture("schedule-off-peak-deny");
    fixture.registry.register(
      createTestToolEntry("DeniedOnOffPeak", async (_input, context) => {
        assertNotOffPeakTurn(context, "DeniedOnOffPeak", { recoverable: true });
        return "should-not-run";
      }),
    );
    const executor = fixture.createExecutor();
    const tools: ExecutableToolCall[] = [
      { id: "denied-1", name: "DeniedOnOffPeak", input: {} },
    ];

    const results = await collectResults(
      executor.executeSchedule(tools, scheduleFor(["denied-1"]), { offPeakTurn: true }),
    );

    expect(results[0]?.success).toBe(false);
    expect(results[0]?.error?.type).toBe(CoreErrorType.PermissionDenied);
    expect(results[0]?.error?.message).toContain(
      "not allowed while running an idle-time task",
    );
  });

  it("快路径把 finishReason 透传到自修复准入（length 走截断恢复）", async () => {
    const fixture = createFixture("schedule-finish-reason");
    let handlerCalled = false;
    fixture.registry.register(
      createTestToolEntry(
        "Strict",
        async () => {
          handlerCalled = true;
          return "ok";
        },
        STRICT_INPUT_SCHEMA,
      ),
    );
    const executor = fixture.createExecutor();
    const tools: ExecutableToolCall[] = [
      { id: "strict-1", name: "Strict", input: {} },
    ];

    const results = await collectResults(
      executor.executeSchedule(tools, scheduleFor(["strict-1"]), { finishReason: "length" }),
    );

    expect(handlerCalled).toBe(false);
    expect(results[0]?.success).toBe(false);
    expect(results[0]?.failureDiagnostics?.failureKind).toBe("truncated_by_max_tokens");
  });

  it("快路径把 consecutiveSchemaFailuresByTool 透传给自修复准入", async () => {
    const fixture = createFixture("schedule-schema-failures");
    fixture.registry.register(
      createTestToolEntry("Strict", async () => "ok", STRICT_INPUT_SCHEMA),
    );
    const executor = fixture.createExecutor();
    const tools: ExecutableToolCall[] = [
      { id: "strict-2", name: "Strict", input: {} },
    ];
    const failureTracker = new Map<string, number>();

    const results = await collectResults(
      executor.executeSchedule(tools, scheduleFor(["strict-2"]), {
        consecutiveSchemaFailuresByTool: failureTracker,
      }),
    );

    expect(results[0]?.success).toBe(false);
    expect(failureTracker.get("Strict")).toBe(1);
  });

  it("分块并发路径（超过 maxConcurrency）仍透传全部执行选项", async () => {
    const fixture = createFixture("schedule-chunked", { maxConcurrency: 1 });
    let seenOffPeakTurn: boolean | undefined;
    fixture.registry.register(
      createTestToolEntry("ObserveOffPeak", async (_input, context) => {
        seenOffPeakTurn = context.offPeakTurn;
        return "ok";
      }),
    );
    fixture.registry.register(
      createTestToolEntry("Strict", async () => "ok", STRICT_INPUT_SCHEMA),
    );
    const executor = fixture.createExecutor();
    const tools: ExecutableToolCall[] = [
      { id: "observe-2", name: "ObserveOffPeak", input: {} },
      { id: "strict-3", name: "Strict", input: {} },
    ];
    const failureTracker = new Map<string, number>();

    const results = await collectResults(
      executor.executeSchedule(tools, scheduleFor(["observe-2", "strict-3"]), {
        offPeakTurn: true,
        finishReason: "length",
        consecutiveSchemaFailuresByTool: failureTracker,
      }),
    );

    expect(seenOffPeakTurn).toBe(true);
    expect(results[1]?.success).toBe(false);
    expect(results[1]?.failureDiagnostics?.failureKind).toBe("truncated_by_max_tokens");
    expect(failureTracker.get("Strict")).toBe(1);
  });
});
