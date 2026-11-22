import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import {
  BUILTIN_WORKFLOW_COMMAND_NAME,
  expandBuiltinWorkflowCommandPrompt,
} from "./builtin-workflow-command.js";

const BUILTIN_PROMPT_COMMAND_PATTERN = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;
const INIT_COMMAND_NAME = "init";
const ZCODE_NATIVE_AGENT_COMMANDS = {
  start: {
    role: "start",
    instruction:
      "Use the start gateway: preserve the user's goal, scope, constraints, and authorization; send one deliverable directly to its best matching worker. Use orchestrator only for multiple independent deliverables or real dependency planning and joining. At the root, call Task(start) only. If start returns an exact missing plugin capability, call InstallCapability for that plugin only after user approval, then retry Task(start) once. For any other blocked/failed result, report it; do not use root workspace tools or launch sibling profiles. Do not ask again for permission already granted.",
    defaultTask: "Handle the user's actionable workspace request.",
  },
  review: {
    role: "reviewer",
    instruction:
      "Perform an independent read-only review. Report confirmed findings with file, scenario, impact, and evidence; if none, state the reviewed scope and limits.",
    defaultTask: "Review the current workspace changes against their requirements.",
  },
  evolve: {
    role: "self-improver",
    instruction:
      "Investigate one observable failure or limitation. Establish evidence, one testable mechanism, a narrow reversible improvement, a before/after check, and a rollback condition. Do not change anything if the failure cannot be grounded.",
    defaultTask: "Ask the user for the observable failure to investigate.",
  },
  evaluate: {
    role: "evaluator",
    instruction:
      "Evaluate each explicit criterion as pass, fail, or not run, with direct evidence. Missing evidence must remain not run.",
    defaultTask: "Evaluate the current task's requested outcomes against available evidence.",
  },
} as const;

interface ResolveZCodeBuiltinPromptCommandOptions {
  /**
   * 动态工作流灰度门（docs/dynamic-workflow/launch.md「Gray release」）。**只有显式 false 才挡下**
   * `/workflow`：TUI / headless 从不设置该字段，那里的功能始终开启。挡下时返回 undefined，
   * 与「命令不存在」同形——`workflow` 是保留名，后续的自定义命令解析同样拒绝展开，于是原文作为
   * 普通 prompt 交给模型，与目录侧剔除它的结论一致（DWG-03）。
   */
  dynamicWorkflowEnabled?: boolean;
  evaluationCatalog?: SharedEvaluationCatalog;
  workingDirectory?: string;
}

const SHARED_EVALUATION_CASE_LIMIT = 50;
const SHARED_EVALUATION_TEXT_LIMIT = 240;
const SHARED_EVALUATION_ID = /^[A-Z][A-Z0-9-]{1,40}$/;
// 修复原因：原模式把裸词 token/bearer 当作密钥，合法用例 id（E-TOKEN-BUDGET）会让整个目录失效。
// 依据：只有赋值形态的凭据片段才算密钥，纯度量名词不应拦截。
const SHARED_EVALUATION_SECRET = /sk-|(?:bearer|token|password|api[_-]?key)\s*[:=]\s*\S+/i;

interface SharedEvaluationCase {
  criterion: string;
  evidence?: string;
  id: string;
}

type SharedEvaluationCatalog =
  | { cases: SharedEvaluationCase[]; status: "ready" }
  | { reason: string; status: "invalid" }
  | { status: "absent" };

function sharedEvaluationCatalogPath(workingDirectory: string): string {
  return join(workingDirectory, ".zcode", "evaluation-cases.json");
}

export function parseSharedEvaluationCatalog(raw: string): SharedEvaluationCatalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { reason: "not-json", status: "invalid" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { reason: "shape", status: "invalid" };
  }
  const document = parsed as Record<string, unknown>;
  if (document.version !== 1) return { reason: "version", status: "invalid" };
  if (!Array.isArray(document.cases)) return { reason: "cases", status: "invalid" };
  if (document.cases.length > SHARED_EVALUATION_CASE_LIMIT) {
    return { reason: "cases", status: "invalid" };
  }
  const cases: SharedEvaluationCase[] = [];
  const seen = new Set<string>();
  for (const item of document.cases) {
    const parsedCase = parseSharedEvaluationCase(item);
    if (parsedCase.status === "invalid") return parsedCase;
    if (seen.has(parsedCase.case.id)) return { reason: "duplicate", status: "invalid" };
    seen.add(parsedCase.case.id);
    cases.push(parsedCase.case);
  }
  return { cases, status: "ready" };
}

