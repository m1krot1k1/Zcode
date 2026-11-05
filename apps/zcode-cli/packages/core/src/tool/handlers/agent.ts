// ============================================================
// Agent Tool Handler
// ============================================================

import {
  AgentErrorCode,
  AgentInputJsonSchema,
  AgentInputSchema,
  AgentOutputSchema,
  CoreErrorType,
  TaskInputJsonSchema,
  TaskInputSchema,
  createCoreError,
  type AgentInput,
  type AgentOutput,
  type AgentPresentation,
  type TraceContext,
} from "@zcode/contracts";
import { TASK_TOOL_NAME } from "../compat.js";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_AGENT_MODEL_BYTES = 120_000;

const AGENT_TOOL_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  oneOf: [
    {
      type: "object",
      properties: {
        status: { const: "completed", type: "string" },
        agentId: { type: "string" },
        agentType: { type: "string" },
        prompt: { type: "string" },
        content: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { const: "text", type: "string" },
              text: { type: "string" },
            },
            required: ["type", "text"],
            additionalProperties: false,
          },
        },
        totalToolUseCount: { type: "integer", minimum: 0 },
        totalDurationMs: { type: "integer", minimum: 0 },
        totalTokens: { type: "integer", minimum: 0 },
        usage: { type: "object", additionalProperties: true },
        workResult: {
          type: "object",
          properties: {
            status: {
              enum: ["completed", "partial", "failed", "blocked"],
              type: "string",
            },
            summary: { type: "string" },
            files: { type: "array", items: { type: "string" } },
            evidence: { type: "array", items: { type: "string" } },
            tests: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  command: { type: "string" },
                  status: { enum: ["passed", "failed", "not_run"], type: "string" },
                  summary: { type: "string" },
                },
                required: ["command", "status"],
                additionalProperties: false,
              },
            },
            unresolved: { type: "array", items: { type: "string" } },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            claims: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  runId: { type: "string" },
                  attemptId: { type: "string" },
                },
                required: ["path"],
                additionalProperties: false,
              },
            },
            metrics: {
              type: "object",
              properties: {
                durationMs: { type: "integer", minimum: 0 },
                toolUses: { type: "integer", minimum: 0 },
                tokens: { type: "integer", minimum: 0 },
              },
              additionalProperties: false,
            },
          },
          required: ["status", "summary", "files", "evidence", "tests", "unresolved", "claims"],
          additionalProperties: false,
        },
        presentation: {
          type: "object",
          properties: {
            userText: { type: "string" },
            facts: { type: "array", items: { type: "string" } },
            unknowns: { type: "array", items: { type: "string" } },
            evidenceRefs: { type: "array", items: { type: "string" } },
          },
          required: ["userText", "facts", "unknowns", "evidenceRefs"],
          additionalProperties: false,
        },
        acceptance: {
          type: "object",
          properties: {
            status: { enum: ["unknown", "verified", "rejected"], type: "string" },
            passedCriterionIds: { type: "array", items: { type: "string" } },
            failedCriterionIds: { type: "array", items: { type: "string" } },
            missingCriterionIds: { type: "array", items: { type: "string" } },
          },
          required: ["status", "passedCriterionIds", "failedCriterionIds", "missingCriterionIds"],
          additionalProperties: false,
        },
      },
      required: ["status", "agentId", "prompt", "content", "totalToolUseCount", "totalDurationMs"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        status: { const: "async_launched", type: "string" },
        agentId: {
          type: "string",
          description: "The ID of the async agent",
        },
        description: {
          type: "string",
          description: "The description of the task",
        },
        prompt: {
          type: "string",
          description: "The prompt for the agent",
        },
        outputFile: {
          type: "string",
          description: "Path to the output file for checking agent progress",
        },
        canReadOutputFile: {
          type: "boolean",
          description: "Whether the calling agent has Read/Bash tools to check progress",
        },
      },
      required: ["status", "agentId", "description", "prompt", "outputFile"],
      additionalProperties: false,
    },
  ],
};

/**
 * 动态工作流灰度门也管**工具描述**：
 * 关闭时十个工具不注册，但这条 bullet 仍在 Agent 的 provider 描述里写着「CreateWorkflow
 * 是强制的」，于是模型被指向一个根本不存在的工具，只会白白撞一次 tool_not_found。
 * 缺省 true：TUI、headless 与既有调用方（包括模块加载期烘焙的 AGENT_PROVIDER_DESCRIPTION）
 * 行为不变，只有显式 false 才抹掉这一行。
 */
