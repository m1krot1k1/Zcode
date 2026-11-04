import { describe, expect, it, vi } from "vitest";
import { createSessionId, isCoreError, type CoreError } from "@zcode/contracts";
import { createRuntimeModel } from "../src/runtime/methods/runtime-model.js";
import type { RuntimeModelFactoryInput } from "../src/runtime/types.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

const validSelection = { providerId: "glm", modelId: "glm-4.6" };

function createRuntime(onCreate: (input: RuntimeModelFactoryInput) => void) {
  return createTestAgentRuntime(
    createSessionId("no-model-guard"),
    { modelSelection: validSelection },
    {
      eventStore: createTestSessionEventStore(),
      modelFactory: createTestModelFactory({
        onCreate,
        async generateText() {
          throw new Error("model must not be reached without a valid selection");
        },
      }),
    },
  );
}

/**
 * 空 Selection 在入口直接失败：不创建 Model，也就没有任何网络请求。
 * 回归的是日志里 `provider=glm, model=NULL` 一直挂到超时的那条路径。
 */
function expectRejectedBeforeModelCreation(
  selection: { providerId?: unknown; modelId?: unknown } | undefined,
) {
  const onCreate = vi.fn();
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  try {
    const runtime = createRuntime(onCreate);
    let thrown: unknown;
    try {
      createRuntimeModel(runtime as never, { selection: selection as never });
    } catch (error) {
      thrown = error;
    }

    expect(isCoreError(thrown)).toBe(true);
    const coreError = thrown as CoreError;
    expect(coreError.type).toBe("no_model_selected");
    expect(coreError.code).toBe("NO_MODEL_SELECTED");
    expect(coreError.recoverable).toBe(true);
    expect(coreError.retryable).toBe(false);
    expect(onCreate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("runtime model selection guard", () => {
  it("rejects a null modelId", () => {
    expectRejectedBeforeModelCreation({ providerId: "glm", modelId: null });
  });

  it("rejects an empty modelId", () => {
    expectRejectedBeforeModelCreation({ providerId: "glm", modelId: "" });
  });

  it("rejects a whitespace-only modelId", () => {
    expectRejectedBeforeModelCreation({ providerId: "glm", modelId: "   " });
  });

  it("rejects an empty providerId", () => {
    expectRejectedBeforeModelCreation({ providerId: "", modelId: "glm-4.6" });
  });

  it("rejects a missing selection", () => {
    expectRejectedBeforeModelCreation(undefined);
  });

  it("keeps the existing path for a complete selection", async () => {
    const created: RuntimeModelFactoryInput[] = [];
    const runtime = createRuntime((input) => created.push(input));

    const model = createRuntimeModel(runtime as never, { selection: validSelection });

    expect(created).toHaveLength(1);
    expect(created[0]?.selection).toEqual(validSelection);
    expect(model.providerId).toBe("glm");
    expect(model.modelId).toBe("glm-4.6");
  });
});
