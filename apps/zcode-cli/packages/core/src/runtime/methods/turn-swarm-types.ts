import type { SessionId, SubagentTaskSnapshot, SwarmRunStatus } from "@zcode/contracts";
import type { TurnId } from "../deps.js";

export const SWARM_PLAN_MAX_OUTPUT_TOKENS = 4_096;
// Planner не получает собственный тайм-бюджет: запрос идёт до ответа модели,
// отмены пользователем или ошибки провайдера. Повторяются только transient-сбои.
export const SWARM_PLAN_MAX_ATTEMPTS = 2;
export const SWARM_PLAN_RETRY_BACKOFF_MS = 500;
export const SWARM_CHILD_RESULT_MAX_BYTES = 48 * 1024;
export const MAX_RECURSIVE_TASK_CAPABILITY_PROBE_DEPTH = 100;

export class SwarmPlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwarmPlanValidationError";
  }
}

export type SwarmOrchestratorFallbackOutcome =
  | { status: "completed" }
  | { status: "unavailable" | "failed"; reason: string };

export interface SwarmRunPolicy {
  rootRunId: string;
  rootTurnId: TurnId;
  showPlanningStatus: boolean;
}

export interface SwarmDurableRun {
  rootSessionID: SessionId;
  revision: number;
  ownerEpoch: number;
  status: SwarmRunStatus;
}

export function getSwarmChildSessionIds(snapshots: SubagentTaskSnapshot[]): string[] {
  return [
    ...new Set(
      snapshots.flatMap((snapshot) =>
        typeof snapshot.childSessionId === "string" ? [snapshot.childSessionId] : [],
      ),
    ),
  ];
}

export function getSwarmChildAgentTypes(snapshots: SubagentTaskSnapshot[]): Record<string, string> {
  return Object.fromEntries(
    snapshots.flatMap((snapshot) =>
      typeof snapshot.childSessionId === "string" &&
      typeof snapshot.agentType === "string" &&
      snapshot.agentType.trim()
        ? [[snapshot.childSessionId, snapshot.agentType.trim().slice(0, 80)]]
        : [],
    ),
  );
}

export function buildSwarmChildFailureSummary(snapshots: SubagentTaskSnapshot[]): string {
  const failed = snapshots.filter((snapshot) => snapshot.status !== "completed");
  if (failed.length === 0) {
    return "Одна или несколько задач роя завершились ошибкой; дочерняя причина недоступна в реестре задач.";
  }
  const lines = failed.slice(0, 4).map((snapshot) => {
    const reason = snapshot.error
      ?.replace(/\p{Cc}/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    return `${snapshot.status} ${truncateUtf8(snapshot.agentId || snapshot.taskId, 48)}: ${truncateUtf8(reason || "причина не сохранена", 140)}`;
  });
  const remaining = failed.length - lines.length;
  return truncateUtf8(
    `Сбой дочерних задач: ${lines.join("; ")}${remaining > 0 ? `; ещё ${remaining}` : ""}`,
    420,
  );
}

export function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let result = "";
  for (const char of value) {
    if (encoder.encode(result + char).byteLength > maxBytes - 32) break;
    result += char;
  }
  return `${result}\n[результат сокращён по лимиту размера]`;
}

export function escapeSwarmXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
