import { requestSecurityMessagesEnUS } from "@/request-security-edition/messages.js";
import { scenario, successfulTextTurn } from "./helpers.js";
import type {
  ConversationTelemetryParityOperation,
  ConversationTelemetryParityScenario,
} from "./types.js";

export function buildErrorAndIdentityScenarios(): ConversationTelemetryParityScenario[] {
  const tdp14: ConversationTelemetryParityOperation[] = [
    {
      kind: "visible.error",
      errorKey: "tdp14-key-1",
      displayMessage: "Visible provider failure",
      code: "PROVIDER_ERROR",
      traceId: "tdp14-trace-1",
      sessionId: "tdp14-session",
      detail: "bounded detail",
    },
    {
      kind: "visible.error",
      errorKey: "tdp14-key-1",
      displayMessage: "Visible provider failure",
      code: "PROVIDER_ERROR",
      traceId: "tdp14-trace-1",
      sessionId: "tdp14-session",
      duplicate: true,
    },
    {
      kind: "visible.error",
      errorKey: "tdp14-suppressed",
      displayMessage: "Suppressed local error",
      code: "LOCAL_ERROR",
      traceId: "tdp14-trace-suppressed",
      sessionId: "tdp14-session",
      suppressed: true,
    },
    {
      kind: "visible.error",
      errorKey: "tdp14-key-2",
      displayMessage: "Second visible provider failure",
      code: "SECOND_ERROR",
      traceId: "tdp14-trace-2",
      sessionId: "tdp14-session",
    },
  ];

  const tdp15: ConversationTelemetryParityOperation[] = [
    {
      kind: "feedback",
      sessionId: "tdp15-session",
      messageId: "tdp15-assistant",
      reaction: "like",
    },
    {
      kind: "feedback",
      sessionId: "tdp15-session",
      messageId: "tdp15-assistant",
      reaction: "dislike",
    },
    {
      kind: "feedback",
      sessionId: "tdp15-session",
      messageId: "tdp15-assistant",
      reaction: "none",
    },
  ];

  const tdp17: ConversationTelemetryParityOperation[] = [
    {
      kind: "visible.error",
      errorKey: "tdp17-3007",
      displayMessage: requestSecurityMessagesEnUS["zcode.error.providerBusiness.3007"],
      code: "3007",
      traceId: "tdp17-trace",
      sessionId: "tdp17-session",
    },
  ];

  const tdp18 = successfulTextTurn({ caseId: "TDP18", includeNetwork: true });
  const duplicateChunk = tdp18.find(
    (operation): operation is Extract<ConversationTelemetryParityOperation, { kind: "chunk" }> =>
      operation.kind === "chunk",
  );
  const duplicateTerminal = tdp18.find(
    (operation): operation is Extract<ConversationTelemetryParityOperation, { kind: "terminal" }> =>
      operation.kind === "terminal",
  );
  if (duplicateChunk) tdp18.push({ ...duplicateChunk });
  if (duplicateTerminal) tdp18.push({ ...duplicateTerminal, duplicate: true });
  tdp18.push({ kind: "scope.dispose" });

  const tdp19 = [
    ...successfulTextTurn({ caseId: "TDP19A", scope: "identity-a" }),
    ...successfulTextTurn({ caseId: "TDP19B", scope: "identity-b" }),
    { kind: "scope.dispose", scope: "identity-a" },
    {
      kind: "web.noop",
      operations: successfulTextTurn({ caseId: "TDP19WEB", scope: "web" }),
    },
  ] satisfies ConversationTelemetryParityOperation[];

  return [
    scenario("TDP14", tdp14, {}, { chat_error_banner: 2 }, [
      "visible",
      "suppressed-zero",
      "same-key-once",
      "new-key-new-event",
    ]),
    scenario("TDP15", tdp15, { assistant_message_feedback: 3 }, {}, [
      "like",
      "dislike",
      "toggle-none",
      "command-failure-rollback",
      "reopen-persisted",
    ]),
    scenario("TDP16", [{ kind: "quota.assert" }], {}, {}, [
      "quota-banner",
      "dismiss",
      "blocking-and-nonblocking",
      "entitlement-refresh",
      "upgrade-context",
      "purchase-events-pruned",
    ]),
    scenario("TDP17", [{ kind: "verification.assert" }, ...tdp17], {}, { chat_error_banner: 1 }, [
      "visible-3007",
      "exact-zcode-plan-provider",
      "one-shot-header",
      "accepted-duplicate-handled",
      "failure-retryable",
      "non-zcode-plan-skipped",
    ]),
    scenario(
      "TDP18",
      tdp18,
      { send_btn: 1, agent_step: 1, message_completion: 1 },
      {
        plan_request: 2,
        plan_ttft: 1,
        perf_ui_first_token: 1,
        perf_ui_message_complete: 1,
        perf_ui_turn_breakdown: 1,
      },
      ["duplicate-live-once", "initial-hydration-recovery-zero", "reload-zero-replay"],
    ),
    scenario(
      "TDP19",
      tdp19,
      { send_btn: 2, agent_step: 2, message_completion: 2 },
      {
        plan_request: 4,
        plan_ttft: 2,
        perf_ui_first_token: 2,
        perf_ui_message_complete: 2,
        perf_ui_turn_breakdown: 2,
      },
      ["workspace-identity-isolated", "remote-session-isolated", "generation-disposed", "web-noop"],
    ),
  ];
}