function buildAgentProviderDescription(
  options: {
    dynamicWorkflowEnabled?: boolean;
  } = {},
): string {
  return [
    "Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.",
    "",
    "Available agent types are listed in <system-reminder> messages in the conversation.",
    "",
    "When using the Agent tool, subagent_type is required. Choose one exact active profile ID listed in the current conversation; missing or unknown roles are errors and never fall back to a generic agent.",
    "",
    "## When to use",
    "",
    "Reach for this when the task matches an available agent type, when you have independent work to run in parallel, or when answering would mean reading across several files — delegate it and you keep the conclusion, not the file dumps. For a single-fact lookup where you already know the file, symbol, or value, search directly. Once you've delegated a search, don't also run it yourself — wait for the result.",
    "",
    "- The agent's final message is returned to you as the tool result; it is not shown to the user — relay what matters.",
    "- Use SendMessage with the agent's ID to continue a previously spawned agent with its context intact; a new Agent call starts fresh.",
    "- Each agent type's model, reasoning effort, and tools come from its definition (`.zcode/agents/*.md` frontmatter).",
    "- `run_in_background: true` runs the agent asynchronously; you'll be notified when it completes.",
    // 只保留「用户点名工作流」这一种情形：工作流一律由用户显式请求触发，与系统提示词其余
    // 部分一致。不能把「结果层层喂给下一步的多代理编排」也划给 CreateWorkflow，
    // 那等于让模型在用户没开口时自行选择工作流。
    ...(options.dynamicWorkflowEnabled === false
      ? []
      : [
          '- If the user explicitly asks for a workflow ("use a workflow", "使用 workflow", "用工作流", or any phrasing naming workflow/工作流 as the means), the CreateWorkflow tool is mandatory: do not use this tool instead, however small the task.',
        ]),
  ].join("\n");
}

const AGENT_PROVIDER_DESCRIPTION = buildAgentProviderDescription();

const WORK_RESULT_SUMMARY_MAX_CHARS = 1_000;

function formatWorkResultList(values: readonly string[]): string {
  if (values.length === 0) return "none";
  const joined = values.join(", ");
  return joined.length > WORK_RESULT_SUMMARY_MAX_CHARS
    ? `${joined.slice(0, WORK_RESULT_SUMMARY_MAX_CHARS - 1)}…`
    : joined;
}

function formatWorkResultTests(tests: ReadonlyArray<{ command: string; status: string }>): string {
  if (tests.length === 0) return "none";
  const joined = tests.map((test) => `${test.command}=${test.status}`).join("; ");
  return joined.length > WORK_RESULT_SUMMARY_MAX_CHARS
    ? `${joined.slice(0, WORK_RESULT_SUMMARY_MAX_CHARS - 1)}…`
    : joined;
}

/**
 * Авторитетная инструкция для корневого агента: Start — единственный автор готового
 * пользовательского отчёта, root лишь передаёт его дословно. Без этой рамки модель
 * склонна пересказывать tool result своими словами и смешивать его с сырым текстом child.
 */
const PRESENTATION_AUTHORITY_INSTRUCTION = [
  "This is the authoritative final user-facing report authored by the start agent; start is its sole author and this text must reach the user.",
  "Relay userText, facts, unknowns and evidenceRefs verbatim. Do not paraphrase, summarize, omit or reorder them, do not add your own retelling or claims, and do not mix them with raw child/subagent text.",
].join("\n");

/**
 * Pass-through единственного презентера: Start уже сформировал пользовательский текст.
 * Никакого синтеза, сырого child content, agentId или usage здесь быть не должно.
 * Обёртка делает авторство и правило передачи явными для корневого агента.
 */
function formatPresentationForModel(
  presentation: AgentPresentation,
  status: string,
  unresolved: readonly string[],
): string {
  return [
    "<zcode-start-report>",
    PRESENTATION_AUTHORITY_INSTRUCTION,
    "",
    "userText:",
    presentation.userText,
    formatPresentationSection("facts", presentation.facts),
    formatPresentationSection("unknowns", presentation.unknowns),
    formatPresentationSection("evidenceRefs", presentation.evidenceRefs),
    `status: ${status}`,
    formatPresentationSection("unresolved", unresolved),
    "</zcode-start-report>",
  ].join("\n");
}

function formatPresentationSection(label: string, values: readonly string[]): string {
  if (values.length === 0) return `${label}: none`;
  return [`${label}:`, ...values.map((value) => `- ${value}`)].join("\n");
}

