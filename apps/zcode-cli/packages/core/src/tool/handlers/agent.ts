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
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";
import {
  isAgentTypeAllowedForCaller,
  matchAgentTypeInCatalog,
  resolveAgentBackgroundPolicy,
} from "../../subagent/profile.js";

const MAX_AGENT_MODEL_BYTES = 120_000;

/**
 * Жёсткий preflight перед спавном: `requires` объявляет уже установленные
 * capability. Отсутствующий skill блокирует spawn до SkillInstall; отсутствующий
 * MCP/plugin — до InstallCapability с user approval. После установки родитель
 * повторяет тот же Task.
 */
export async function assertRequiredCapabilities(
  requires: readonly string[] | undefined,
  context: Pick<
    ToolExecutionContext,
    | "skillPort"
    | "capabilityInstallPort"
    | "workingDirectory"
    | "traceContext"
    | "toolCallId"
  >,
): Promise<void> {
  const requested = (requires ?? []).map((value) => value.trim()).filter(Boolean);
  if (requested.length === 0) return;

  const skills = requested
    .filter((value) => value.startsWith("skill:"))
    .map((value) => value.slice("skill:".length).trim())
    .filter(Boolean);
  const environment = requested.filter(
    (value) => value.startsWith("mcp:") || value.startsWith("plugin:"),
  );
  const unknown = requested.filter(
    (value) =>
      !value.startsWith("skill:") &&
      !value.startsWith("mcp:") &&
      !value.startsWith("plugin:"),
  );
  if (unknown.length > 0) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      `Unsupported capability requirement: ${unknown.join(", ")}. Use skill:<name>, mcp:<server>, or plugin:<id>. The spawn was not started.`,
      {
        context: {
          code: AgentErrorCode.CAPABILITY_MISSING,
          required: [...requested],
          toolCallId: context.toolCallId,
          toolName: "Agent",
        },
        recoverable: true,
      },
    );
  }

  if (skills.length > 0) {
    if (!context.skillPort) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        "Skill discovery is unavailable; cannot verify required skills. The spawn was not started.",
        {
          context: {
            code: AgentErrorCode.CAPABILITY_MISSING,
            required: [...requested],
            toolCallId: context.toolCallId,
            toolName: "Agent",
          },
          recoverable: true,
        },
      );
    }
    let available: Set<string>;
    try {
      const outcome = await context.skillPort.discoverSkills({
        workingDirectory: context.workingDirectory,
        ...(context.traceContext ? { trace: context.traceContext } : {}),
      });
      available = new Set(
        outcome.skills.flatMap((skill) =>
          [skill.name, skill.qualifiedName].filter(
            (name): name is string => typeof name === "string" && name.length > 0,
          ),
        ),
      );
    } catch (error) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        `Skill discovery failed: ${error instanceof Error ? error.message : String(error)}. The spawn was not started.`,
        {
          context: {
            code: AgentErrorCode.CAPABILITY_MISSING,
            required: [...requested],
            toolCallId: context.toolCallId,
            toolName: "Agent",
          },
          recoverable: true,
        },
      );
    }
    const missing = skills.filter((name) => !available.has(name));
    if (missing.length > 0) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        `Required skill(s) not installed: ${missing.join(", ")}. Run SkillInstall for each, then retry the same Task. The spawn was not started.`,
        {
          context: {
            code: AgentErrorCode.CAPABILITY_MISSING,
            required: [...requested],
            requiredSkills: missing,
            toolCallId: context.toolCallId,
            toolName: "Agent",
          },
          recoverable: true,
        },
      );
    }
  }

  if (environment.length > 0) {
    if (!context.capabilityInstallPort) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        `MCP servers and plugins are installed through the environment, and this runtime has no installer port: ${environment.join(", ")}. Configure/install them, then retry the same Task. The spawn was not started.`,
        {
          context: {
            code: AgentErrorCode.CAPABILITY_REQUIRES_ENVIRONMENT,
            required: [...requested],
            toolCallId: context.toolCallId,
            toolName: "Agent",
          },
          recoverable: true,
        },
      );
    }
    const missing: string[] = [];
    for (const capability of environment) {
      const separator = capability.indexOf(":");
      const kind = capability.slice(0, separator);
      const id = capability.slice(separator + 1).trim();
      if ((kind !== "mcp" && kind !== "plugin") || id.length === 0) {
        missing.push(capability);
        continue;
      }
      let installed = false;
      try {
        installed = await context.capabilityInstallPort.isInstalled(kind, id);
      } catch (error) {
        throw createCoreError(
          CoreErrorType.ToolExecutionFailed,
          `Could not verify capability '${capability}': ${error instanceof Error ? error.message : String(error)}. The spawn was not started.`,
          {
            context: {
              code: AgentErrorCode.CAPABILITY_MISSING,
              capability,
              required: [...requested],
              toolCallId: context.toolCallId,
              toolName: "Agent",
            },
            recoverable: true,
          },
        );
      }
      if (!installed) missing.push(capability);
    }
    if (missing.length > 0) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        `Capability not installed: ${missing.join(", ")}. Call InstallCapability { kind, id, ... } (user approval required), wait for installed, then retry the same Task once. The spawn was not started.`,
        {
          context: {
            code: AgentErrorCode.CAPABILITY_MISSING,
            required: [...requested],
            missingCapabilities: missing,
            installTool: "InstallCapability",
            toolCallId: context.toolCallId,
            toolName: "Agent",
          },
          recoverable: true,
        },
      );
    }
  }
}

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
    "Reach for this when the task matches an available agent type, when you have independent work to run in parallel, or when answering would mean reading across several files — delegate it and you keep the conclusion, not the file dumps. If the request spans two or more independent file areas, before any Read loop call Task once with subagent_type orchestrator, or several Task calls in the same message with disjoint paths. A small single-file question stays with you. After those agents return, synthesize the answer and do not scan the repository again. For a single-fact lookup where you already know the file, symbol, or value, search directly. Once you've delegated a search, don't also run it yourself — wait for the result.",
    "",
    "Batch independent agents: when two or more agents' inputs do not depend on each other's output, launch them as several Task calls in the SAME response instead of one at a time. Sequential waiting is the dominant cost of delegation — 73 of 90 measured tool-hours went to waiting for subagents. Dependencies still serialize: an agent consuming another agent's findings belongs in a later response.",
    "",
    "For repository/code tasks, if CodeIndex is available, check status and run a targeted search before broad file reads. Use context/impact/trace for relationships. Answer from the excerpt and path:startLine-endLine when the fact is already in the excerpt. Read only to edit, open a test, or when the excerpt is truncated, endLine is missing, or the needed text is absent. Issue those Reads in one parallel batch with offset = startLine and a limit covering the range — not the whole file and not every caller. Do not repeat an index-backed lookup with a broad Explore/Grep sweep. Fall back to normal search if the index is unavailable, empty, stale, or does not cover the question. A partial index does not prove the code is absent.",
    "",
    "If the user's message begins with `Start`/`start` as a task label, or explicitly asks to use the named profile, the first tool action must invoke the exact `start` profile through Agent/Task before any repository read, search, CodeIndex call, or command. Let start decide whether to delegate independent work to orchestrator; do not silently do the same work from root before or alongside it. If invocation fails or the profile is unavailable, report that blocker instead of taking over.",
    "When you are the start profile, call Task once with subagent_type: \"orchestrator\", a short description and the full user task in prompt. Do not send task_graph; the orchestrator owns worker planning. Top-level acceptance_criteria are optional.",
    "",
    "- The agent's final message is returned to you as the tool result; it is not shown to the user — relay what matters.",
    "- Use SendMessage with the agent's ID to continue a previously spawned agent with its context intact; a new Agent call starts fresh.",
    "- Each agent type's model, reasoning effort, and tools come from its definition (`.zcode/agents/*.md` frontmatter).",
    "- `run_in_background: true` runs the agent asynchronously; you'll be notified when it completes. In a root/main session, two or more Agent calls in one batch are backgrounded automatically, so collect each result as it arrives instead of waiting for the slowest. Pass `run_in_background: false` only when you must block this turn. Inside a subagent, start, orchestrator, or worker turn, Agent/Task calls always run in the foreground and return their results before that turn ends; do not set `run_in_background: true` there; use `task_graph` when you need an explicit static DAG join.",
    "- For every write-capable subagent, pass `write_paths` with the exact files/directories this branch will write; use `[]` for a read-only branch. Write-capable spawns without `write_paths` are rejected at admission, and Write/Edit/ApplyPatch are limited to the declared scope.",
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

