// ============================================================
// Agent Tool - Subagent orchestration tool
// ============================================================
// 支持基于配置的子代理和异步启动。

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import type { ModelUsage } from "../model/index.js";
import type { PrismTaskAcceptanceDecision } from "../interfaces/subagent.port.js";
import { toToolJsonSchema } from "./json-schema.js";

export const AgentType = {
  GeneralPurpose: "general-purpose",
  Explore: "Explore",
} as const;

export type AgentType = string;

const AgentAcceptanceCriterionSchema = z
  .object({
    id: z.string().min(1).max(128),
    description: z
      .string()
      .min(1)
      .max(500)
      .refine((description) => new TextEncoder().encode(description).byteLength <= 500, {
        message: "Acceptance criterion description must not exceed 500 UTF-8 bytes",
      }),
    check: z
      .object({
        kind: z.literal("bash_exit_code"),
        command: z.string().min(1).max(2000),
        expectedExitCode: z.literal(0),
      })
      .strict(),
  })
  .strict();

export const AGENT_TASK_GRAPH_MAX_NODES = 128;
export const AGENT_TASK_GRAPH_MAX_PARALLEL = 24;
export const AGENT_TASK_GRAPH_MAX_BYTES = 120_000;

const AgentTaskGraphNodeSchema = z
  .object({
    id: z.string().min(1).max(128),
    description: z.string().min(1).max(500),
    prompt: z.string().min(1).max(20_000),
    depends_on: z.array(z.string().min(1).max(128)).max(AGENT_TASK_GRAPH_MAX_NODES).optional(),
    // 修复依据：task graph 中缺失角色时 runner 会继承父角色，仍可能绕过节点级 profile 选择。
    subagent_type: z.string().min(1).max(128),
    acceptance_criteria: z.array(AgentAcceptanceCriterionSchema).max(16).optional(),
  })
  .strict()
  .superRefine((node, context) => {
    const criterionIds = new Set<string>();
    node.acceptance_criteria?.forEach((criterion, index) => {
      if (criterionIds.has(criterion.id)) {
        context.addIssue({
          code: "custom",
          path: ["acceptance_criteria", index, "id"],
          message: `Duplicate acceptance criterion id for task_graph node ${node.id}: ${criterion.id}`,
        });
      }
      criterionIds.add(criterion.id);
    });
  });

export const AgentTaskGraphSchema = z
  .object({
    nodes: z.array(AgentTaskGraphNodeSchema).min(1).max(AGENT_TASK_GRAPH_MAX_NODES),
    max_parallel: z.number().int().min(1).max(AGENT_TASK_GRAPH_MAX_PARALLEL).optional(),
  })
  .strict()
  .superRefine((graph, context) => {
    const firstIndexById = new Map<string, number>();
    let hasDuplicateNodeId = false;
    graph.nodes.forEach((node, index) => {
      if (firstIndexById.has(node.id)) {
        hasDuplicateNodeId = true;
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "id"],
          message: `Duplicate task_graph node id: ${node.id}`,
        });
      } else {
        firstIndexById.set(node.id, index);
      }
    });

    let hasInvalidDependency = false;
    graph.nodes.forEach((node, index) => {
      const dependencies = new Set<string>();
      for (const [dependencyIndex, dependencyId] of (node.depends_on ?? []).entries()) {
        if (dependencies.has(dependencyId)) {
          hasInvalidDependency = true;
          context.addIssue({
            code: "custom",
            path: ["nodes", index, "depends_on", dependencyIndex],
            message: `Duplicate dependency for task_graph node ${node.id}: ${dependencyId}`,
          });
        }
        dependencies.add(dependencyId);
        if (dependencyId === node.id) {
          hasInvalidDependency = true;
          context.addIssue({
            code: "custom",
            path: ["nodes", index, "depends_on", dependencyIndex],
            message: `Task_graph node ${node.id} cannot depend on itself`,
          });
        } else if (!firstIndexById.has(dependencyId)) {
          hasInvalidDependency = true;
          context.addIssue({
            code: "custom",
            path: ["nodes", index, "depends_on", dependencyIndex],
            message: `Unknown task_graph dependency: ${dependencyId}`,
          });
        }
      }
    });

    const graphBytes = new TextEncoder().encode(JSON.stringify(graph)).byteLength;
    if (graphBytes > AGENT_TASK_GRAPH_MAX_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["nodes"],
        message: `task_graph exceeds the ${AGENT_TASK_GRAPH_MAX_BYTES}-byte input limit`,
      });
    }

    if (hasDuplicateNodeId || hasInvalidDependency) return;

    const stateById = new Map<string, "visiting" | "visited">();
    const hasCycleFrom = (nodeId: string): boolean => {
      const state = stateById.get(nodeId);
      if (state === "visiting") return true;
      if (state === "visited") return false;

      stateById.set(nodeId, "visiting");
      const node = graph.nodes[firstIndexById.get(nodeId)!];
      for (const dependencyId of node?.depends_on ?? []) {
        if (hasCycleFrom(dependencyId)) return true;
      }
      stateById.set(nodeId, "visited");
      return false;
    };

    for (const node of graph.nodes) {
      if (hasCycleFrom(node.id)) {
        context.addIssue({
          code: "custom",
          path: ["nodes"],
          message: "task_graph dependencies must be acyclic",
        });
        break;
      }
    }
  });