export function formatAgentOutputForModel(output: unknown): string {
  const parsed = AgentOutputSchema.safeParse(output);
  if (!parsed.success) {
    return typeof output === "string" ? output : (JSON.stringify(output) ?? String(output));
  }

  const data = parsed.data as AgentOutput;
  if (data.status !== "async_launched") {
    if (data.presentation !== undefined) {
      return formatPresentationForModel(
        data.presentation,
        data.workResult?.status ?? "completed",
        data.workResult?.unresolved ?? [],
      );
    }
    const childText = data.content.map((block) => block.text).join("\n");
    const childContent =
      childText.trim().length > 0 ? [childText] : ["(Subagent completed but returned no output.)"];
    const usageLines = [
      ...(data.totalTokens === undefined ? [] : [`subagent_tokens: ${data.totalTokens}`]),
      `tool_uses: ${data.totalToolUseCount}`,
      `duration_ms: ${data.totalDurationMs}`,
      ...(data.acceptance === undefined
        ? []
        : [
            `host_acceptance: ${data.acceptance.status}`,
            `host_acceptance_passed: ${data.acceptance.passedCriterionIds.join(",") || "none"}`,
            `host_acceptance_failed: ${data.acceptance.failedCriterionIds.join(",") || "none"}`,
            `host_acceptance_missing: ${data.acceptance.missingCriterionIds.join(",") || "none"}`,
            "host_acceptance_scope: exact declared checks only; does not prove semantic task quality",
          ]),
      ...(data.workResult === undefined
        ? []
        : [
            `work_result: ${data.workResult.status}`,
            `work_result_files: ${formatWorkResultList(data.workResult.files)}`,
            `work_result_tests: ${formatWorkResultTests(data.workResult.tests)}`,
            `work_result_unresolved: ${formatWorkResultList(data.workResult.unresolved)}`,
          ]),
    ];
    return [
      ...childContent,
      `agentId: ${data.agentId} (use SendMessage with to: '${data.agentId}' to continue this agent)`,
      `<usage>${usageLines.join("\n")}</usage>`,
    ].join("\n");
  }

  const launchLines = [
    "Async agent launched successfully.",
    `agentId: ${data.agentId} (internal ID - do not mention to user. Use SendMessage with to: '${data.agentId}' to continue this agent.)`,
    "The agent is working in the background. You will be notified automatically when it completes.",
  ];

  if (data.canReadOutputFile) {
    return [
      ...launchLines,
      "Do not duplicate this agent's work - avoid working with the same files or topics it is using. Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
      `output_file: ${data.outputFile}`,
      "Do NOT Read or tail this file via the shell tool. If the user asks for progress, say the agent is still running; you'll get a completion notification.",
    ].join("\n");
  }

  return [
    ...launchLines,
    "Briefly tell the user what you launched and end your response. Do not generate any other text - agent results will arrive in a subsequent message.",
  ].join("\n");
}

const agentHandler: ToolHandler = async (input, context) => {
  const parsed = AgentInputSchema.parse(input) as AgentInput;
  const agentType = parsed.subagent_type;

  const availableAgentTypes = context.availableAgentTypes;
  if (availableAgentTypes && !availableAgentTypes.includes(agentType)) {
    // Причина: встроенный general-purpose оставался во внутреннем runtime-каталоге и обходил
    // скрытие из model prompt; проверка по тому же snapshot закрывает Agent и Task до admission.
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      `Agent type '${agentType}' is not available. Choose one exact active role ID: ${availableAgentTypes.join(", ")}`,
      {
        context: {
          code: AgentErrorCode.UNKNOWN_AGENT_TYPE,
          agentType,
          availableAgentTypes: [...availableAgentTypes],
          toolCallId: context.toolCallId,
          toolName: "Agent",
        },
        recoverable: true,
      },
    );
  }

  if (!context.subagentPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "SubagentPort is not configured for Agent tool",
      {
        context: {
          code: AgentErrorCode.SUBAGENT_UNAVAILABLE,
          toolCallId: context.toolCallId,
          toolName: "Agent",
        },
        recoverable: false,
      },
    );
  }

  const sharedRequest = {
    sessionId: context.sessionId,
    turnId: context.turnId,
    parentToolCallId: context.toolCallId,
    callerCanReadOutputFile: canReadBackgroundOutputFile(context.providerVisibleToolNames),
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
    trace: {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
    } as TraceContext,
  };
  const options = {
    signal: context.abortSignal,
    ...(context.model ? { model: context.model } : {}),
    ...(context.subagentModelOverride ? { modelOverride: context.subagentModelOverride } : {}),
  };

  if (parsed.task_graph) {
    if (!context.subagentPort.runTaskDag) {
      throw createCoreError(
        CoreErrorType.ConfigurationError,
        "SubagentPort.runTaskDag is not configured for Agent task_graph",
        {
          context: {
            code: AgentErrorCode.TASK_DAG_UNAVAILABLE,
            toolCallId: context.toolCallId,
            toolName: "Agent",
          },
          recoverable: false,
        },
      );
    }
    return context.subagentPort.runTaskDag(
      {
        ...sharedRequest,
        agentType,
        description: parsed.description,
        prompt: parsed.prompt,
        nodes: parsed.task_graph.nodes,
        ...(parsed.remaining_spawns === undefined ? {} : { spawnBudget: parsed.remaining_spawns }),
        ...(parsed.level === undefined ? {} : { level: parsed.level }),
        ...(parsed.task_graph.max_parallel === undefined
          ? {}
          : { maxParallel: parsed.task_graph.max_parallel }),
      },
      options,
    );
  }

  return context.subagentPort.launch(
    {
      ...sharedRequest,
      agentType,
      description: parsed.description,
      prompt: parsed.prompt,
      ...(parsed.acceptance_criteria === undefined
        ? {}
        : { acceptanceCriteria: parsed.acceptance_criteria }),
      ...(parsed.remaining_spawns === undefined ? {} : { spawnBudget: parsed.remaining_spawns }),
      ...(parsed.level === undefined ? {} : { level: parsed.level }),
      runInBackground: parsed.run_in_background === true,
    },
    options,
  );
};

