import { basename } from "node:path";
import { EXPLORE_AGENT_TYPE } from "./explore.js";
import { formatExploreAllowedToolsForAgentDescription } from "./explore-tools.js";
import { filterSubagentChildToolNames } from "./tool-policy.js";
import { AgentErrorCode, CoreErrorType, createCoreError } from "@zcode/contracts";
import type { ModelSelection, AgentProfile } from "@zcode/shared";
export { parseAgentProfileFromMarkdown } from "@zcode/shared";
export type {
  AgentProfile,
  AgentPermissionMode,
  AgentProfileSource,
  AgentMemoryScope,
  AgentProfileParseDiagnostic,
  AgentProfileLoadResult,
} from "@zcode/shared";

// 16 канонических ролей. Порядок совпадает с BUILT_IN_SWARM_PROFILES и является
// контрактом каталога: planner, admission и prompt-каталог читают один и тот же список.
import {
  BUILT_IN_SWARM_PROFILES,
  RESERVED_GENERIC_AGENT_NAMES,
} from "./built-in-profiles.js";

export {
  BUILT_IN_SWARM_PROFILES,
  SWARM_AGENT_TYPES,
  ROUTER_DELEGATION_TOOL_NAMES,
  INSPECTION_SUBAGENT_TOOL_NAMES,
  REVIEW_SUBAGENT_TOOL_NAMES,
  WORKER_SUBAGENT_TOOL_NAMES,
  ROOT_ONLY_TOOL_NAMES,
} from "./built-in-profiles.js";

export type DelegationRoute =
  | "answer_directly"
  | "delegate_single"
  | "orchestrate"
  | "integrate_inline";

export interface DelegationEnvelope {
  role: "start" | "orchestrator" | "root";
  socialOnly?: boolean;
  independentWorkstreams?: number;
  serialDependencies?: boolean;
  integrationOwnedByCaller?: boolean;
  /** Optional explicit user concurrency preference; otherwise host capacity is used. */
  userMaxParallel?: number;
  /** Read-only triage may stay with the caller; implementation still delegates. */
  readOnly?: boolean;
}

export interface DelegationDecision {
  route: DelegationRoute;
  reason: string;
  maxParallel: number;
}

/** Pure routing gate used by prompts and tests; it never performs work itself. */
export function decideDelegationRoute(envelope: DelegationEnvelope): DelegationDecision {
  if (envelope.socialOnly === true) {
    return { route: "answer_directly", reason: "social-only request", maxParallel: 0 };
  }

  if (envelope.readOnly === true) {
    return {
      route: "integrate_inline",
      reason: "read-only triage stays with the caller",
      maxParallel: 0,
    };
  }

  const workstreams = Math.max(1, envelope.independentWorkstreams ?? 1);
  const userMaxParallel = Math.max(1, envelope.userMaxParallel ?? workstreams);
  const maxParallel = Math.max(1, Math.min(workstreams, userMaxParallel));
  if (workstreams >= 2 && maxParallel >= 2) {
    return {
      route: "orchestrate",
      reason: "multiple independent workstreams",
      maxParallel,
    };
  }

  if (envelope.role === "start" || envelope.role === "orchestrator") {
    return {
      route: "delegate_single",
      reason: `${envelope.role} never implements directly`,
      maxParallel: 1,
    };
  }

  if (envelope.serialDependencies === true || envelope.integrationOwnedByCaller === true) {
    return {
      route: "integrate_inline",
      reason: "serial or caller-owned integration",
      maxParallel: 0,
    };
  }

  return { route: "delegate_single", reason: "single bounded task", maxParallel: 1 };
}

export interface SwarmParallelismInput {
  nodeCount: number;
  requestedMaxParallel?: number;
  userMaxParallel?: number;
}

export interface SwarmParallelismDecision {
  route: DelegationRoute;
  maxParallel: number;
  reason: string;
}

/**
 * Runtime wiring for the routing gate: DAG width is clamped by requested parallelism;
 * the registry applies the actual active-slot capacity immediately before admission.
 */
export function resolveSwarmParallelism(
  input: SwarmParallelismInput,
): SwarmParallelismDecision {
  return decideDelegationRoute({
    role: "orchestrator",
    independentWorkstreams: Math.max(1, input.nodeCount),
    // The registry applies the actual per-run capacity immediately before admission.
    userMaxParallel: input.userMaxParallel ?? input.requestedMaxParallel,
  });
}

const BUILT_IN_AGENT_NAME_SET = new Set(
  BUILT_IN_SWARM_PROFILES.map((profile) => profile.name.toLocaleLowerCase("en-US")),
);

