// WebSearch 是模型能力条件工具（properties.supportsNativeWebSearch）：provider-visible 工具表
// 与持久化/planner/child 能力清单必须使用同一份能力事实。无 Active Model 时能力未知，
// 元数据面必须保守地按「不可用」处理，不能把完整注册表当成可用能力。
import { describe, expect, it } from "vitest";
import {
  createMessageId,
  createRootTraceContext,
  createSessionId,
  type Model,
} from "@zcode/contracts";
import { systemReminderAttachmentEntry } from "../src/agent/message-history.js";
import {
  getMetadataTools,
  modelSupportsNativeWebSearch,
} from "../src/runtime/methods/config.js";
import { persistCompactSummary } from "../src/runtime/methods/compact-persistence.js";
import { persistWorkflowLaunchUserMessage } from "../src/runtime/methods/control-only-turn.js";
import {
  persistSyntheticUserNoticeForSession,
  persistUserPrompt,
} from "../src/runtime/methods/message-persistence.js";
import { resolveSubagentToolAllowlist } from "../src/runtime/methods/subagent.js";
import {
  getPlannerToolNames,
  getTurnTools,
  type RegularTurnLoopState,
} from "../src/runtime/methods/turn-loop-state.js";
import { createRecordingMessageStore } from "./runtime-output-token-continuation-test-helpers.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";

function createModel(supportsNativeWebSearch: boolean): Model {
  return createTestRuntimeModel({
    generateText: async () => ({ finishReason: "stop", text: "", usage: {} }),
    propertyOverrides: { supportsNativeWebSearch },
  });
}

function createRuntime(sessionId: string) {
  const store = createRecordingMessageStore();
  const sessionIdValue = createSessionId(sessionId);
  const runtime = createTestAgentRuntime(
    sessionIdValue,
    {},
    {
      sessionStore: store as never,
      eventStore: createTestSessionEventStore(),
    },
  );
  return {
    runtime,
    store,
    traceContext: createRootTraceContext({ sessionId: sessionIdValue }),
  };
}

function providerTurnState(model: Model): RegularTurnLoopState {
  // 只取 provider-visible 过滤需要的字段；disable 分支不打开。
  return {
    automationCreateLimitReached: false,
    model,
    toolDisallowlist: undefined,
    turnTraceContext: createRootTraceContext(),
  } as unknown as RegularTurnLoopState;
}

describe("WebSearch 元数据暴露跟随 Active Model 能力", () => {
  it("能力判据只有在明确 supportsNativeWebSearch=true 时才为真", () => {
    expect(modelSupportsNativeWebSearch(createModel(true))).toBe(true);
    expect(modelSupportsNativeWebSearch(createModel(false))).toBe(false);
    // 无 Model 代表未知能力，不能推断为可用。
    expect(modelSupportsNativeWebSearch(undefined)).toBe(false);
  });

  it.each([true, false])(
    "provider-visible 与 planner/元数据工具名按 supportsNativeWebSearch=%s 对齐",
    (supportsNativeWebSearch) => {
      const { runtime } = createRuntime(`websearch-metadata-${supportsNativeWebSearch}`);
      const model = createModel(supportsNativeWebSearch);
      const expectedNames = supportsNativeWebSearch
        ? expect.arrayContaining(["WebSearch"])
        : expect.not.arrayContaining(["WebSearch"]);

      // provider-visible 路径（turn loop）必须保持不变，只读取 Active Model。
      expect(getTurnTools(runtime, providerTurnState(model)).map((tool) => tool.name)).toEqual(
        expectedNames,
      );
      // swarm planner 与通用元数据枚举必须与 provider-visible 使用同一能力事实。
      expect(getMetadataTools.call(runtime, model).map((tool) => tool.name)).toEqual(expectedNames);
      expect(getPlannerToolNames(runtime, model)).toEqual(expectedNames);
    },
  );

  it("无 Active Model 时元数据面保守隐藏 WebSearch，注册表库存不受影响", () => {
    const { runtime } = createRuntime("websearch-metadata-unknown-model");

    expect(getMetadataTools.call(runtime).map((tool) => tool.name)).not.toContain("WebSearch");
    // getTools 无参数仍是「完整注册表库存」，供 registry inventory 与 child 能力清单使用。
    expect(runtime.getTools().map((tool) => tool.name)).toContain("WebSearch");
  });

  it.each([true, false])(
    "compact summary 与 reminder 的持久化 tools 映射使用 supportsNativeWebSearch=%s 的模型",
    async (supportsNativeWebSearch) => {
      const { runtime, store, traceContext } = createRuntime(
        `websearch-persist-${supportsNativeWebSearch}`,
      );
      const model = createModel(supportsNativeWebSearch);

      await runtime.persistCompactSummary(
        createMessageId(),
        "compact content",
        "compact summary",
        { trigger: "manual", phase: "post_response", compactReason: "manual" } as never,
        traceContext,
        {
          model,
          postCompactReminderEntries: [
            systemReminderAttachmentEntry("todo_reminder", "reminder body"),
          ],
        },
      );

      const [summaryMessage, reminderMessage] = store.savedMessages;
      expect(summaryMessage?.tools).toBeDefined();
      expect(reminderMessage?.tools).toBeDefined();
      if (supportsNativeWebSearch) {
        expect(summaryMessage.tools).toMatchObject({ WebSearch: true });
        expect(reminderMessage.tools).toMatchObject({ WebSearch: true });
      } else {
        expect(summaryMessage.tools).not.toHaveProperty("WebSearch");
        expect(reminderMessage.tools).not.toHaveProperty("WebSearch");
      }
    },
  );

  it("没有 Active Model 的持久化入口不声称 WebSearch 可用", async () => {
    const { runtime, store, traceContext } = createRuntime("websearch-persist-no-model");

    await runtime.persistUserPrompt(createMessageId(), "hello", undefined, traceContext);
    expect(store.savedMessages.at(-1)?.tools).not.toHaveProperty("WebSearch");

    await runtime.persistSyntheticUserNoticeForSession({
      messageID: createMessageId(),
      sessionId: runtime.getSessionId(),
      source: "rewind",
      text: "notice",
      traceContext,
    });
    expect(store.savedMessages.at(-1)?.tools).not.toHaveProperty("WebSearch");

    await persistWorkflowLaunchUserMessage.call(runtime, {
      messageID: createMessageId(),
      text: "workflow launch",
      meta: {} as never,
      traceContext,
    });
    expect(store.savedMessages.at(-1)?.tools).not.toHaveProperty("WebSearch");
  });

  it("child 能力清单按 child Active Model 过滤 WebSearch", () => {
    const tools = [
      { name: "Read", permission: undefined },
      { name: "WebSearch", permission: undefined },
    ] as never;
    const createFakeRuntime = () => ({
      config: { toolAllowlist: undefined, toolDisallowlist: undefined },
      getTools: () => tools,
    });
    const request = { allowedTools: [], disallowedTools: [] } as never;

    const inheritedWithSearch = resolveSubagentToolAllowlist.call(
      createFakeRuntime() as never,
      request,
      [],
      createModel(true),
    );
    const inheritedWithoutSearch = resolveSubagentToolAllowlist.call(
      createFakeRuntime() as never,
      request,
      [],
      createModel(false),
    );

    expect(inheritedWithSearch).toContain("WebSearch");
    expect(inheritedWithoutSearch).not.toContain("WebSearch");
    expect(inheritedWithoutSearch).toContain("Read");
  });
});