export type AgentTaskGraph = z.infer<typeof AgentTaskGraphSchema>;

const AgentInputObjectSchema = z.object({
  description: z.string().describe("A short (3-5 word) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  acceptance_criteria: z
    .array(AgentAcceptanceCriterionSchema)
    .max(16)
    .optional()
    .describe(
      "Optional Host-verifiable acceptance checks. Currently supports only an exact Bash command that must complete with exit code 0; omitted or unsupported evidence remains unknown.",
    ),
  task_graph: AgentTaskGraphSchema.optional().describe(
    "Optional bounded foreground task graph. Every dependency must reference a unique node in the graph; dependencies cannot contain cycles. Do not combine with run_in_background:true or top-level acceptance_criteria.",
  ),
  // 修复依据：Agent 与递归 Task 必须共享精确角色合同，缺省角色会静默落到通用代理。
  subagent_type: z
    .string()
    .min(1)
    .max(128)
    .describe("Required exact ID of an active agent profile listed in the current conversation"),
  // subagent 模型由 Settings / Markdown profile 统一决定；若把调用级
  // model 暴露给父模型，历史 tool call 会持续生成旧 override 并覆盖当前配置。
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "Set to true to run this agent in the background. You will be notified when it completes.",
    ),
  /**
   * 模型对本子树剩余可 spawn 次数的声明。只是建议值：Host 会用自身配额取 min，
   * 模型无法借此抬高预算；缺省时 Host 按父预算分配。
   */
  remaining_spawns: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Optional advisory count of further subagent spawns this subtree may request. The Host clamps it to its own remaining budget; it never increases the budget.",
    ),
  /** 当前 Agent 在 spawn 树中的层级记录；仅供提示与诊断，不构成深度上限。 */
  level: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Optional non-negative nesting level recorded for this agent. Informational only; the Host does not enforce a depth cap.",
    ),
});

function withAgentInputConstraints<T extends z.ZodObject<any>>(schema: T) {
  return schema.superRefine((input, context) => {
    if (input.task_graph && input.run_in_background === true) {
      context.addIssue({
        code: "custom",
        path: ["run_in_background"],
        message: "task_graph cannot be combined with run_in_background:true",
      });
    }
    if (input.task_graph && input.acceptance_criteria !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["acceptance_criteria"],
        message:
          "task_graph nodes own acceptance criteria; top-level acceptance_criteria is not allowed",
      });
    }
  });
}

export const AgentInputSchema = withAgentInputConstraints(AgentInputObjectSchema);

/** Task and Agent share one exact-profile dispatch contract. */
export const TaskInputSchema = AgentInputSchema;

export type AgentInput = z.infer<typeof AgentInputSchema>;
export type TaskInput = z.infer<typeof TaskInputSchema>;

export const AgentInputJsonSchema = toToolJsonSchema(AgentInputSchema);
export const TaskInputJsonSchema = toToolJsonSchema(TaskInputSchema);

export interface AgentTextContentBlock {
  type: "text";
  text: string;
}

/**
 * Machine-readable итог работы субагента. `AgentOutput.status` остаётся `"completed"`
 * по контракту; фактическую полноту показывает `WorkResult.status`.
 */