// 修复依据：旧指令要求 root 逐字输出所有事实、未知项和证据路径，导致普通追问也变成冗长审计报告。
const PRESENTATION_AUTHORITY_INSTRUCTION = [
  "This is the start agent's concise user-facing answer plus supporting verification context.",
  "Answer the user's actual request directly in natural, concise language, normally in 1–3 sentences. Use userText as the answer and facts, unknowns, evidenceRefs, status and unresolved only to verify it and preserve material caveats.",
  "If status is partial, failed or blocked, say so plainly. Do not copy the internal lists, paths, line numbers, commands or child session IDs into an ordinary reply. Include those details only when the user asks for evidence, sources or a detailed audit. You may paraphrase for clarity, but add no unsupported claims and do not mix in raw child/subagent text.",
].join("\n");

/**
 * Передаёт ответ Start и supporting context root без сырого child content, agentId и usage.
 * Root синтезирует естественный ответ; служебные evidence остаются для проверки.
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
      ...(data.reasoningLevel === undefined ? [] : [`reasoning_effort: ${data.reasoningLevel}`]),
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
  await assertRequiredCapabilities(parsed.requires, context);
  const agentType = parsed.subagent_type;
  const callerAgentType = context.callerAgentType;
  const isStart = callerAgentType?.trim().toLocaleLowerCase("en-US") === "start";
  if (isStart && parsed.task_graph !== undefined && parsed.acceptance_criteria === undefined) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      "start must use Task(orchestrator), not task_graph",
      {
        context: {
          code: AgentErrorCode.TASK_DAG_UNAVAILABLE,
          agentType,
          callerAgentType,
          toolCallId: context.toolCallId,
          toolName: "Agent",
        },
        recoverable: true,
      },
    );
  }
  // 修复依据：仅当 start 把 DAG 和顶层验收条件一起传入时忽略该 DAG。
  // orchestrator 按完整 prompt 和这些条件自行规划，避免反复 schema 失败。
  const taskGraph =
    isStart && parsed.task_graph !== undefined && parsed.acceptance_criteria !== undefined
      ? undefined
      : parsed.task_graph;

  // 同一批里的多个 Agent 各自独立：root 默认改为后台启动，先返回的 agent 结果立即
  // 进入通知队列。Turn-scoped caller 不能后台化，否则它的 runtime 关闭时会取消孩子。
  const { runInBackground, allowBackground } = resolveAgentBackgroundPolicy({
    agentType,
    callerAgentType,
    requestedBackground: parsed.run_in_background,
    hasTaskGraph: taskGraph !== undefined,
    parallelAgentBatchSize: context.parallelAgentBatchSize,
    toolCallId: context.toolCallId,
  });

  if (taskGraph && (runInBackground || parsed.acceptance_criteria !== undefined)) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      runInBackground
        ? "task_graph cannot be combined with run_in_background:true"
        : "task_graph nodes own acceptance criteria; top-level acceptance_criteria is not allowed",
      {
        context: {
          code: AgentErrorCode.TASK_DAG_UNAVAILABLE,
          agentType,
          callerAgentType,
          toolCallId: context.toolCallId,
          toolName: "Agent",
        },
        recoverable: true,
      },
    );
  }

  // Caller routing policy is the same predicate that builds the visible catalog:
  // start -> orchestrator only, orchestrator -> worker roles only.
  if (callerAgentType !== undefined && !isAgentTypeAllowedForCaller(agentType, callerAgentType)) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      callerAgentType.trim().toLocaleLowerCase("en-US") === "start"
        ? `Agent type '${agentType}' is not available to start. start must delegate through Task(orchestrator).`
        : `Agent type '${agentType}' is not available to ${callerAgentType}. Router roles must delegate to worker roles instead of calling start or orchestrator.`,
      {
        context: {
          code: AgentErrorCode.UNKNOWN_AGENT_TYPE,
          agentType,
          callerAgentType,
          toolCallId: context.toolCallId,
          toolName: "Agent",
        },
        recoverable: true,
      },
    );
  }

  const availableAgentTypes = context.availableAgentTypes;
  if (availableAgentTypes) {
    // 原因: встроенный general-purpose оставался во внутреннем runtime-каталоге и обходил
    // скрытие из model prompt; проверка по тому же snapshot закрывает Agent и Task до admission.
    // Нормализация сохранена: runner сам разрешает регистр и разделители, поэтому handler
    // отклоняет только те роли, которые runner всё равно не сможет разрешить.
    if (matchAgentTypeInCatalog(agentType, availableAgentTypes) === "none") {
      const availableList = availableAgentTypes.join(", ");
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        [
          `Agent type '${agentType}' is not available. Choose one exact active role ID: ${availableList}`,
          `Agent type '${agentType}' not found. Available agents: ${availableList}`,
        ].join("\n"),
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
  }

  // task_graph bypasses the top-level subagent_type check: every node picks its own
  // profile. Apply the same caller policy and catalog to nodes before runTaskDag can
  // resolve them against the shared snapshot.
  if (taskGraph) {
    for (const node of taskGraph.nodes) {
      if (!isAgentTypeAllowedForCaller(node.subagent_type, callerAgentType)) {
        throw createCoreError(
          CoreErrorType.ToolExecutionFailed,
          `Agent type '${node.subagent_type}' is not available to ${callerAgentType ?? "root"}. task_graph node '${node.id}' must delegate to a worker role instead of start or orchestrator.`,
          {
            context: {
              code: AgentErrorCode.UNKNOWN_AGENT_TYPE,
              agentType: node.subagent_type,
              callerAgentType,
              nodeId: node.id,
              toolCallId: context.toolCallId,
              toolName: "Agent",
            },
            recoverable: true,
          },
        );
      }
      if (
        availableAgentTypes &&
        matchAgentTypeInCatalog(node.subagent_type, availableAgentTypes) === "none"
      ) {
        const availableList = availableAgentTypes.join(", ");
        throw createCoreError(
          CoreErrorType.ToolExecutionFailed,
          [
            `Agent type '${node.subagent_type}' is not available. Choose one exact active role ID: ${availableList}`,
            `task_graph node '${node.id}' uses an unknown agent type '${node.subagent_type}'. Available agents: ${availableList}`,
          ].join("\n"),
          {
            context: {
              code: AgentErrorCode.UNKNOWN_AGENT_TYPE,
              agentType: node.subagent_type,
              availableAgentTypes: [...availableAgentTypes],
              nodeId: node.id,
              toolCallId: context.toolCallId,
              toolName: "Agent",
            },
            recoverable: true,
          },
        );
      }
    }
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
    ...(parsed.requires ? { requiredCapabilities: parsed.requires } : {}),
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
    allowBackground,
    ...(context.model ? { model: context.model } : {}),
    ...(context.subagentModelOverride ? { modelOverride: context.subagentModelOverride } : {}),
  };

  if (taskGraph) {
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
        nodes: taskGraph.nodes,
        ...(parsed.level === undefined ? {} : { level: parsed.level }),
        ...(taskGraph.max_parallel === undefined
          ? {}
          : { maxParallel: taskGraph.max_parallel }),
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
      ...(parsed.write_paths === undefined ? {} : { writePaths: parsed.write_paths }),
      ...(parsed.acceptance_criteria === undefined
        ? {}
        : { acceptanceCriteria: parsed.acceptance_criteria }),
      ...(parsed.effort === undefined ? {} : { effort: parsed.effort }),
      ...(parsed.effort_above_parent === undefined
        ? {}
        : { effortAboveParent: parsed.effort_above_parent }),
      ...(parsed.level === undefined ? {} : { level: parsed.level }),
      runInBackground,
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
