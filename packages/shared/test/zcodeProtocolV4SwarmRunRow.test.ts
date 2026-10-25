import { describe, expect, it } from "vitest";
import { conversationRowSchema } from "../src/zcode-protocol-v4/rows.js";

const baseRow = {
  rowId: 1,
  turnId: "turn-1",
  createdAt: 1_800_000_000_000,
  createdAtSeq: 1,
  kind: "swarmRun",
  swarmRunId: "swarm-1",
  status: "running",
} as const;

describe("swarmRun conversation row", () => {
  it("parses a lifecycle row and optional bounded summary fields", () => {
    expect(
      conversationRowSchema.parse({
        ...baseRow,
        status: "completed",
        outcomeAcceptance: "verified",
        taskCount: 3,
        summary: "Three branches completed.",
      }),
    ).toMatchObject({
      kind: "swarmRun",
      swarmRunId: "swarm-1",
      status: "completed",
      outcomeAcceptance: "verified",
      taskCount: 3,
      summary: "Three branches completed.",
    });
  });

  it("rejects invalid statuses, negative counts, empty identity, and overlong summaries", () => {
    for (const invalid of [
      { ...baseRow, status: "queued" },
      { ...baseRow, taskCount: -1 },
      { ...baseRow, swarmRunId: "" },
      { ...baseRow, summary: "x".repeat(501) },
    ]) {
      expect(conversationRowSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("accepts the three separate PRISM acceptance states", () => {
    for (const outcomeAcceptance of [
      "unknown",
      "verified",
      "rejected",
    ] as const) {
      expect(
        conversationRowSchema.safeParse({
          ...baseRow,
          status: "completed",
          outcomeAcceptance,
        }).success,
      ).toBe(true);
    }
    expect(
      conversationRowSchema.safeParse({
        ...baseRow,
        status: "completed",
        outcomeAcceptance: "passed",
      }).success,
    ).toBe(false);
  });
});