export async function loadEvaluationCatalogForEvaluate(
  text: string,
  workingDirectory: string,
): Promise<SharedEvaluationCatalog | undefined> {
  const name = text.trim().split(/\s+/u, 1)[0]?.toLowerCase();
  if (name !== "/evaluate") return undefined;
  return loadSharedEvaluationCatalog(workingDirectory);
}

export async function loadSharedEvaluationCatalog(
  workingDirectory: string,
): Promise<SharedEvaluationCatalog> {
  let workspaceRoot: string;
  try {
    workspaceRoot = await realpath(workingDirectory);
  } catch {
    return { reason: "unreadable", status: "invalid" };
  }
  const catalogPath = sharedEvaluationCatalogPath(workspaceRoot);
  let filePath: string;
  try {
    filePath = await realpath(catalogPath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { status: "absent" }
      : { reason: "unreadable", status: "invalid" };
  }
  const fromWorkspace = relative(workspaceRoot, filePath);
  // 原因：目录必须留在工作区内。指向工作区外的符号链接不能成为评测集。
  if (fromWorkspace.startsWith("..") || isAbsolute(fromWorkspace)) {
    return { reason: "path", status: "invalid" };
  }
  try {
    return parseSharedEvaluationCatalog(await readFile(filePath, "utf8"));
  } catch {
    return { reason: "unreadable", status: "invalid" };
  }
}

interface ResolvedZCodeBuiltinPromptCommand {
  /** 命中的内置命令名（`init` / `workflow`），调用方据此挂命令特有的副作用（如 onDemand 激活）。 */
  name: string;
  prompt: string;
}

export function resolveZCodeBuiltinPromptCommand(
  input: string,
  options: ResolveZCodeBuiltinPromptCommandOptions = {},
): string | undefined {
  return resolveZCodeBuiltinPromptCommandInvocation(input, options)?.prompt;
}

export function resolveZCodeBuiltinPromptCommandInvocation(
  input: string,
  options: ResolveZCodeBuiltinPromptCommandOptions = {},
): ResolvedZCodeBuiltinPromptCommand | undefined {
  const invocation = parseBuiltinPromptCommandInvocation(input);
  if (!invocation) {
    return undefined;
  }

  if (invocation.name === INIT_COMMAND_NAME) {
    const workingDirectory = options.workingDirectory ?? process.cwd();
    return {
      name: INIT_COMMAND_NAME,
      prompt: buildInitAgentsPrompt({
        args: invocation.args,
        targetPath: join(workingDirectory, "AGENTS.md"),
        workingDirectory,
      }),
    };
  }

  if (invocation.name === BUILTIN_WORKFLOW_COMMAND_NAME) {
    if (options.dynamicWorkflowEnabled === false) {
      return undefined;
    }
    return {
      name: BUILTIN_WORKFLOW_COMMAND_NAME,
      prompt: expandBuiltinWorkflowCommandPrompt(invocation.args),
    };
  }

  const nativeAgentCommand =
    ZCODE_NATIVE_AGENT_COMMANDS[invocation.name as keyof typeof ZCODE_NATIVE_AGENT_COMMANDS];
  if (nativeAgentCommand) {
    const task = invocation.args || nativeAgentCommand.defaultTask;
    const lines = [
      `You are handling the built-in /${invocation.name} command in ZCode.`,
      `The user's task is: ${task}`,
      "Use the ordinary typed Task tool to dispatch exactly the named profile below. Do not substitute a generic role, and do not claim the agent ran unless the tool result confirms it.",
      `Required exact profile: ${nativeAgentCommand.role}`,
      nativeAgentCommand.instruction,
      "Return the agent's evidence-backed result to the user. Preserve normal tool permissions, cancellation, and session behavior.",
    ];
    if (invocation.name === "evaluate") {
      lines.push(...sharedEvaluationPromptLines(options.evaluationCatalog ?? { status: "absent" }));
      lines.push(
        "Persist each judged shared case by appending one JSON object per line to .zcode/eval-results.jsonl with exactly these fields: case_id, revision (the current git HEAD), result (pass, fail, or not_run), and evidence. Do not write percentages, rates, or scores.",
      );
    }
    return {
      name: invocation.name,
      prompt: lines.join("\n\n"),
    };
  }

  return undefined;
}

function parseSharedEvaluationCase(
  item: unknown,
): { case: SharedEvaluationCase; status: "ready" } | { reason: string; status: "invalid" } {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return { reason: "shape", status: "invalid" };
  }
  const record = item as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "id" && key !== "criterion" && key !== "evidence") {
      return { reason: "shape", status: "invalid" };
    }
  }
  if (typeof record.id !== "string" || !SHARED_EVALUATION_ID.test(record.id)) {
    return { reason: "id", status: "invalid" };
  }
  if (!isSharedEvaluationText(record.criterion)) return { reason: "criterion", status: "invalid" };
  if (record.evidence !== undefined && !isSharedEvaluationText(record.evidence)) {
    return { reason: "evidence", status: "invalid" };
  }
  const criterion = record.criterion.trim();
  const evidence = typeof record.evidence === "string" ? record.evidence.trim() : undefined;
  if (
    SHARED_EVALUATION_SECRET.test(record.id) ||
    SHARED_EVALUATION_SECRET.test(criterion) ||
    (evidence !== undefined && SHARED_EVALUATION_SECRET.test(evidence))
  ) {
    return { reason: "secret", status: "invalid" };
  }
  return {
    case: { criterion, id: record.id, ...(evidence ? { evidence } : {}) },
    status: "ready",
  };
}

