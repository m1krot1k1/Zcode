import { beforeEach, describe, expect, it } from "vitest";
import {
  sumLiveSubtreeUsage,
  toLiveSubagentUsage,
  useSubagentUsageStore,
} from "@/store/subagentsStore.js";

function usage(totalTokens: number) {
  return {
    inputTokens: totalTokens,
    outputTokens: 0,
    totalTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
}

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

  it("sums the whole subtree including completed children", () => {
    const store = useSubagentUsageStore.getState();
    store.setUsage("sess_start", usage(100));
    store.setUsage("sess_orchestrator", usage(20), "sess_start");
    store.setUsage("sess_researcher", usage(5), "sess_orchestrator");
    store.setUsage("sess_grandchild", usage(2), "sess_researcher");
    store.setUsage("sess_other", usage(900));

    expect(sumLiveSubtreeUsage(useSubagentUsageStore.getState(), "sess_start")).toEqual(usage(127));

    // Terminal ребёнка не должен уменьшать subtree родителя.
    store.completeUsage("sess_researcher");
    expect(sumLiveSubtreeUsage(useSubagentUsageStore.getState(), "sess_start")?.totalTokens).toBe(
      127,
    );
  });

  it("drops the completed snapshot when the same child runs again", () => {
    const store = useSubagentUsageStore.getState();
    store.setUsage("sess_child", usage(10), "sess_parent");
    store.completeUsage("sess_child");
    expect(useSubagentUsageStore.getState().completedByChildSessionId.sess_child?.totalTokens).toBe(
      10,
    );

    store.setUsage("sess_child", usage(30), "sess_parent");
    expect(useSubagentUsageStore.getState().completedByChildSessionId).toEqual({});
    expect(useSubagentUsageStore.getState().byChildSessionId.sess_child?.totalTokens).toBe(30);
  });
});
