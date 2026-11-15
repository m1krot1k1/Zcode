import { beforeEach, describe, expect, it } from "vitest";
import {
  toLiveSubagentUsage,
  useSubagentUsageStore,
} from "@/store/subagentsStore.js";

describe("subagent live usage store", () => {
  beforeEach(() => {
    useSubagentUsageStore.getState().clearAll();
  });

  it("maps cached usage fields and keeps the live value by child session", () => {
    const usage = toLiveSubagentUsage({
      inputTokens: 900,
      outputTokens: 300,
      totalTokens: 1200,
      reasoningTokens: 100,
      cachedInputTokens: 800,
      cachedWriteInputTokens: 20,
    });

    useSubagentUsageStore.getState().setUsage("sess_child_1", usage);

    expect(useSubagentUsageStore.getState().byChildSessionId).toEqual({
      sess_child_1: {
        inputTokens: 900,
        outputTokens: 300,
        totalTokens: 1200,
        reasoningTokens: 100,
        cacheReadTokens: 800,
        cacheWriteTokens: 20,
      },
    });
  });

  it("overwrites the same child session and clears it on terminal", () => {
    useSubagentUsageStore.getState().setUsage("sess_child_1", {
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      cacheReadTokens: 4,
      cacheWriteTokens: 5,
      reasoningTokens: 6,
    });
    useSubagentUsageStore.getState().setUsage("sess_child_1", {
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      cacheReadTokens: 40,
      cacheWriteTokens: 50,
      reasoningTokens: 60,
    });
    expect(useSubagentUsageStore.getState().byChildSessionId.sess_child_1?.totalTokens).toBe(30);

    useSubagentUsageStore.getState().clearUsage("sess_child_1");
    expect(useSubagentUsageStore.getState().byChildSessionId).toEqual({});
  });
});