function isSharedEvaluationText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= SHARED_EVALUATION_TEXT_LIMIT &&
    !value.includes("\n")
  );
}

function sharedEvaluationPromptLines(catalog: SharedEvaluationCatalog): string[] {
  const owner =
    "Shared evaluation cases have one owner: .zcode/evaluation-cases.json. Individual test files are not the suite.";
  if (catalog.status === "absent") {
    return [
      owner,
      "No shared catalog file is present. Report that the shared suite was not run. Judge only criteria the user stated in this command, each as pass, fail, or not run.",
    ];
  }
  if (catalog.status === "invalid") {
    return [
      owner,
      `The shared catalog is invalid (${catalog.reason}). Do not mark any shared case pass. Report the suite as not run.`,
    ];
  }
  if (catalog.cases.length === 0) {
    return [
      owner,
      "The shared catalog has no cases. Report that the shared suite has nothing to run.",
    ];
  }
  return [
    owner,
    "Report every shared case below. A case is pass only when its evidence was observed in this run. Otherwise mark it fail or not run. Do not add unnamed cases to the suite.",
    ...catalog.cases.map(
      (item) =>
        `- ${item.id}: ${item.criterion}${item.evidence ? ` Evidence hint: ${item.evidence}` : ""}`,
    ),
  ];
}

function parseBuiltinPromptCommandInvocation(input: string): { args: string; name: string } | null {
  const match = BUILTIN_PROMPT_COMMAND_PATTERN.exec(input.trim());
  if (!match?.[1]) {
    return null;
  }
  return {
    args: match[2]?.trim() ?? "",
    name: match[1].toLowerCase(),
  };
}

function buildInitAgentsPrompt(params: {
  args: string;
  targetPath: string;
  workingDirectory: string;
}): string {
  const additionalInstructions = params.args
    ? ["", "Additional user instructions supplied with /init:", "```text", params.args, "```"].join(
        "\n",
      )
    : "";

  return [
    "You are running ZCode's built-in /init command.",
    "",
    "Your task is to create or update a concise workspace instruction file for future ZCode agents.",
    "",
    "Target:",
    `- Workspace directory: ${params.workingDirectory}`,
    `- Instruction file: ${params.targetPath}`,
    `- Existing hidden instruction candidates: ${join(params.workingDirectory, ".zcode", "AGENTS.md")} and ${join(params.workingDirectory, ".agents", "AGENTS.md")}`,
    "- File name must be exactly AGENTS.md.",
    "- This command targets the current workspace only. Do not write ~/.zcode/AGENTS.md.",
    additionalInstructions,
    "",
    "Process:",
    "1. First check whether .zcode/AGENTS.md or .agents/AGENTS.md exists in the workspace. If either exists, tell the user they already have an instructions file, mention the path found, and stop without creating a new AGENTS.md.",
    "2. Inspect the repository before writing. Prefer Read, Glob, Grep, and safe Bash commands such as ls, find, git status, and package-manager script inspection.",
    "3. If AGENTS.md already exists, read it first and update it with Edit instead of replacing it wholesale.",
    "4. If AGENTS.md does not exist, create it at the workspace root.",
    "5. Keep the file practical and short enough for future agents to read quickly.",
    "6. Include only project-specific facts future ZCode agents would otherwise miss.",
    "7. Ask the user only if a repository-specific decision cannot be inferred and would materially change the file.",
    "",
    "Recommended AGENTS.md content:",
    "- Repository purpose and major directories.",
    "- Build, typecheck, lint, and focused test commands discovered from the repo.",
    "- Architecture boundaries and layer rules that matter for edits.",
    "- Coding conventions, import/path rules, logging rules, UI/design rules, and platform compatibility constraints if present.",
    "- Known gotchas for desktop app, web, remote, stdio, protocols, or agent runtime if this repo has them.",
    "- Any documentation files that agents should read before changing sensitive areas.",
    "",
    "After creating or editing AGENTS.md, summarize the main sections you wrote and mention the file path.",
  ].join("\n");
}
