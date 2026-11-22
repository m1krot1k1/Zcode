/** Конверт spawn и opt-in deadline задачи дочернего агента. */
import { inheritPermissionMode } from "@zcode/contracts";
import type { ExploreSubagentRuntimeRequest } from "../../deps.js";
import type { AgentRuntimeInternal } from "../../internal.js";
import { normalizeAgentTypeForMatch } from "../../../subagent/profile.js";

interface SpawnEnvelopeInput {
  level?: number;
  /** Фактический parallel cap из registry; без него атрибут не печатается. */
  maxParallel?: number;
}

/**
 * Чистый builder конверта spawn. Здесь нет общего счётчика задач; только уровень
 * рекурсии и доступная конкурентная ёмкость.
 */
export function buildSpawnEnvelope(input: SpawnEnvelopeInput): string | undefined {
  const parts = ["<zcode-spawn-envelope", `level="${Math.max(0, Math.floor(input.level ?? 1))}"`];
  if (input.maxParallel !== undefined && Number.isFinite(input.maxParallel)) {
    parts.push(`max_parallel="${Math.max(0, Math.floor(input.maxParallel))}"`);
  }
  parts.push("/>");
  return parts.join(" ");
}

// Deadline включается только явной настройкой subagentTaskTimeoutMinutes. Router-ролям
// добавляется окно на сбор и синтез child results; базовые ролевые константы больше
// не задают неявный таймер, поэтому задача выполняется до собственного завершения.
const SUBAGENT_ROUTER_HANDOFF_MS = 15 * 60_000;

function normalizeRoleName(role: string): string {
  // normalizeAgentTypeForMatch не бросает; пустое имя попадает в нейтральную ветку.
  return normalizeAgentTypeForMatch(role) ?? "";
}

/**
 * Opt-in hard deadline по роли. Без явной настройки (`minimumMinutes <= 0`)
 * возвращает undefined: задача выполняется до завершения, Stop или остановки runtime.
 * Настройка `subagentTaskTimeoutMinutes` задаёт единый минимум для всех ролей; router-ролям
 * добавляется окно на сбор и синтез child results. Резолвер не бросает и не зависит
 * от runtime state, чтобы конфигурация не ломала spawn.
 */
export function resolveSubagentTaskTimeoutMs(
  agentType: string,
  minimumMinutes = 0,
): number | undefined {
  const configuredMinimum =
    Number.isSafeInteger(minimumMinutes) && minimumMinutes > 0 && minimumMinutes <= 180
      ? minimumMinutes * 60_000
      : 0;
  if (configuredMinimum === 0) return undefined;
  const role = normalizeRoleName(agentType);
  const workerDeadline = configuredMinimum;
  if (role === normalizeRoleName("orchestrator")) {
    return workerDeadline + SUBAGENT_ROUTER_HANDOFF_MS;
  }
  if (role === normalizeRoleName("start")) {
    return workerDeadline + SUBAGENT_ROUTER_HANDOFF_MS * 2;
  }
  return workerDeadline;
}

export function resolveSubagentPermissionMode(
  parentMode: AgentRuntimeInternal["config"]["mode"],
  permissionMode: ExploreSubagentRuntimeRequest["permissionMode"],
  builtInExplore: boolean,
): AgentRuntimeInternal["config"]["mode"] {
  switch (permissionMode) {
    case "bypassPermissions":
    case "dontAsk":
      return inheritPermissionMode(parentMode, "yolo");
    case "acceptEdits":
      return "edit";
    case "auto":
      return "auto";
    case "plan":
      return "plan";
    case "default":
    case undefined:
      return inheritPermissionMode(parentMode, builtInExplore ? "yolo" : parentMode);
    default:
      return parentMode;
  }
}

export function traceStringAttribute(
  traceContext: { attributes?: Record<string, string | number | boolean> },
  key: string,
): string | undefined {
  const value = traceContext.attributes?.[key];
  return typeof value === "string" ? value : undefined;
}
