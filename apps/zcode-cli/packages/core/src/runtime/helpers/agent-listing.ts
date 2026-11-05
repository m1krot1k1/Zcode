import { createMessageId, type TraceContext } from "@zcode/contracts";
import type { RuntimeAttachmentEntry, RuntimeMessageEntry } from "../../agent/message-history.js";
import { collectAgentListingAttachment } from "../../subagent/listing.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { resolveRuntimeEmbeddedSearchEnabled } from "../methods/embedded-search-branch.js";
import { commitTurnRequestEntries } from "../methods/turn-output-token-continuation.js";
import type { TurnRequestState } from "../methods/turn-loop-state.js";

export function collectRuntimeAgentListing(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
  tools: readonly { name: string }[],
): RuntimeAttachmentEntry | undefined {
  // Причина бага: каталог профилей читался до проверки toolset и мог сорвать обычный turn,
  // когда Agent/Task выключен или запрещён. В этом случае listing не нужен вовсе.
  if (!tools.some((tool) => tool.name === "Agent" || tool.name === "Task")) return undefined;
  // Router (start/orchestrator) не использует worker-tools сам, но может делегировать
  // их named worker'у. Каталог должен показывать фактическую delegation-capability, иначе
  // start видит coder без Write/Bash и ошибочно считает запись недоступной.
  const delegationToolNames = runtime.config.delegationToolAllowlist;
  const listingTools = delegationToolNames?.length
    ? [...tools, ...delegationToolNames.map((name) => ({ name }))]
    : tools;
  return collectAgentListingAttachment({
    definitions: runtime.getAgentDefinitions(),
    entries,
    tools: listingTools,
    embeddedSearchEnabled: resolveRuntimeEmbeddedSearchEnabled(runtime),
  });
}

export async function appendRuntimeAgentListing(
  runtime: AgentRuntimeInternal,
  state: TurnRequestState,
  tools: readonly { name: string }[],
  traceContext: TraceContext,
): Promise<void> {
  const entry = collectRuntimeAgentListing(runtime, state.entries, tools);
  if (!entry) return;
  // 持久化成功后才提交到权威历史，失败不能让后续请求误判为已通知。
  await runtime.persistSyntheticUserNoticeForSession({
    messageID: createMessageId(),
    sessionId: runtime.sessionId,
    source: "agent_listing_delta",
    text: entry.content,
    metadata: { runtimeMessage: entry.metadata },
    traceContext,
  });
  commitTurnRequestEntries(runtime, state, [entry]);
}