export const WORK_RESULT_STATUSES = ["completed", "partial", "failed", "blocked"] as const;

export type WorkResultStatus = (typeof WORK_RESULT_STATUSES)[number];
export type WorkResultTestStatus = "passed" | "failed" | "not_run";

export interface WorkResultTestEntry {
  command: string;
  status: WorkResultTestStatus;
  summary?: string;
}

export interface WorkResultClaimEntry {
  path: string;
  runId?: string;
  attemptId?: string;
}

export interface WorkResultMetrics {
  durationMs?: number;
  toolUses?: number;
  tokens?: number;
}

export interface WorkResult {
  status: WorkResultStatus;
  summary: string;
  files: string[];
  evidence: string[];
  tests: WorkResultTestEntry[];
  unresolved: string[];
  confidence?: number;
  claims: WorkResultClaimEntry[];
  metrics?: WorkResultMetrics;
}

/**
 * Единые лимиты `WorkResult`. Схема, runtime bounding и DAG-агрегация используют
 * один источник, иначе сгенерированный результат может не пройти собственную схему
 * и успешный child превращается в ToolExecutionFailed.
 */
export const WORK_RESULT_LIMITS = {
  summary: 8_000,
  files: { max: 200, entry: 1_000 },
  evidence: { max: 200, entry: 2_000 },
  tests: { max: 100, command: 2_000, summary: 2_000 },
  unresolved: { max: 200, entry: 2_000 },
  claims: { max: 200, path: 1_000, runId: 512, attemptId: 512 },
} as const;

const WorkResultTestEntrySchema = z
  .object({
    command: z.string().min(1).max(WORK_RESULT_LIMITS.tests.command),
    status: z.enum(["passed", "failed", "not_run"]),
    summary: z.string().max(WORK_RESULT_LIMITS.tests.summary).optional(),
  })
  .strict();

const WorkResultClaimEntrySchema = z
  .object({
    path: z.string().min(1).max(WORK_RESULT_LIMITS.claims.path),
    runId: z.string().min(1).max(WORK_RESULT_LIMITS.claims.runId).optional(),
    attemptId: z.string().min(1).max(WORK_RESULT_LIMITS.claims.attemptId).optional(),
  })
  .strict();

const WorkResultMetricsSchema = z
  .object({
    durationMs: z.number().int().nonnegative().optional(),
    toolUses: z.number().int().nonnegative().optional(),
    tokens: z.number().int().nonnegative().optional(),
  })
  .strict();

/** Строгая схема `<zcode-work-result>`; несоответствие переводит потребителя на fallback. */
export const WorkResultSchema = z
  .object({
    status: z.enum(WORK_RESULT_STATUSES),
    summary: z.string().min(1).max(WORK_RESULT_LIMITS.summary),
    files: z
      .array(z.string().min(1).max(WORK_RESULT_LIMITS.files.entry))
      .max(WORK_RESULT_LIMITS.files.max)
      .default([]),
    evidence: z
      .array(z.string().min(1).max(WORK_RESULT_LIMITS.evidence.entry))
      .max(WORK_RESULT_LIMITS.evidence.max)
      .default([]),
    tests: z.array(WorkResultTestEntrySchema).max(WORK_RESULT_LIMITS.tests.max).default([]),
    unresolved: z
      .array(z.string().min(1).max(WORK_RESULT_LIMITS.unresolved.entry))
      .max(WORK_RESULT_LIMITS.unresolved.max)
      .default([]),
    confidence: z.number().min(0).max(1).optional(),
    claims: z.array(WorkResultClaimEntrySchema).max(WORK_RESULT_LIMITS.claims.max).default([]),
    metrics: WorkResultMetricsSchema.optional(),
  })
  .strict();

/**
 * Пользовательский конверт, который формирует только профиль `start`.
 * Runtime парсит его из финального ответа Start и передаёт в formatter как есть:
 * без синтеза новых утверждений и без worker/DAG-содержимого.
 */
export interface AgentPresentation {
  userText: string;
  facts: string[];
  unknowns: string[];
  evidenceRefs: string[];
}

const AGENT_PRESENTATION_USER_TEXT_MAX_CHARS = 20_000;
const AGENT_PRESENTATION_ENTRY_MAX_CHARS = 2_000;
const AGENT_PRESENTATION_MAX_ENTRIES = 200;

