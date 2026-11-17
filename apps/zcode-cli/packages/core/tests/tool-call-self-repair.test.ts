import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { createToolRegistry } from "../src/tool/registry.js";
import {
  MAX_CONSECUTIVE_TOOL_SCHEMA_RETRIES,
  TOOL_CALL_TRUNCATED_BY_MAX_TOKENS,
  attachRawMalformedToolInput,
  coerceInputBySchema,
  repairJsonStringDeterministic,
} from "../src/tool/self-repair/index.js";

const StrictProbeSchema = z.object({
  count: z.number().int(),
  dryRun: z.boolean(),
  options: z
    .object({
      retries: z.number().int(),
    })
    .optional(),
  tags: z.array(z.string()),
});

function createSelfRepairExecutor() {
  const registry = createToolRegistry();
  const capturedInputs: Array<z.infer<typeof StrictProbeSchema>> = [];
  const failureTracker = new Map<string, number>();

  registry.register({
    cancellation: { cleanup: "none", supported: false, userVisibleMessage: "n/a" },
    capability: "Probe tool for ToolCallSelfRepair tests",
    handler: async (input) => {
      capturedInputs.push(input as z.infer<typeof StrictProbeSchema>);
      return { ok: true, received: input };
    },
    inputSchema: z.toJSONSchema(StrictProbeSchema) as Record<string, unknown>,
    metadata: {
      concurrentSafe: true,
      description: "Strict schema probe",
      destructive: false,
      maxOutputBytes: 10_000,
      name: "StrictProbe",
      needsApproval: false,
      readOnly: true,
      riskLevel: "low",
      sideEffectScope: "none",
      timeoutMs: 2_000,
    },
    outputSchema: { type: "object" },
    permission: {
      denyPriority: "beforeAsk",
      needsApproval: false,
      patternSources: ["toolName"],
      permission: "strictProbe",
      reason: "Test probe",
      riskLevel: "low",
      sideEffectScope: "none",
    },
    resultBudget: { maxInlineBytes: 10_000, maxModelBytes: 10_000, strategy: "truncate" },
    runtimeInputSchema: StrictProbeSchema,
    timeout: { allowCallOverride: false, defaultMs: 2_000, maxMs: 2_000 },
    trace: {
      propagateToAdapters: false,
      recordInput: "summary",
      recordOutput: "summary",
      required: true,
    },
  });

  const sessionId = createSessionId("sess_self_repair");
  const turnId = createTurnId("turn_self_repair");
  const executor = createToolExecutor({
    emitEvent: async () => {},
    enableToolCallSelfRepair: true,
    getMode: () => "yolo",
    permissionService: new PermissionService(defaultPermissionConfig),
    registry,
    sessionId,
    traceContext: createRootTraceContext({ sessionId, turnId }),
    turnId,
    workingDirectory: "/workspace",
  });

  return { capturedInputs, executor, failureTracker };
}