function isBuiltInAgentName(name: string): boolean {
  return BUILT_IN_AGENT_NAME_SET.has(name.trim().toLocaleLowerCase("en-US"));
}

/** Read-only router roles may delegate worker capabilities without using them directly. */
export function isDelegationRouterAgentType(agentType: string): boolean {
  return agentType === "start" || agentType === "orchestrator";
}

function normalizeAgentTypeName(agentType: string | null | undefined): string {
  return agentType?.trim().toLocaleLowerCase("en-US") ?? "";
}

const ROOT_CALLER_AGENT_TYPES = new Set(["", "main", "root", "zcode", "zcode-agent"]);
/** Researcher is a leaf: it must not appear in its own delegation catalog. */
const RESEARCH_LEAF_CALLER_ROLE_NAME = "researcher";
const INSPECTION_CALLER_ROLE_NAMES = new Set([
  "reviewer",
  "security-reviewer",
  "evaluator",
]);

function isSubagentCaller(caller: string): boolean {
  return caller.length > 0 && !ROOT_CALLER_AGENT_TYPES.has(caller);
}

/**
 * Admission predicate shared by the Agent/Task handler and the catalog filter.
 * start -> any worker or orchestrator, never itself; inspection roles -> researcher only
 * (parallel evidence, no recursive review/writers); other subagent callers -> any role
 * except router roles; root/main (undefined) -> unrestricted.
 */
export function isAgentTypeAllowedForCaller(
  agentType: string,
  callerAgentType?: string | null,
): boolean {
  const caller = normalizeAgentTypeName(callerAgentType);
  if (caller === "start") {
    // Fast path: a single bounded task may go straight to a matching worker.
    // Orchestrator remains available for real fan-out/planning.
    return normalizeAgentTypeName(agentType) !== "start";
  }
  if (caller === RESEARCH_LEAF_CALLER_ROLE_NAME) {
    return false;
  }
  if (INSPECTION_CALLER_ROLE_NAMES.has(caller)) {
    return normalizeAgentTypeName(agentType) === "researcher";
  }
  if (isSubagentCaller(caller)) {
    return !isDelegationRouterAgentType(normalizeAgentTypeName(agentType));
  }
  return true;
}

/**
 * Single caller-scoped catalog filter. collectRuntimeAgentListing and
 * getAvailableAgentTypes both call it, so the visible catalog and admission cannot drift.
 */
export function filterAgentTypesForCaller<T extends Pick<AgentProfile, "name" | "source">>(
  profiles: readonly T[],
  callerAgentType?: string | null,
): T[] {
  const caller = normalizeAgentTypeName(callerAgentType);
  if (caller === "start") {
    return profiles.filter((profile) => isAgentTypeAllowedForCaller(profile.name, caller));
  }
  if (caller === RESEARCH_LEAF_CALLER_ROLE_NAME) {
    return [];
  }
  if (INSPECTION_CALLER_ROLE_NAMES.has(caller)) {
    return profiles.filter(
      (profile) =>
        isModelSelectableAgentProfile(profile) &&
        normalizeAgentTypeName(profile.name) === "researcher",
    );
  }
  if (isSubagentCaller(caller)) {
    return profiles.filter(
      (profile) =>
        isModelSelectableAgentProfile(profile) && isAgentTypeAllowedForCaller(profile.name, caller),
    );
  }
  return [...profiles];
}

/** Mirrors the subagent runner's normalization so catalog admission keeps fuzzy names. */
export function normalizeAgentTypeForMatch(agentType: string): string | undefined {
  const normalized = agentType
    .trim()
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{White_Space}\p{Pd}_]+/gu, "");
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * exact/normalized/ambiguous are resolvable by the runner's profile resolver;
 * none must be rejected by the handler before a child runtime is spawned.
 */
export type AgentTypeCatalogMatch = "exact" | "normalized" | "ambiguous" | "none";

export function matchAgentTypeInCatalog(
  agentType: string,
  availableAgentTypes: readonly string[],
): AgentTypeCatalogMatch {
  if (availableAgentTypes.includes(agentType)) return "exact";
  const normalized = normalizeAgentTypeForMatch(agentType);
  if (!normalized) return "none";
  const matches = availableAgentTypes.filter(
    (name) => normalizeAgentTypeForMatch(name) === normalized,
  );
  if (matches.length === 1) return "normalized";
  return matches.length > 1 ? "ambiguous" : "none";
}

// general-purpose оставлен только для чтения старых пользовательских настроек; runtime больше
// не создаёт эту роль и не выбирает её модель. Новые встроенные роли наследуют модель сессии.
/**
 * Переопределение модели встроенных ролей.
 *
 * start/orchestrator только маршрутизируют и не требуют тяжёлой модели: если Host
 * настроил для них более дешёвую/быструю модель, она применяется как профильная.
 * Без override роли наследуют модель сессии, как раньше.
 */
