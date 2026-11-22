import { scenario, seedDetail, successfulTextTurn } from "./helpers.js";
import type {
  ConversationTelemetryParityOperation,
  ConversationTelemetryParityScenario,
} from "./types.js";

export function buildTurnScenarios(): ConversationTelemetryParityScenario[] {
  const tdp01 = successfulTextTurn({ caseId: "TDP01" });
  const tdp02 = [
    ...successfulTextTurn({ caseId: "TDP02A", sessionId: "tdp02-session" }),
    ...successfulTextTurn({
      caseId: "TDP02B",
      sessionId: "tdp02-session",
      sendAt: 400,
      chunkAt: 500,
      terminalAt: 600,
    }),
  ];

  const tdp03First = successfulTextTurn({
    caseId: "TDP03A",
    sessionId: "tdp03-session",
    commandId: "tdp03-command-1",
    terminalAt: 500,
  });
  const tdp03Second = successfulTextTurn({
    caseId: "TDP03B",
    sessionId: "tdp03-session",
    commandId: "tdp03-command-2",
    sendAt: 150,
    chunkAt: 600,
    terminalAt: 700,
  });
  // 第二轮 seed 在第一轮 terminal 前接纳；promotion 时重复 seed 必须被去重。
  const tdp03 = [
    ...tdp03First.slice(0, 7),
    ...tdp03Second.slice(0, 4),
    ...tdp03First.slice(7),
    {
      kind: "seed",
      sessionId: "tdp03-session",
      commandId: "tdp03-command-2",
      now: 550,
      duplicate: true,
      ...seedDetail,
    } satisfies ConversationTelemetryParityOperation,
    ...tdp03Second.slice(4),
  ];

  const tdp05: ConversationTelemetryParityOperation[] = [];
  for (const [index, withUsage] of [true, false].entries()) {
    const suffix = String(index + 1);
    const sessionId = `tdp05-session-${suffix}`;
    const commandId = `tdp05-command-${suffix}`;
    const turnId = `tdp05-turn-${suffix}`;
    tdp05.push(
      { kind: "foreground.attach", sessionId, owner: `tdp05-owner-${suffix}` },
      {
        kind: "seed",
        sessionId,
        commandId,
        now: 100 + index * 400,
        ...seedDetail,
      },
      {
        kind: "turn.started",
        now: 110 + index * 400,
        eventId: `tdp05-start-${suffix}`,
        sessionId,
        commandId,
        turnId,
      },
      {
        kind: "model.status",
        now: 120 + index * 400,
        eventId: `tdp05-request-start-${suffix}`,
        sessionId,
        commandId,
        turnId,
        requestId: `tdp05-request-${suffix}`,
        status: "model_request_started",
        providerId: "glm",
        modelId: "glm-model",
      },
      {
        kind: "chunk",
        now: 150 + index * 400,
        eventId: `tdp05-chunk-${suffix}`,
        sessionId,
        commandId,
        turnId,
        channel: "text",
        firstChunk: true,
      },
      ...(withUsage
        ? ([
            {
              kind: "usage",
              now: 170,
              eventId: "tdp05-usage-1",
              sessionId,
              commandId,
              turnId,
              inputTokens: 9,
              outputTokens: 3,
            },
          ] satisfies ConversationTelemetryParityOperation[])
        : []),
      {
        kind: "model.status",
        now: 180 + index * 400,
        eventId: `tdp05-request-fail-${suffix}`,
        sessionId,
        commandId,
        turnId,
        requestId: `tdp05-request-${suffix}`,
        status: "model_request_failed",
        providerId: "glm",
        modelId: "glm-model",
        reason: index === 0 ? "provider failed" : "",
        statusCode: 500,
      },
      {
        kind: "terminal",
        now: 200 + index * 400,
        eventId: `tdp05-terminal-${suffix}`,
        sessionId,
        commandId,
        turnId,
        status: "failed",
        errorCode: index === 0 ? "PROVIDER_ERROR" : undefined,
        errorMessage: index === 0 ? "provider failed" : undefined,
      },
    );
  }

  const tdp06 = [
    ...successfulTextTurn({ caseId: "TDP06A", includeNetwork: false }).map((operation) =>
      operation.kind === "terminal"
        ? {
            ...operation,
            status: "interrupted" as const,
            errorCode: "USER_INTERRUPT",
          }
        : operation,
    ),
    {
      kind: "foreground.attach",
      sessionId: "tdp06-no-terminal",
      owner: "tdp06-owner-2",
    },
    {
      kind: "seed",
      sessionId: "tdp06-no-terminal",
      commandId: "tdp06-no-terminal-command",
      now: 500,
      ...seedDetail,
    },
    {
      kind: "turn.started",
      now: 510,
      eventId: "tdp06-no-terminal-start",
      sessionId: "tdp06-no-terminal",
      commandId: "tdp06-no-terminal-command",
      turnId: "tdp06-no-terminal-turn",
    },
  ] satisfies ConversationTelemetryParityOperation[];

  const tdp07 = successfulTextTurn({ caseId: "TDP07", includeNetwork: false });
  const tdp07ChunkIndex = tdp07.findIndex((operation) => operation.kind === "chunk");
  tdp07.splice(tdp07ChunkIndex, 0, {
    kind: "chunk",
    now: 150,
    eventId: "tdp07-thought",
    sessionId: "tdp07-session",
    commandId: "tdp07-command",
    turnId: "tdp07-turn",
    channel: "thought",
    firstChunk: true,
  });

  return [
    scenario(
      "TDP01",
      tdp01,
      { send_btn: 1, agent_step: 1, message_completion: 1 },
      {
        plan_request: 2,
        plan_ttft: 1,
        perf_ui_first_token: 1,
        perf_ui_message_complete: 1,
        perf_ui_turn_breakdown: 1,
      },
      ["draft-create-ack", "source-command-link"],
    ),
    scenario(
      "TDP02",
      tdp02,
      { send_btn: 2, agent_step: 2, message_completion: 2 },
      {
        plan_request: 4,
        plan_ttft: 2,
        perf_ui_first_token: 2,
        perf_ui_message_complete: 2,
        perf_ui_turn_breakdown: 2,
      },
      ["same-talk-id", "message-scope-reset"],
    ),
    scenario(
      "TDP03",
      tdp03,
      { send_btn: 2, agent_step: 2, message_completion: 2 },
      {
        plan_request: 4,
        plan_ttft: 2,
        perf_ui_first_token: 2,
        perf_ui_message_complete: 2,
        perf_ui_turn_breakdown: 2,
      },
      ["queued-before-first-terminal", "promotion-seed-deduped"],
    ),
    scenario(
      "TDP04",
      successfulTextTurn({ caseId: "TDP04" }),
      { send_btn: 1, agent_step: 1, message_completion: 1 },
      {
        plan_request: 2,
        plan_ttft: 1,
        perf_ui_first_token: 1,
        perf_ui_message_complete: 1,
        perf_ui_turn_breakdown: 1,
      },
      ["success-usage", "runtime-model-hostname"],
    ),
    scenario(
      "TDP05",
      tdp05,
      { send_btn: 2, agent_step: 2, message_completion: 2 },
      {
        plan_request: 4,
        plan_ttft: 2,
        perf_ui_first_token: 2,
        perf_ui_message_complete: 2,
        perf_ui_turn_breakdown: 2,
      },
      ["failed-with-usage", "failed-without-usage"],
    ),
    scenario(
      "TDP06",
      tdp06,
      { send_btn: 2, agent_step: 1, message_completion: 1 },
      {
        plan_ttft: 1,
        perf_ui_first_token: 1,
        perf_ui_message_complete: 1,
        perf_ui_turn_breakdown: 1,
      },
      ["interrupted-terminal", "stop-without-terminal-zero-completion"],
    ),
    scenario(
      "TDP07",
      tdp07,
      { send_btn: 1, agent_step: 2, message_completion: 1 },
      {
        plan_ttft: 1,
        perf_ui_first_token: 1,
        perf_ui_message_complete: 1,
        perf_ui_turn_breakdown: 1,
      },
      ["thought-before-text", "tail-finalize"],
    ),
  ];
}