describe("Increment 4.1 (F-01): ToolCallSelfRepair (JSON repair, Zod coercion & retry cap)", () => {
  it("repairs markdown fences, trailing commas, and unescaped newlines when finishReason !== 'length'", () => {
    const raw = [
      "```json",
      "{",
      '  "count": 3,',
      '  "dryRun": true,',
      '  "tags": ["alpha",\n"beta",],',
      "}",
      "```",
    ].join("\n");

    const repaired = repairJsonStringDeterministic(raw);
    expect(repaired.ok).toBe(true);
    if (repaired.ok) {
      expect(repaired.value).toEqual({
        count: 3,
        dryRun: true,
        tags: ["alpha", "beta"],
      });
      expect(repaired.appliedStages).toContain("strip_markdown_fences");
      expect(repaired.appliedStages).toContain("fix_trailing_commas");
    }
  });

  it("safely coerces stringified numbers, booleans, arrays, and nested objects via JSON/Zod schema", () => {
    const coerced = coerceInputBySchema(
      {
        count: "42",
        dryRun: "false",
        options: '{"retries":"2"}',
        tags: '["lint", "typecheck"]',
      },
      z.toJSONSchema(StrictProbeSchema) as Record<string, unknown>,
    );

    expect(coerced.appliedStages.length).toBeGreaterThan(0);
    expect(coerced.value).toEqual({
      count: 42,
      dryRun: false,
      options: { retries: 2 },
      tags: ["lint", "typecheck"],
    });
  });

  it("repairs malformed raw JSON + coerces Zod types end-to-end in call-runner when finishReason !== 'length'", async () => {
    const { capturedInputs, executor, failureTracker } = createSelfRepairExecutor();
    const malformedEnvelope = attachRawMalformedToolInput(
      {},
      '```json\n{"count":"7","dryRun":"true","tags":"[\\"core\\",\\"cli\\"]",}\n```',
    );

    const result = await executor.execute(
      {
        id: createToolCallId("call_repair_ok"),
        input: malformedEnvelope,
        name: "StrictProbe",
      },
      { consecutiveSchemaFailuresByTool: failureTracker, finishReason: "tool-calls" },
    );

    expect(result.success).toBe(true);
    expect(capturedInputs).toEqual([
      {
        count: 7,
        dryRun: true,
        tags: ["core", "cli"],
      },
    ]);
    expect(result.repairAttempts).toBeDefined();
    expect(result.repairAttempts?.[0]?.repairedSuccessfully).toBe(true);
  });

  it("refuses blind JSON repair when finishReason === 'length' even inside call-runner", async () => {
    const { capturedInputs, executor, failureTracker } = createSelfRepairExecutor();
    const truncatedEnvelope = attachRawMalformedToolInput(
      {},
      '{"count": 10, "dryRun": true, "tags": ["unterminated',
    );

    const result = await executor.execute(
      {
        id: createToolCallId("call_trunc_refused"),
        input: truncatedEnvelope,
        name: "StrictProbe",
      },
      { consecutiveSchemaFailuresByTool: failureTracker, finishReason: "length" },
    );

    expect(result.success).toBe(false);
    expect(capturedInputs).toHaveLength(0);
    expect(result.failureDiagnostics?.failureKind).toBe("truncated_by_max_tokens");
    expect(String(result.modelContent)).toContain(TOOL_CALL_TRUNCATED_BY_MAX_TOKENS);
  });

  it("returns exact schema diff hint and enforces <= 2 consecutive schema retry cap per tool", async () => {
    const { executor, failureTracker } = createSelfRepairExecutor();
    expect(MAX_CONSECUTIVE_TOOL_SCHEMA_RETRIES).toBe(2);

    const firstFailure = await executor.execute(
      {
        id: createToolCallId("call_bad_1"),
        input: { count: "not-a-number" },
        name: "StrictProbe",
      },
      { consecutiveSchemaFailuresByTool: failureTracker, finishReason: "tool-calls" },
    );
    expect(firstFailure.success).toBe(false);
    expect(String(firstFailure.modelContent)).toContain("Expected schema diff:");
    expect(String(firstFailure.modelContent)).toContain("Missing required fields: dryRun, tags");
    expect(String(firstFailure.modelContent)).not.toContain("RETRY GUARD TRIPPED");
    expect(failureTracker.get("StrictProbe")).toBe(1);

    const secondFailure = await executor.execute(
      {
        id: createToolCallId("call_bad_2"),
        input: { count: "still-bad" },
        name: "StrictProbe",
      },
      { consecutiveSchemaFailuresByTool: failureTracker, finishReason: "tool-calls" },
    );
    expect(secondFailure.success).toBe(false);
    expect(failureTracker.get("StrictProbe")).toBe(2);
    expect(String(secondFailure.modelContent)).toContain("RETRY GUARD TRIPPED");

    // Валидный вызов сбрасывает счётчик последовательных ошибок схемы.
    const recovered = await executor.execute(
      {
        id: createToolCallId("call_valid_reset"),
        input: { count: 1, dryRun: false, tags: ["ok"] },
        name: "StrictProbe",
      },
      { consecutiveSchemaFailuresByTool: failureTracker, finishReason: "tool-calls" },
    );
    expect(recovered.success).toBe(true);
    expect(failureTracker.get("StrictProbe") ?? 0).toBe(0);
  });
});
