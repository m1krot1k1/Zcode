import type { SessionEntryInfo, SessionId } from "@zcode/contracts";
import { SESSION_ENTRY_PERMISSION_DECISION } from "@zcode/contracts";

/**
 * Долговременная запись решения о разрешении.
 *
 * Причина: решения жили только в памяти/событиях, и после перезапуска нельзя было
 * доказать, кто и по какой причине одобрил действие. Запись append-only, без текста
 * команды, аргументов и путей: только стабильные коды и идентификаторы.
 */
const REASON_CODE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,79}$/iu;
const MAX_TOOL_NAME = 120;

interface PermissionDecisionAuditInput {
  decisionId?: string;
  sessionId: SessionId;
  turnId?: string;
  toolCallId: string;
  toolName: string;
  allowed: boolean;
  modified: boolean;
  reason?: string;
  ruleId?: string;
  traceId: string;
  createdAt?: number;
}

function boundedToken(value: string, limit: number): string {
  return value.trim().slice(0, limit);
}

function toReasonCode(reason: string | undefined): string {
  const candidate = reason?.trim() ?? "";
  return candidate.length > 0 && REASON_CODE_PATTERN.test(candidate)
    ? candidate.slice(0, 80)
    : "unspecified";
}

export function buildPermissionDecisionEntry(
  input: PermissionDecisionAuditInput,
): SessionEntryInfo {
  const createdAt = input.createdAt ?? Date.now();
  const decisionId =
    input.decisionId ??
    `permission-decision:${input.traceId}:${input.toolCallId}:${createdAt.toString(36)}`;
  const decision = input.allowed ? (input.modified ? "modify" : "allow") : "deny";
  return {
    id: decisionId,
    sessionID: input.sessionId,
    type: SESSION_ENTRY_PERMISSION_DECISION,
    time: { created: createdAt, updated: createdAt },
    data: {
      schema: "zcode.permission.decision.v1",
      decisionId,
      sessionId: input.sessionId,
      ...(input.turnId ? { turnId: boundedToken(input.turnId, 120) } : {}),
      toolCallId: boundedToken(input.toolCallId, 120),
      toolName: boundedToken(input.toolName, MAX_TOOL_NAME),
      decision,
      source: "broker",
      reasonCode: toReasonCode(input.reason),
      ...(input.ruleId ? { ruleId: boundedToken(input.ruleId, MAX_TOOL_NAME) } : {}),
      traceId: boundedToken(input.traceId, 120),
      createdAt,
    },
  };
}
