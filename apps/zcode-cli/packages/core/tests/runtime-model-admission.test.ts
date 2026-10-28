import { describe, expect, it, vi } from "vitest";
import {
  createSessionEvent,
  createSessionId,
  createTurnId,
  SessionEventType,
  runWithModelInvocationContext,
  type ModelInvocationContext,
  type ModelRequestAdmission,
  type ModelRequestAdmissionTicket,
  type ModelSelection,
} from "@zcode/contracts";
import { createRuntimeModel } from "../src/runtime/methods/runtime-model.js";
import {
  createOpenCodeSkillDispatcher,
  createOpenCodeTaskDispatcher,
} from "../src/runtime/methods/model.js";
import { skillHandler } from "../src/tool/handlers/skill.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";

// docs/dynamic-workflow/concurrency.md「Where the port is bound」：准入端口与重试预算绑定在 runtime 的模型工厂上，
// runtime 交出的每一个句柄——turn step 与工具内部的模型调用——都带它们；调用层设什么都压不过。
// 设计缺口的根因：此前只在 turn step 注入，WebSearch 这类工具侧请求全部绕过闸门。

const modelSelection: ModelSelection = { providerId: "deepseek", modelId: "deepseek-chat" };

function admissionStub(): ModelRequestAdmission {
  const ticket: ModelRequestAdmissionTicket = { publish() {}, release() {} };
  return { acquire: async () => ticket };
}