export const agentToolEntry: ToolEntry = {
  capability: "Launch a profile-backed subagent; background execution is runtime-configured",
  metadata: {
    name: "Agent",
    description: AGENT_PROVIDER_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    maxOutputBytes: MAX_AGENT_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: agentHandler,
  formatModelContent: formatAgentOutputForModel,
  inputSchema: AgentInputJsonSchema,
  outputSchema: AGENT_TOOL_OUTPUT_SCHEMA,
  runtimeInputSchema: AgentInputSchema,
  runtimeOutputSchema: AgentOutputSchema,
  permission: {
    permission: "subagent",
    reason:
      "Agent launches a child runtime; child tool calls are separately constrained and approved",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["input"],
    alwaysAllowPatternSources: ["input"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_AGENT_MODEL_BYTES,
    maxModelBytes: MAX_AGENT_MODEL_BYTES,
    strategy: "artifact",
    preview: {
      maxBytes: MAX_AGENT_MODEL_BYTES,
      direction: "head",
    },
    artifact: {
      enabled: true,
      retention: "session",
    },
  },
  timeout: { kind: "none" },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage:
      "Agent was cancelled before the subagent returned findings or background launch completed",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function canReadBackgroundOutputFile(toolNames: readonly string[] | undefined): boolean {
  const names = new Set(toolNames ?? []);
  return names.has("Read") || names.has("Bash");
}

export const taskToolEntry: ToolEntry = createTaskToolEntryFromAgent(agentToolEntry);

function createTaskToolEntryFromAgent(entry: ToolEntry): ToolEntry {
  const taskHandler: ToolHandler = async (input, context) => {
    // 原因：Task 复用 Agent 时会把缺失角色静默映射为 general-purpose；
    // 修复依据：Task 是显式递归接口，必须在派发前校验调用方选择的活动 profile。
    const parsed = TaskInputSchema.parse(input);
    return entry.handler(parsed, context);
  };
  const description = (entry.metadata.description ?? "").replace(
    "When using the Agent tool, subagent_type is required. Choose one exact active profile ID listed in the current conversation; missing or unknown roles are errors and never fall back to a generic agent.",
    "When using the Task tool, subagent_type is required. Choose one exact active profile ID listed in the current conversation; missing or unknown roles are errors and never fall back to a generic agent.",
  );
  return {
    ...entry,
    handler: taskHandler,
    inputSchema: TaskInputJsonSchema,
    runtimeInputSchema: TaskInputSchema,
    capability: "Claude Code-compatible alias for launching a ZCode subagent",
    metadata: {
      ...entry.metadata,
      shouldDefer: true,
      name: TASK_TOOL_NAME,
      providerVisible: false,
      description: [
        "Claude Code-compatible alias for the Agent tool. Use this when plugin instructions ask for the Task tool.",
        "",
        description,
      ].join("\n"),
    },
  };
}

export function createAgentToolEntry(
  options: {
    /** 见 buildAgentProviderDescription：缺省 true，只有灰度显式关闭时才去掉工作流那一行。 */
    dynamicWorkflowEnabled?: boolean;
  } = {},
): ToolEntry {
  return {
    ...agentToolEntry,
    metadata: {
      ...agentToolEntry.metadata,
      description: buildAgentProviderDescription(options),
    },
  };
}

export function createTaskToolEntry(
  options: {
    /** Task 是 Agent 的兼容别名，描述整段内嵌 Agent 的，因此同一道门一起传下去。 */
    dynamicWorkflowEnabled?: boolean;
  } = {},
): ToolEntry {
  return createTaskToolEntryFromAgent(createAgentToolEntry(options));
}