const AgentPresentationEntrySchema = z
  .string()
  .min(1)
  .max(AGENT_PRESENTATION_ENTRY_MAX_CHARS);

/** Строгая схема `<zcode-presentation>`; любое несоответствие отбрасывает блок целиком. */
export const AgentPresentationSchema = z
  .object({
    userText: z.string().min(1).max(AGENT_PRESENTATION_USER_TEXT_MAX_CHARS),
    facts: z.array(AgentPresentationEntrySchema).max(AGENT_PRESENTATION_MAX_ENTRIES),
    unknowns: z.array(AgentPresentationEntrySchema).max(AGENT_PRESENTATION_MAX_ENTRIES),
    evidenceRefs: z.array(AgentPresentationEntrySchema).max(AGENT_PRESENTATION_MAX_ENTRIES),
  })
  .strict();

export interface AgentCompletedOutput {
  status: "completed";
  agentId: string;
  agentType: AgentType;
  description: string;
  prompt: string;
  content: AgentTextContentBlock[];
  totalToolUseCount: number;
  totalDurationMs: number;
  totalTokens?: number;
  usage?: ModelUsage;
  /** Machine-readable итог: status/summary/files/tests/evidence/unresolved/claims. */
  workResult?: WorkResult;
  /** Пользовательский конверт Start; worker-роли и DAG-узлы его не формируют. */
  presentation?: AgentPresentation;
  /** Host-derived decision. A verified command criterion does not prove semantic task quality. */
  acceptance?: PrismTaskAcceptanceDecision;
}

export interface AgentBackgroundedOutput {
  status: "async_launched";
  isAsync: true;
  agentId: string;
  agentType: AgentType;
  description: string;
  prompt: string;
  childSessionId: string;
  backgroundTaskId: string;
  outputFile: string;
  canReadOutputFile: boolean;
}

export type AgentOutput = AgentCompletedOutput | AgentBackgroundedOutput;

export const AgentTextContentBlockSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .strict();

export const AgentCompletedOutputSchema = z
  .object({
    status: z.literal("completed"),
    agentId: z.string(),
    agentType: z.string(),
    description: z.string(),
    prompt: z.string(),
    content: z.array(AgentTextContentBlockSchema),
    totalToolUseCount: z.number().int().nonnegative(),
    totalDurationMs: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative().optional(),
    usage: z.record(z.unknown()).optional(),
    workResult: WorkResultSchema.optional(),
    presentation: AgentPresentationSchema.optional(),
    acceptance: z
      .object({
        status: z.enum(["unknown", "verified", "rejected"]),
        passedCriterionIds: z.array(z.string()),
        failedCriterionIds: z.array(z.string()),
        missingCriterionIds: z.array(z.string()),
      })
      .strict()
      .optional(),
  })
  .strict();

export const AgentBackgroundedOutputSchema = z
  .object({
    status: z.literal("async_launched"),
    isAsync: z.literal(true),
    agentId: z.string(),
    agentType: z.string(),
    description: z.string(),
    prompt: z.string(),
    childSessionId: z.string(),
    backgroundTaskId: z.string(),
    outputFile: z.string(),
    canReadOutputFile: z.boolean(),
  })
  .strict();

export const AgentOutputSchema = z.union([
  AgentCompletedOutputSchema,
  AgentBackgroundedOutputSchema,
]);

export const AgentOutputJsonSchema = toToolJsonSchema(AgentOutputSchema);

export interface AgentToolCall {
  id: ToolCallId;
  name: "Agent";
  input: AgentInput;
  traceId: TraceId;
  startedAt: Date;
}

export interface AgentToolResult {
  toolCallId: ToolCallId;
  output: AgentOutput;
  traceId: TraceId;
  durationMs: number;
}

export const AgentErrorCode = {
  SUBAGENT_UNAVAILABLE: "agent_subagent_unavailable",
  TASK_DAG_UNAVAILABLE: "agent_task_dag_unavailable",
  BACKGROUND_UNAVAILABLE: "agent_background_unavailable",
  UNKNOWN_AGENT_TYPE: "agent_unknown_type",
  CHILD_RUNTIME_FAILED: "agent_child_runtime_failed",
} as const;

export type AgentErrorCode = (typeof AgentErrorCode)[keyof typeof AgentErrorCode];