export type BuiltInSubagentModelSelectionOverrides = Partial<
  Record<"general-purpose" | typeof EXPLORE_AGENT_TYPE | "start" | "orchestrator", ModelSelection>
>;

export function createBuiltInExploreAgentProfile(
  options: { modelSelection?: ModelSelection } = {},
): AgentProfile {
  return {
    name: EXPLORE_AGENT_TYPE,
    description:
      'Read-only search agent for broad fan-out searches - when answering means sweeping many files, directories, or naming conventions and you only need the conclusion, not the file dumps. It reads excerpts rather than whole files, so it locates code; it doesn\'t review or audit it. Specify search breadth: "medium" for moderate exploration, "very thorough" for multiple locations and naming conventions.',
    color: "cyan",
    injectAgentsMd: true,
    ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
    source: "built-in",
    systemPrompt: "",
    tools: ["Bash", "Glob", "Grep", "Read", "WebFetch", "WebSearch", "TodoWrite"],
  };
}

export function getSwarmAgentProfiles(profiles: readonly AgentProfile[]): AgentProfile[] {
  const activeModelSelections = new Map(
    profiles
      .filter((profile) => profile.source === "built-in")
      .map((profile) => [profile.name, profile.modelSelection] as const),
  );

  // Планировщику и admission нужен один стабильный каталог; custom-профиль не
  // может добавить generic-роль или подменить системный prompt/tools/skills.
  const builtIns = BUILT_IN_SWARM_PROFILES.map((profile) => {
    const modelSelection = activeModelSelections.get(profile.name);
    return modelSelection ? { ...profile, modelSelection } : profile;
  });
  const builtInNames = new Set(builtIns.map((profile) => profile.name.toLocaleLowerCase("en-US")));
  const seenCustomNames = new Set(builtInNames);
  const swarmCustomProfiles = profiles.filter((profile) => {
    const normalizedName = profile.name.trim().toLocaleLowerCase("en-US");
    const normalizedTools = profile.tools?.map((tool) => tool.trim());
    const eligible = (
      profile.source !== "built-in" &&
      profile.includeInSwarm === true &&
      isModelSelectableAgentProfile(profile) &&
      !seenCustomNames.has(normalizedName) &&
      Boolean(normalizedTools?.length) &&
      !normalizedTools?.includes("*")
    );
    if (eligible) seenCustomNames.add(normalizedName);
    return eligible;
  });

  return [...builtIns, ...swarmCustomProfiles];
}

export function isBuiltInExploreAgentProfile(
  profile: Pick<AgentProfile, "name" | "source">,
): boolean {
  // 用户/项目 profile 可以同名覆盖内置 Explore，不能只按名称套用内置行为。
  return profile.name === EXPLORE_AGENT_TYPE && profile.source === "built-in";
}

/** 内部兼容角色不应成为模型可见的默认委派选项；同名的用户角色仍然有效。 */
export function isModelSelectableAgentProfile(
  profile: Pick<AgentProfile, "name" | "source">,
): boolean {
  const name = profile.name.trim().toLocaleLowerCase("en-US");
  return !(
    RESERVED_GENERIC_AGENT_NAMES.has(name) ||
    (profile.source === "built-in" && profile.name === EXPLORE_AGENT_TYPE)
  );
}

export function normalizeAgentProfiles(
  profiles: readonly AgentProfile[],
  options: {
    builtInModelSelectionOverrides?: BuiltInSubagentModelSelectionOverrides;
  } = {},
): AgentProfile[] {
  const overrides = options.builtInModelSelectionOverrides ?? {};
  const active = new Map<string, AgentProfile>();
  active.set(
    EXPLORE_AGENT_TYPE,
    createBuiltInExploreAgentProfile({
      modelSelection: overrides[EXPLORE_AGENT_TYPE],
    }),
  );
  for (const profile of BUILT_IN_SWARM_PROFILES) {
    const routerOverride = overrides[profile.name as keyof typeof overrides];
    active.set(
      profile.name,
      routerOverride ? { ...profile, modelSelection: routerOverride } : { ...profile },
    );
  }
  for (const profile of profiles) {
    // Не принимаем compatibility/general роли ни из workspace, ни из plugin snapshot:
    // такие типы отсутствуют в ZCode roster и ломают делегирование на следующем уровне.
    if (RESERVED_GENERIC_AGENT_NAMES.has(profile.name.trim().toLocaleLowerCase("en-US"))) continue;
    // Встроенная роль не может быть подменена custom-профилем: имя, prompt и tools
    // остаются контрактом ZCode, а не входными данными workspace или плагина.
    if (isBuiltInAgentName(profile.name)) continue;
    active.set(profile.name, profile);
  }
  return Array.from(active.values());
}

