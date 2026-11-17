// ============================================================
// fileTransaction.updated — сериализация и бюджет двух контуров доставки
// ============================================================

import { describe, expect, it } from "vitest";
import {
  FILE_TRANSACTION_COMPACT_BUDGET_BYTES,
  estimateFileTransactionPayloadBytes,
  toCompactFileTransactionPayload,
  zcodeFileTransactionEventPayloadSchema,
  zcodeSessionEventSchema,
  zcodeSessionEventTypeSchema,
  type ZCodeFileTransactionEventPayload,
} from "../src/zcode-protocol/index.js";

const longContent = "x".repeat(4_000);
const manyFiles = Array.from({ length: 40 }, (_, index) => `src/module-${index}.ts`);

function fullPayload(): ZCodeFileTransactionEventPayload {
  return {
    compact: false,
    transactionId: "tx-1",
    workspaceKey: "/workspace",
    workspacePath: "/workspace",
    sessionId: "session-1",
    turnId: "turn-1",
    toolName: "MultiEdit",
    status: "committed",
    timestamp: 1_700_000_000_000,
    affectedPaths: manyFiles,
    backgroundTasks: [
      { taskId: "task-1", toolName: "MultiEdit", status: "running", percent: 40, affectedPathCount: 40 },
    ],
    files: manyFiles.map((path) => ({
      path,
      displayPath: path,
      operation: "update" as const,
      appliedTier: "exact",
      additions: 3,
      deletions: 1,
      syntaxValid: true,
      beforeContent: longContent,
      afterContent: longContent,
      structuredPatch: [{ header: "@@ -1,1 +1,1 @@", lines: ["-a", "+b"] }],
    })),
  } as ZCodeFileTransactionEventPayload;
}

describe("fileTransaction.updated protocol", () => {
  it("registers the event type in the session event enum", () => {
    expect(zcodeSessionEventTypeSchema.safeParse("fileTransaction.updated").success).toBe(true);
  });

  it("validates a full desktop-continuous payload with structured patches", () => {
    const payload = fullPayload();
    expect(zcodeFileTransactionEventPayloadSchema.safeParse(payload).success).toBe(true);
    const event = {
      eventId: "evt-1",
      sessionId: "session-1",
      seq: 1,
      timestamp: 1_700_000_000_000,
      type: "fileTransaction.updated",
      payload,
    };
    expect(zcodeSessionEventSchema.safeParse(event).success).toBe(true);
  });

  it("compacts a web-remote-replayable payload to the byte budget", () => {
    const payload = fullPayload();
    expect(estimateFileTransactionPayloadBytes(payload)).toBeGreaterThan(
      FILE_TRANSACTION_COMPACT_BUDGET_BYTES,
    );

    const compact = toCompactFileTransactionPayload(payload);
    expect(compact.compact).toBe(true);
    expect(estimateFileTransactionPayloadBytes(compact)).toBeLessThanOrEqual(
      FILE_TRANSACTION_COMPACT_BUDGET_BYTES,
    );
    expect(zcodeFileTransactionEventPayloadSchema.safeParse(compact).success).toBe(true);

    // Компактная сводка сохраняет идентичность транзакции и индикатор путей.
    expect(compact.transactionId).toBe("tx-1");
    expect(compact.sessionId).toBe("session-1");
    expect(compact.status).toBe("committed");
    expect(compact.affectedPaths.length).toBeGreaterThan(0);
    // Полный патч и содержимое файлов в компактный контур не попадают.
    const serialized = JSON.stringify(compact);
    expect(serialized).not.toContain("structuredPatch");
    expect(serialized).not.toContain("beforeContent");
  });

  it("keeps compact payload stable when it already fits", () => {
    const small: ZCodeFileTransactionEventPayload = {
      compact: false,
      transactionId: "tx-small",
      workspaceKey: "/workspace",
      sessionId: "session-1",
      toolName: "Write",
      status: "active_diff",
      timestamp: 1,
      affectedPaths: ["a.ts"],
      files: [
        {
          path: "/workspace/a.ts",
          displayPath: "a.ts",
          operation: "create",
          additions: 1,
          deletions: 0,
        },
      ],
    } as ZCodeFileTransactionEventPayload;

    const compact = toCompactFileTransactionPayload(small);
    expect(compact.compact).toBe(true);
    expect(compact.files).toHaveLength(1);
    expect(compact.affectedPaths).toEqual(["a.ts"]);
  });

  it("rejects a payload with an unknown status", () => {
    const invalid = { ...fullPayload(), status: "exploded" };
    expect(zcodeFileTransactionEventPayloadSchema.safeParse(invalid).success).toBe(false);
  });
});