describe("OpenCode Core task bridge dispatcher", () => {
  it("dispatches only through the invocation runtime ToolExecutor with signal, trace and model", async () => {
    const sessionId = createSessionId("opencode-core-dispatch");
    const turnId = createTurnId("opencode-core-dispatch-turn");
    const traceContext = {
      sessionId,
      turnId,
      traceId: "trace-opencode",
      spanId: "span-opencode",
    } as never;
    const signal = new AbortController().signal;
    const model = createTestRuntimeModel({
      generateText: async () => ({ text: "", finishReason: "stop", usage: {} }),
    });
    const execute = vi.fn(
      async () =>
        ({
          success: true,
          output: { status: "completed" },
          serialization: { content: "child result" },
        }) as never,
    );
    const runtime = {
      registry: { get: vi.fn((name: string) => (name === "Task" ? {} : undefined)) },
      getToolExecutor: () => ({ execute }),
    };
    const dispatch = createOpenCodeTaskDispatcher(runtime as never, {
      allowedToolNames: ["Task"],
      model,
      signal,
      traceContext,
    });

    await expect(
      dispatch({
        description: "Inspect task",
        prompt: "Check the module",
        subagent_type: "researcher",
      }),
    ).resolves.toBe("child result");
    expect(execute).toHaveBeenCalledTimes(1);
    const [call, options] = execute.mock.calls[0]!;
    expect(call).toMatchObject({ name: "Task", input: { subagent_type: "researcher" } });
    expect(call.id).toMatch(/^opencode-/u);
    expect(options).toEqual({ model, signal, traceContext });
  });

  it("fails closed when the current model request did not expose Agent or Task", async () => {
    const execute = vi.fn();
    const runtime = {
      registry: { get: vi.fn(() => ({})) },
      getToolExecutor: () => ({ execute }),
    };
    const dispatch = createOpenCodeTaskDispatcher(runtime as never, {
      allowedToolNames: ["Read"],
      model: createTestRuntimeModel({
        generateText: async () => ({ text: "", finishReason: "stop", usage: {} }),
      }),
      traceContext: {} as never,
    });
    await expect(
      dispatch({
        description: "Inspect task",
        prompt: "Check the module",
        subagent_type: "researcher",
      }),
    ).rejects.toThrow("capability is unavailable");
    expect(execute).not.toHaveBeenCalled();
  });

  it("marks only the Core unknown-agent validation so OpenCode can select an active profile", async () => {
    const execute = vi.fn(async () => ({
      success: false,
      error: {
        type: "tool_execution_failed",
        message: "Agent type 'general-purpose' is not available. Choose one exact active role ID: researcher, implementer, reviewer",
      },
    }) as never);
    const runtime = {
      registry: { get: vi.fn((name: string) => name === "Task" ? {} : undefined) },
      getToolExecutor: () => ({ execute }),
    };
    const dispatch = createOpenCodeTaskDispatcher(runtime as never, {
      allowedToolNames: ["Task"],
      model: createTestRuntimeModel({
        generateText: async () => ({ text: "", finishReason: "stop", usage: {} }),
      }),
      traceContext: {} as never,
    });

    await expect(dispatch({
      description: "Delegate",
      prompt: "Inspect the repository",
      subagent_type: "general-purpose",
    })).rejects.toMatchObject({
      code: "agent_unknown_type",
      message: expect.stringContaining("Choose one exact active role ID"),
    });
  });

  it("propagates root cancellation before tool admission", async () => {
    const controller = new AbortController();
    controller.abort(new Error("root turn cancelled"));
    const execute = vi.fn();
    const runtime = {
      registry: { get: vi.fn(() => ({})) },
      getToolExecutor: () => ({ execute }),
    };
    const dispatch = createOpenCodeTaskDispatcher(runtime as never, {
      allowedToolNames: ["Agent"],
      model: createTestRuntimeModel({
        generateText: async () => ({ text: "", finishReason: "stop", usage: {} }),
      }),
      signal: controller.signal,
      traceContext: {} as never,
    });
    await expect(
      dispatch({
        description: "Inspect task",
        prompt: "Check the module",
        subagent_type: "researcher",
      }),
    ).rejects.toThrow("Turn was cancelled.");
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("OpenCode Core skill bridge dispatcher", () => {
  it("loads the named skill through the invocation ToolExecutor and current SkillPort", async () => {
    const sessionId = createSessionId("opencode-core-skill-dispatch");
    const turnId = createTurnId("opencode-core-skill-dispatch-turn");
    const traceContext = {
      sessionId,
      turnId,
      traceId: "trace-opencode-skill",
      spanId: "span-opencode-skill",
    } as never;
    const metadata = {
      name: "review",
      description: "Review code",
      path: "/private/skill-root/review/SKILL.md",
      directory: "/private/skill-root/review",
      rootPath: "/private/skill-root",
      scope: "project",
      source: "zcode",
      safeToAutoLoad: false,
      frontmatterKeys: ["name", "description"],
      policy: { allowImplicitInvocation: true },
    };
    const loadSkill = vi.fn(async () => ({
      metadata,
      content: "UNIQUE_SKILL_PORT_BODY_MARKER",
      baseDirectory: "/private/skill-root/review",
      bytesRead: 29,
      sizeBytes: 29,
      truncated: false,
    }));
    const skillPort = { discoverSkills: vi.fn(), loadSkill };
    const execute = vi.fn(async (call: { input: unknown }) => {
      const content = await skillHandler(call.input, {
        skillPort,
        workingDirectory: "/workspace",
        toolCallId: "tool-opencode-skill",
        sessionId,
        turnId,
        traceId: "trace-opencode-skill",
        spanId: "span-opencode-skill",
        abortSignal: undefined,
      } as never);
      return {
        success: true,
        output: content,
        serialization: { content },
      } as never;
    });
    const model = createTestRuntimeModel({
      generateText: async () => ({ text: "", finishReason: "stop", usage: {} }),
    });
    const runtime = {
      registry: { get: vi.fn((name: string) => (name === "Skill" ? {} : undefined)) },
      getToolExecutor: () => ({ execute }),
    };
    const dispatch = createOpenCodeSkillDispatcher(runtime as never, {
      allowedToolNames: ["Skill"],
      model,
      traceContext,
    });

    await expect(dispatch({ skill: "review" })).resolves.toContain("UNIQUE_SKILL_PORT_BODY_MARKER");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ name: "Skill", input: { skill: "review" } });
    expect(loadSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: "review", workingDirectory: "/workspace" }),
      expect.objectContaining({ signal: undefined }),
    );
  });

  it("fails closed when the child model request did not expose Skill", async () => {
    const execute = vi.fn();
    const runtime = {
      registry: { get: vi.fn(() => ({})) },
      getToolExecutor: () => ({ execute }),
    };
    const dispatch = createOpenCodeSkillDispatcher(runtime as never, {
      allowedToolNames: ["Read"],
      model: createTestRuntimeModel({
        generateText: async () => ({ text: "", finishReason: "stop", usage: {} }),
      }),
      traceContext: {} as never,
    });

    await expect(dispatch({ skill: "review" })).rejects.toThrow("capability is unavailable");
    expect(execute).not.toHaveBeenCalled();
  });
});

/** adapter 看到的请求：runner 把调用上下文整份铺进请求（adapters/src/model/runner.ts），这里照样记。 */
type SeenRequest = Record<string, unknown> & Partial<ModelInvocationContext>;

