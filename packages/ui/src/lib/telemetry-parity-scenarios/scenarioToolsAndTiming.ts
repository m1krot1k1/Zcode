import { scenario, seedDetail, successfulTextTurn } from "./helpers.js";
import type {
  ConversationTelemetryParityOperation,
  ConversationTelemetryParityScenario,
} from "./types.js";

export function buildToolAndTimingScenarios(): ConversationTelemetryParityScenario[] {
  const tdp08: ConversationTelemetryParityOperation[] = [];
  const toolVariants = ["success", "failed", "permission", "parented"] as const;
  toolVariants.forEach((variant, index) => {
    const sessionId = `tdp08-${variant}-session`;
    const commandId = `tdp08-${variant}-command`;
    const turnId = `tdp08-${variant}-turn`;
    const base = 100 + index * 500;
    tdp08.push(
      { kind: "foreground.attach", sessionId, owner: `tdp08-${variant}-owner` },
      { kind: "seed", sessionId, commandId, now: base, ...seedDetail },
      {
        kind: "turn.started",
        now: base + 10,
        eventId: `tdp08-${variant}-start`,
        sessionId,
        commandId,
        turnId,
      },
    );
    if (variant === "parented") {
      tdp08.push(
        {
          kind: "chunk",
          now: base + 30,
          eventId: "tdp08-parented-thought",
          sessionId,
          commandId,
          turnId,
          channel: "thought",
          firstChunk: true,
          parentToolCallId: "parent-agent",
        },
        {
          kind: "chunk",
          now: base + 40,
          eventId: "tdp08-parented-text",
          sessionId,
          commandId,
          turnId,
          channel: "text",
          firstChunk: false,
          parentToolCallId: "parent-agent",
        },
        {
          kind: "chunk",
          now: base + 60,
          eventId: "tdp08-main-text",
          sessionId,
          commandId,
          turnId,
          channel: "text",
          firstChunk: false,
        },
      );
    } else {
      if (variant === "permission") {
        tdp08.push({
          kind: "permission",
          now: base + 20,
          eventId: "tdp08-permission-request",
          sessionId,
          commandId,
          turnId,
          phase: "requested",
          requestId: "tdp08-permission",
          toolCallId: "tdp08-permission-tool",
        });
      }
      tdp08.push(
        {
          kind: "tool",
          now: base + 30,
          eventId: `tdp08-${variant}-tool-start`,
          sessionId,
          commandId,
          turnId,
          phase: "started",
          toolCallId: `tdp08-${variant}-tool`,
          toolName: variant === "failed" ? "Bash" : "Read",
        },
        ...(variant === "permission"
          ? ([
              {
                kind: "permission",
                now: base + 80,
                eventId: "tdp08-permission-resolved",
                sessionId,
                commandId,
                turnId,
                phase: "resolved",
                requestId: "tdp08-permission",
                toolCallId: "tdp08-permission-tool",
                decision: "allow",
              },
            ] satisfies ConversationTelemetryParityOperation[])
          : []),
        {
          kind: "tool",
          now: base + 120,
          eventId: `tdp08-${variant}-tool-terminal`,
          sessionId,
          commandId,
          turnId,
          phase: variant === "failed" ? "failed" : "completed",
          toolCallId: `tdp08-${variant}-tool`,
          toolName: variant === "failed" ? "Bash" : "Read",
          errorCode: variant === "failed" ? "TOOL_EXEC_ERROR" : undefined,
          errorMessage: variant === "failed" ? "exit 2" : undefined,
          performance: {
            totalMs: 90,
            permissionWaitMs: variant === "permission" ? 60 : 0,
            commandRunMs: variant === "permission" ? 30 : 90,
            exitCode: variant === "failed" ? 2 : 0,
            timedOut: false,
            outputBytes: 12,
            commandCategory: "read",
            commandHash: "0123456789abcdef",
            workspaceKind: "local",
          },
        },
      );
    }
    tdp08.push({
      kind: "terminal",
      now: base + 200,
      eventId: `tdp08-${variant}-terminal`,
      sessionId,
      commandId,
      turnId,
      status: "success",
    });
  });

  const tdp09 = successfulTextTurn({ caseId: "TDP09", includeNetwork: true });
  const tdp09Terminal = tdp09.findIndex((operation) => operation.kind === "terminal");
  tdp09.splice(tdp09Terminal, 0, {
    kind: "foreground.detach",
    owner: "tdp09-owner",
  });
  tdp09.push({
    kind: "foreground.attach",
    sessionId: "tdp09-session",
    owner: "tdp09-reopen",
  });

  const tdp10: ConversationTelemetryParityOperation[] = [];
  const timingVariants = [
    { name: "negative", sendAt: 200, firstAt: 100, secondAt: undefined },
    { name: "no-token", sendAt: 500, firstAt: undefined, secondAt: undefined },
    { name: "gap-3000", sendAt: 800, firstAt: 900, secondAt: 3_900 },
    { name: "gap-3001", sendAt: 4_200, firstAt: 4_300, secondAt: 7_301 },
    { name: "tool-clear", sendAt: 7_600, firstAt: 7_700, secondAt: 13_000 },
    { name: "split", sendAt: 13_300, firstAt: 13_400, secondAt: undefined },
  ] as const;
  timingVariants.forEach((variant) => {
    const sessionId = `tdp10-${variant.name}-session`;
    const commandId = `tdp10-${variant.name}-command`;
    const turnId = `tdp10-${variant.name}-turn`;
    tdp10.push(
      {
        kind: "foreground.attach",
        sessionId,
        owner: `tdp10-${variant.name}-owner-1`,
      },
      ...(variant.name === "split"
        ? ([
            {
              kind: "foreground.attach",
              sessionId,
              owner: "tdp10-split-owner-2",
            },
          ] satisfies ConversationTelemetryParityOperation[])
        : []),
      {
        kind: "seed",
        sessionId,
        commandId,
        now: variant.sendAt,
        ...seedDetail,
      },
      {
        kind: "turn.started",
        now: variant.sendAt + 1,
        eventId: `tdp10-${variant.name}-start`,
        sessionId,
        commandId,
        turnId,
      },
    );
    if (variant.firstAt !== undefined) {
      tdp10.push({
        kind: "chunk",
        now: variant.firstAt,
        eventId: `tdp10-${variant.name}-chunk-1`,
        sessionId,
        commandId,
        turnId,
        channel: "text",
        firstChunk: true,
      });
    }
    if (variant.name === "tool-clear") {
      tdp10.push(
        {
          kind: "tool",
          now: 11_500,
          eventId: "tdp10-tool-clear-start",
          sessionId,
          commandId,
          turnId,
          phase: "started",
          toolCallId: "tdp10-tool-clear-tool",
          toolName: "Read",
        },
        {
          kind: "tool",
          now: 12_000,
          eventId: "tdp10-tool-clear-complete",
          sessionId,
          commandId,
          turnId,
          phase: "completed",
          toolCallId: "tdp10-tool-clear-tool",
          toolName: "Read",
        },
      );
    }
    if (variant.secondAt !== undefined) {
      tdp10.push({
        kind: "chunk",
        now: variant.secondAt,
        eventId: `tdp10-${variant.name}-chunk-2`,
        sessionId,
        commandId,
        turnId,
        channel: "text",
        firstChunk: false,
      });
    }
    tdp10.push({
      kind: "terminal",
      now: Math.max(
        variant.sendAt + 200,
        (variant.secondAt ?? variant.firstAt ?? variant.sendAt) + 100,
      ),
      eventId: `tdp10-${variant.name}-terminal`,
      sessionId,
      commandId,
      turnId,
      status: "success",
    });
  });

  return [
    scenario(
      "TDP08",
      tdp08,
      { send_btn: 4, agent_step: 5, message_completion: 4 },
      {
        plan_ttft: 4,
        perf_ui_first_token: 4,
        perf_ui_message_complete: 4,
        perf_ui_turn_breakdown: 4,
        perf_ui_tool_call_detail: 3,
      },
      ["tool-success", "tool-failed", "permission-wait", "parented-child"],
    ),
    scenario(
      "TDP09",
      tdp09,
      { send_btn: 1, agent_step: 1, message_completion: 1 },
      { plan_request: 2 },
      ["terminal-after-detach", "reopen-no-replay", "background-ui-arms-zero"],
    ),
    scenario(
      "TDP10",
      tdp10,
      { send_btn: 6, agent_step: 6, message_completion: 6 },
      {
        plan_ttft: 4,
        perf_ui_first_token: 6,
        perf_ui_message_complete: 6,
        perf_ui_turn_breakdown: 6,
        perf_ui_stream_stall: 1,
      },
      [
        "negative-ttft-clamped",
        "no-token",
        "stall-3000-zero",
        "stall-3001-one",
        "tool-clears-stall",
        "split-pane-once",
      ],
    ),
  ];
}
