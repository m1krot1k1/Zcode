import type {
  ConversationTelemetryParityOperation,
  ConversationTelemetryParityScenario,
} from "./types.js";

export const seedDetail = {
  askMode: "build",
  modelName: "glm-model",
  modelProvider: "glm",
  providerHostname: "api.example.com",
} as const;

function id(caseId: string, suffix: string): string {
  return `${caseId.toLowerCase()}-${suffix}`;
}

export function successfulTextTurn(input: {
  caseId: string;
  sessionId?: string;
  commandId?: string;
  scope?: string;
  sendAt?: number;
  chunkAt?: number;
  terminalAt?: number;
  includeNetwork?: boolean;
}): ConversationTelemetryParityOperation[] {
  const sessionId = input.sessionId ?? id(input.caseId, "session");
  const commandId = input.commandId ?? id(input.caseId, "command");
  const turnId = id(input.caseId, "turn");
  const sendAt = input.sendAt ?? 100;
  const chunkAt = input.chunkAt ?? 200;
  const terminalAt = input.terminalAt ?? 300;
  const scope = input.scope;
  return [
    {
      kind: "foreground.attach",
      sessionId,
      owner: id(input.caseId, "owner"),
      scope,
    },
    { kind: "focus", now: sendAt - 20, scope },
    { kind: "text", now: sendAt - 10, value: "x", scope },
    { kind: "seed", sessionId, commandId, now: sendAt, ...seedDetail, scope },
    {
      kind: "turn.started",
      now: sendAt + 5,
      eventId: id(input.caseId, "started"),
      sessionId,
      commandId,
      turnId,
      scope,
    },
    ...(input.includeNetwork === false
      ? []
      : ([
          {
            kind: "model.status",
            now: sendAt + 10,
            eventId: id(input.caseId, "request-started"),
            sessionId,
            commandId,
            turnId,
            requestId: id(input.caseId, "request"),
            status: "model_request_started",
            providerId: "glm",
            modelId: "glm-model",
            providerHostname: "api.example.com",
            scope,
          },
        ] satisfies ConversationTelemetryParityOperation[])),
    {
      kind: "chunk",
      now: chunkAt,
      eventId: id(input.caseId, "chunk"),
      sessionId,
      commandId,
      turnId,
      channel: "text",
      firstChunk: true,
      scope,
    },
    {
      kind: "usage",
      now: terminalAt - 10,
      eventId: id(input.caseId, "usage"),
      sessionId,
      commandId,
      turnId,
      inputTokens: 10,
      outputTokens: 5,
      scope,
    },
    ...(input.includeNetwork === false
      ? []
      : ([
          {
            kind: "model.status",
            now: terminalAt - 5,
            eventId: id(input.caseId, "request-completed"),
            sessionId,
            commandId,
            turnId,
            requestId: id(input.caseId, "request"),
            status: "model_request_completed",
            providerId: "glm",
            modelId: "glm-model",
            providerHostname: "api.example.com",
            durationMs: terminalAt - sendAt - 15,
            scope,
          },
        ] satisfies ConversationTelemetryParityOperation[])),
    {
      kind: "terminal",
      now: terminalAt,
      eventId: id(input.caseId, "terminal"),
      sessionId,
      commandId,
      turnId,
      status: "success",
      scope,
    },
  ];
}

export function scenario(
  caseId: string,
  operations: ConversationTelemetryParityOperation[],
  report: Record<string, number>,
  arms: Record<string, number>,
  proof: string[],
): ConversationTelemetryParityScenario {
  return {
    caseId,
    operations,
    minimumReportInventory: report,
    minimumArmsInventory: arms,
    proof,
  };
}