/** 一轮：主请求发一次 WebSearch，工具内部发流式 web_search 请求，再收口。 */
function modelFactoryWithWebSearch(requests: SeenRequest[]) {
  let mainRequestCount = 0;
  return createTestModelFactory({
    properties: { supportsNativeWebSearch: true },
    async generateText(request, observation) {
      requests.push({ ...request, ...observation.invocationContext });
      mainRequestCount += 1;
      if (mainRequestCount === 1) {
        return {
          finishReason: "tool-calls",
          model: request.model,
          providerMetadata: undefined,
          text: "",
          toolCalls: [
            { id: "call_websearch", input: { query: "latest zcode" }, name: "WebSearch" },
          ],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }
      return {
        finishReason: "stop",
        model: request.model,
        providerMetadata: undefined,
        text: "done",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    async *streamText(request, observation) {
      requests.push({ ...request, ...observation.invocationContext });
      yield { type: "start" };
      yield { id: "t", type: "text_start" };
      yield { id: "t", text: "summary", type: "text_delta" };
      yield { id: "t", type: "text_end" };
      yield {
        finishReason: "stop",
        providerMetadata: { rawFinishReason: "end_turn" },
        type: "finish",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          serverToolUse: { webSearchRequests: 1 },
          totalTokens: 2,
        },
      };
    },
  } as never);
}

describe("runtime model factory binds admission and retry budget (v3 决策 42)", () => {
  it("WebSearch 工具内部的模型请求带 runtime 的准入端口与 workflow_child 的无上限预算", async () => {
    const admission = admissionStub();
    const requests: SeenRequest[] = [];
    const workingDirectory = "/workspace/runtime-admission-websearch";
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-admission-websearch"),
      { modelSelection, modelStreaming: "off", taskType: "workflow_child", workingDirectory },
      {
        eventStore: createTestSessionEventStore(),
        modelRequestAdmission: admission,
        modelFactory: modelFactoryWithWebSearch(requests),
      },
    );
    await runtime.executeTurn("search");

    const tool = requests.find(
      (request) =>
        (request.metadata as { querySource?: string })?.querySource === "web_search_tool",
    );
    const turn = requests.find(
      (request) =>
        (request.metadata as { querySource?: string })?.querySource !== "web_search_tool",
    );
    expect(tool).toBeDefined();
    expect(turn).toBeDefined();
    expect(tool!.modelRequestAdmission).not.toBe(admission);
    expect(tool!.modelRequestAdmission?.acquire).toBeTypeOf("function");
    expect(tool!.modelRetryBudget).toBe("unbounded");
    expect(tool!.workingDirectory).toBe(workingDirectory);
    expect(turn!.modelRequestAdmission).not.toBe(admission);
    expect(turn!.modelRequestAdmission?.acquire).toBeTypeOf("function");
    expect(turn!.modelRetryBudget).toBe("unbounded");
  });

  it.each([
    ["interactive", "main"],
    ["subagent_child", "subagent"],
    ["selection_side_chat", "side_chat"],
  ] as const)(
    "%s 工具请求继承宿主类型并使用 RootRun 预算准入",
    async (taskType, expectedSessionType) => {
      const requests: SeenRequest[] = [];
      const runtime = createTestAgentRuntime(
        createSessionId("runtime-admission-websearch-absent"),
        { modelSelection, modelStreaming: "off", taskType },
        {
          eventStore: createTestSessionEventStore(),
          modelFactory: modelFactoryWithWebSearch(requests),
        },
      );
      await runtime.executeTurn("search");
      const tool = requests.find(
        (request) =>
          (request.metadata as { querySource?: string })?.querySource === "web_search_tool",
      );
      expect(tool).toBeDefined();
      expect(tool!.modelRequestAdmission?.acquire).toBeTypeOf("function");
      expect(tool!.modelRetryBudget).toBe("default");
      expect(tool!.modelRequestSessionType).toBe(expectedSessionType);
    },
  );

  it("runtime 层压过调用层：调用点塞的 modelRequestAdmission 到不了 adapter", async () => {
    const admission = admissionStub();
    const other = admissionStub();
    const seen: unknown[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-admission-layer-precedence"),
      { modelSelection, modelStreaming: "off", taskType: "workflow_child" },
      {
        eventStore: createTestSessionEventStore(),
        modelRequestAdmission: admission,
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            const context = observation.invocationContext;
            seen.push([context?.modelRequestAdmission, context?.modelRetryBudget]);
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "ok",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            } as never;
          },
        }),
      },
    );
    const model = createRuntimeModel(runtime as never, { selection: modelSelection });
    await runWithModelInvocationContext(
      {
        modelRequestAdmission: other,
        modelRetryBudget: "default",
        metadata: { querySource: "probe" },
      },
      () => model.generateText({ messages: [{ role: "user", content: "hi" }] } as never),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toEqual([other, "default"]);
    expect((seen[0] as [unknown, unknown])[0]).toBe(admission);
    expect((seen[0] as [unknown, unknown])[1]).toBe("unbounded");
  });

  it("在真实 runtime model admission 边界超预算时不调用 provider", async () => {
    const sessionId = createSessionId("runtime-root-budget-admission");
    const turnId = createTurnId("runtime-root-budget-admission-turn");
    const rootRunId = `${sessionId}:${turnId}`;
    const registry = new InMemoryRuntimeTaskRegistry();
    registry.beginRootRunBudget({
      rootRunId,
      rootSessionId: sessionId,
      turnId,
      tokenLimit: 100,
      deadlineMs: 60_000,
    });
    // 当前预算按实际 usage 结算；仅仅打开大 context window 不代表已经耗尽 token。
    registry.recordRootRunUsage(
      createSessionEvent(
        SessionEventType.ModelComplete,
        sessionId,
        { content: "", stopReason: "stop", usage: { totalTokens: 100 } },
        { turnId },
      ),
    );
    const providerCall = vi.fn(async () => ({
      finishReason: "stop",
      providerMetadata: undefined,
      text: "should not run",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));
    const runtime = createTestAgentRuntime(
      sessionId,
      { modelSelection, modelStreaming: "off", taskType: "interactive" },
      {
        eventStore: createTestSessionEventStore(),
        runtimeTaskRegistry: registry,
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            const ticket = await observation.invocationContext?.modelRequestAdmission?.acquire({
              model: {
                providerId: observation.model.providerId,
                modelId: observation.model.modelId,
              },
            });
            ticket?.release();
            return providerCall();
          },
          maxOutputTokens: 50,
          properties: { contextWindow: 60 },
        }),
      },
    );
    const model = createRuntimeModel(runtime as never, { selection: modelSelection });
    await expect(
      runWithModelInvocationContext({ traceContext: { sessionId, turnId } as never }, () =>
        model.generateText({ messages: [{ role: "user", content: "test" }] }),
      ),
    ).rejects.toThrow("Root run resource budget is exhausted");
    expect(providerCall).not.toHaveBeenCalled();
  });

  it("子 Agent 按 trace 中的子会话解析并共享根 turn 的模型预算", async () => {
    const rootSessionId = createSessionId("runtime-child-budget-root");
    const childSessionId = createSessionId("runtime-child-budget-child");
    const rootTurnId = createTurnId("runtime-child-budget-root-turn");
    const childTurnId = createTurnId("runtime-child-budget-child-turn");
    const rootRunId = `${rootSessionId}:${rootTurnId}`;
    const registry = new InMemoryRuntimeTaskRegistry();
    registry.beginRootRunBudget({
      rootRunId,
      rootSessionId,
      turnId: rootTurnId,
      tokenLimit: 100,
      deadlineMs: 60_000,
    });
    registry.registerSubagentTask(
      {
        taskId: "runtime-child-budget-task",
        agentId: "runtime-child-budget-agent",
        agentType: "general-purpose",
        description: "Verify child model admission",
        status: "running",
        startedAt: new Date(),
        childSessionId,
        parentSessionId: rootSessionId,
        turnId: rootTurnId,
        type: "local_agent",
      },
      { abort() {}, settled: Promise.resolve() },
    );
    // 根 turn 的实际 usage 已达到上限；child admission 必须看到同一 root-run 状态。
    registry.recordRootRunUsage(
      createSessionEvent(
        SessionEventType.ModelComplete,
        rootSessionId,
        { content: "", stopReason: "stop", usage: { totalTokens: 100 } },
        { turnId: rootTurnId },
      ),
    );
    const providerCall = vi.fn(async () => ({
      finishReason: "stop",
      providerMetadata: undefined,
      text: "should not run",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));
    const runtime = createTestAgentRuntime(
      rootSessionId,
      { modelSelection, modelStreaming: "off", taskType: "interactive" },
      {
        eventStore: createTestSessionEventStore(),
        runtimeTaskRegistry: registry,
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            const ticket = await observation.invocationContext?.modelRequestAdmission?.acquire({
              model: {
                providerId: observation.model.providerId,
                modelId: observation.model.modelId,
              },
            });
            ticket?.release();
            return providerCall();
          },
          maxOutputTokens: 50,
          properties: { contextWindow: 60 },
        }),
      },
    );
    const model = createRuntimeModel(runtime as never, { selection: modelSelection });
    await expect(
        runWithModelInvocationContext(
          {
            traceContext: { sessionId: childSessionId, turnId: childTurnId } as never,
          },
          () => model.generateText({ messages: [{ role: "user", content: "child" }] }),
        ),
      ).rejects.toThrow(rootRunId);
    expect(providerCall).not.toHaveBeenCalled();
  });
});
