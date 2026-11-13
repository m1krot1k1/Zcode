import { scenario } from "./helpers.js";
import type {
  ConversationTelemetryParityOperation,
  ConversationTelemetryParityScenario,
  ParityModelStatus,
} from "./types.js";

export function buildContextAndNetworkScenarios(): ConversationTelemetryParityScenario[] {
  const tdp11: ConversationTelemetryParityOperation[] = [
    ...["completed", "failed", "interrupted"].map(
      (status) =>
        ({
          kind: "foreground.attach",
          sessionId: `tdp11-${status}-session`,
          owner: `tdp11-${status}-owner`,
        }) satisfies ConversationTelemetryParityOperation,
    ),
    ...["completed", "failed", "interrupted"].map(
      (status, index) =>
        ({
          kind: "compaction",
          now: 200 + index * 100,
          eventId: `tdp11-${status}`,
          sessionId: `tdp11-${status}-session`,
          operationId: `tdp11-${status}-operation`,
          summaryMessageId: `tdp11-${status}-summary`,
          status: status as "completed" | "failed" | "interrupted",
          trigger: index === 0 ? "manual" : "auto",
          reason: index === 0 ? "manual request" : undefined,
          compactReason: index === 1 ? "context_limit" : undefined,
          modelName: index === 2 ? "glm-model" : "external-model",
          modelProvider: index === 2 ? "glm" : "anthropic",
          startedAt: 100,
          endedAt: 150 + index * 10,
          preCompactTokenCount: 100,
          postCompactTokenCount: 40,
          truePostCompactTokenCount: 35,
        }) satisfies ConversationTelemetryParityOperation,
    ),
    {
      kind: "compaction",
      now: 600,
      eventId: "tdp11-duplicate",
      sessionId: "tdp11-completed-session",
      operationId: "tdp11-completed-operation",
      status: "failed",
      trigger: "manual",
      duplicate: true,
    },
    {
      kind: "compaction",
      now: 700,
      eventId: "tdp11-background",
      sessionId: "tdp11-background-session",
      operationId: "tdp11-background-operation",
      status: "completed",
      trigger: "auto",
      modelName: "glm-model",
      modelProvider: "glm",
    },
  ];

  const tdp12 = [
    "model_request_started",
    "model_request_completed",
    "model_request_failed",
    "model_retry_scheduled",
    "model_stream_stalled",
  ].flatMap((status, index) =>
    ["foreground", "background"].map(
      (visibility, visibilityIndex) =>
        ({
          kind: "model.status",
          now: 100 + index * 20 + visibilityIndex,
          eventId: `tdp12-${status}-${visibility}`,
          sessionId: `tdp12-${visibility}-session`,
          requestId: `tdp12-request-${visibility}`,
          status: status as ParityModelStatus,
          providerId: "custom-provider",
          modelId: "custom-model",
          providerHostname: "safe.example.com",
          durationMs: status === "model_request_started" ? undefined : 20 + index,
          reason: status === "model_request_failed" ? "failed" : undefined,
          retryable: status === "model_retry_scheduled" ? true : undefined,
          delayMs: status === "model_retry_scheduled" ? 500 : undefined,
          idleMs: status === "model_stream_stalled" ? 3_001 : undefined,
          timeoutMs: status === "model_stream_stalled" ? 3_000 : undefined,
        }) satisfies ConversationTelemetryParityOperation,
    ),
  );

  const tdp13: ConversationTelemetryParityOperation[] = [];
  const ttftVariants = [
    {
      name: "valid",
      sendAt: 100,
      chunkAt: 180,
      provider: "glm",
      foreground: true,
    },
    {
      name: "negative",
      sendAt: 400,
      chunkAt: 350,
      provider: "glm",
      foreground: true,
    },
    {
      name: "missing",
      sendAt: 700,
      chunkAt: 780,
      provider: "",
      foreground: true,
    },
    {
      name: "background",
      sendAt: 1_000,
      chunkAt: 1_080,
      provider: "glm",
      foreground: false,
    },
  ];
  ttftVariants.forEach((variant) => {
    const sessionId = `tdp13-${variant.name}-session`;
    const commandId = `tdp13-${variant.name}-command`;
    const turnId = `tdp13-${variant.name}-turn`;
    if (variant.foreground) {
      tdp13.push({
        kind: "foreground.attach",
        sessionId,
        owner: `tdp13-${variant.name}-owner`,
      });
    }
    tdp13.push(
      {
        kind: "seed",
        sessionId,
        commandId,
        now: variant.sendAt,
        askMode: "build",
        modelName: "glm-model",
        modelProvider: variant.provider,
      },
      {
        kind: "turn.started",
        now: variant.sendAt + 1,
        eventId: `tdp13-${variant.name}-start`,
        sessionId,
        commandId,
        turnId,
      },
      {
        kind: "chunk",
        now: variant.chunkAt,
        eventId: `tdp13-${variant.name}-chunk`,
        sessionId,
        commandId,
        turnId,
        channel: "text",
        firstChunk: true,
      },
      {
        kind: "terminal",
        now: variant.sendAt + 200,
        eventId: `tdp13-${variant.name}-terminal`,
        sessionId,
        commandId,
        turnId,
        status: "success",
      },
    );
  });

  return [
    scenario("TDP11", tdp11, { context_compaction: 3 }, {}, [
      "three-terminal-statuses",
      "nonterminal-zero",
      "duplicate-operation-zero",
      "background-zero",
      "legacy-model-encoding",
    ]),
    scenario("TDP12", tdp12, {}, { plan_request: 10 }, [
      "five-network-statuses",
      "foreground-background",
      "accepted-queued-apiRetry-zero",
      "hostname-only",
    ]),
    scenario(
      "TDP13",
      tdp13,
      { send_btn: 4, agent_step: 4, message_completion: 4 },
      {
        plan_ttft: 1,
        perf_ui_first_token: 3,
        perf_ui_message_complete: 3,
        perf_ui_turn_breakdown: 3,
      },
      ["valid-ttft", "negative-no-plan-ttft", "missing-provider-no-plan-ttft", "background-zero"],
    ),
  ];
}
