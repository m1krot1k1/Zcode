import { describe, expect, it } from "vitest";

import { subagentRowSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  UNCENSORED_TAKEOVER_STATUSES,
  type UncensoredTakeover,
  type UncensoredTakeoverCardProps,
} from "./contract.js";
import {
  cardExample,
  noEnabledModelsExample,
  takeoverExample,
} from "./contract.example.js";
import { uiUncensoredTakeoverModule } from "./module.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("ui-uncensored-takeover contract", () => {
  it("declares its managed module manifest and public entries", () => {
    expect(uiUncensoredTakeoverModule.id).toBe("ui-uncensored-takeover");
    expect(uiUncensoredTakeoverModule.requires).toEqual(["shared", "ui"]);
    expect(uiUncensoredTakeoverModule.provides).toEqual(["ui-uncensored-takeover"]);
    expect(uiUncensoredTakeoverModule.publicEntrypoints).toEqual(["index.ts", "contract.ts"]);
  });

  it("keeps every declared status inside the shared row schema union", () => {
    const schemaStatuses = subagentRowSchema.shape.takeover.unwrap().shape.status.options;
    expect([...UNCENSORED_TAKEOVER_STATUSES].sort()).toEqual([...schemaStatuses].sort());
    expect(new Set(UNCENSORED_TAKEOVER_STATUSES).size).toBe(UNCENSORED_TAKEOVER_STATUSES.length);

    for (const status of UNCENSORED_TAKEOVER_STATUSES) {
      const row = {
        rowId: 1,
        turnId: "turn-1",
        createdAt: 1_700_000_000_000,
        createdAtSeq: 1,
        kind: "subagent" as const,
        subagentType: "uncensored-takeover",
        status: "running" as const,
        summaryText: "Uncensored takeover",
        takeover: {
          taskId: "session-1",
          itemIndex: 0,
          itemText: "Item text",
          modelId: null,
          status,
          output: "",
        },
      };
      expect(subagentRowSchema.parse(row).takeover?.status).toBe(status);
    }
  });

  it("keeps the documented examples valid for the row payload and card props", () => {
    const parsed = subagentRowSchema.parse({
      rowId: 2,
      turnId: "turn-1",
      createdAt: 1_700_000_000_000,
      createdAtSeq: 2,
      kind: "subagent",
      subagentType: "uncensored-takeover",
      status: "success",
      summaryText: "Uncensored takeover",
      takeover: takeoverExample,
    }).takeover as UncensoredTakeover;
    expect(parsed).toEqual(takeoverExample);

    const examples: UncensoredTakeoverCardProps[] = [cardExample, noEnabledModelsExample];
    expect(examples.map((example) => example.takeover.status)).toEqual([
      "done",
      "no-enabled-models",
    ]);
  });
});