export interface AgentProfilePromptOptions {
  embeddedSearchEnabled?: boolean;
  /** Actual provider-visible tool names; when present, the catalog is filtered to them. */
  availableToolNames?: readonly string[];
  /** Keep the main-turn catalog to one short line per role instead of full tool lists. */
  compact?: boolean;
}

export function formatAgentProfilesForPrompt(
  profiles: readonly AgentProfile[],
  options: AgentProfilePromptOptions = {},
): string | null {
  // Внутренняя роль Explore остаётся совместимой для старых сессий, но не предлагается модели как ZCode-роль.
  const active = normalizeAgentProfiles(profiles).filter(isModelSelectableAgentProfile);
  if (active.length === 0) return null;

  return [
    "Available agent types and the tools they have access to:",
    ...active.map((profile) => formatAgentProfileForPrompt(profile, options)),
  ].join("\n");
}

export function formatAgentProfileForPrompt(
  profile: Readonly<AgentProfile>,
  options: AgentProfilePromptOptions = {},
): string {
  const tools = isBuiltInExploreAgentProfile(profile)
    ? formatExploreAllowedToolsForAgentDescription(options)
    : profile.tools
      ? filterSubagentChildToolNames(profile.tools, profile.disallowedTools)
      : undefined;
  const availableToolNames = options.availableToolNames
    ? new Set(options.availableToolNames)
    : undefined;
  const listedTools = Array.isArray(tools)
    ? [...tools].filter((toolName) => !availableToolNames || availableToolNames.has(toolName))
    : undefined;
  if (
    listedTools &&
    profile.skills?.length &&
    !profile.disallowedTools?.includes("Skill") &&
    (!availableToolNames || availableToolNames.has("Skill")) &&
    !listedTools.includes("Skill")
  ) {
    listedTools.push("Skill");
  }
  const description =
    options.compact && profile.description.length > 140
      ? `${profile.description.slice(0, 137)}...`
      : profile.description;
  let toolText = typeof tools === "string" ? tools : listedTools?.join(", ");
  if (options.compact && listedTools && listedTools.length > 6) {
    // Routers need to know that Skill is available even when it sorts after the
    // worker set; keep it in the visible prefix and report the omitted tail.
    const ordered = listedTools.includes("Skill")
      ? ["Skill", ...listedTools.filter((toolName) => toolName !== "Skill")]
      : listedTools;
    const visible = ordered.slice(0, 6);
    const omitted = ordered.length - visible.length;
    toolText = `${visible.join(", ")}${omitted > 0 ? ` +${omitted} more` : ""}`;
  }
  return `- ${profile.name}: ${description}${toolText ? ` (Tools: ${toolText})` : ""}`;
}

export function agentProfileDisplayName(profile: AgentProfile): string {
  return profile.path ? `${profile.name} (${basename(profile.path)})` : profile.name;
}

export interface AgentBackgroundPolicyInput {
  agentType: string;
  callerAgentType?: string;
  requestedBackground?: boolean;
  hasTaskGraph: boolean;
  parallelAgentBatchSize?: number;
  toolCallId?: string;
}

export interface AgentBackgroundPolicy {
  runInBackground: boolean;
  allowBackground: boolean;
}

/**
 * turn-scoped caller закрывает runtime сразу после ответа, поэтому его ребёнок должен
 * быть доставлен в этом же turn. Root/main сохраняет async-поведение для batch > 1.
 */
export function resolveAgentBackgroundPolicy(
  input: AgentBackgroundPolicyInput,
): AgentBackgroundPolicy {
  const turnScoped = input.callerAgentType !== undefined;
  if (turnScoped && input.requestedBackground === true) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      `Agent/Task called from ${input.callerAgentType} cannot run in the background because this turn ends with the report. Remove run_in_background:true; nested Agent/Task calls run in the foreground and return their results before the turn ends.`,
      {
        context: {
          code: AgentErrorCode.BACKGROUND_UNAVAILABLE,
          agentType: input.agentType,
          callerAgentType: input.callerAgentType,
          toolCallId: input.toolCallId,
          toolName: "Agent",
        },
        recoverable: true,
      },
    );
  }

  return {
    runInBackground:
      input.requestedBackground ??
      (!turnScoped && !input.hasTaskGraph && (input.parallelAgentBatchSize ?? 0) > 1),
    allowBackground: !turnScoped,
  };
}
