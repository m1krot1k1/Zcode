import { modelMessageContentToText, SessionEventType, TurnMachineImpl } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeModelTextResult } from "../types.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { commitTurnRequestEntries } from "./turn-output-token-continuation.js";
import { systemReminderAttachmentEntry } from "../../agent/message-history.js";
import {
  attributeTurnItem,
  buildTakeoverEntry,
  buildTakeoverReminder,
  detectRefusal,
  detectTextRefusal,
  hasRefusalMarker,
  parseTakeoverEntryData,
  runUncensoredTakeover,
  selectContextFragments,
  takeoverAgentId,
  takeoverIdempotencyKey,
  TEXT_REFUSAL_REASON,
  UNCENSORED_TAKEOVER_AGENT_TYPE,
  UNCENSORED_TAKEOVER_ENTRY_TYPE,
  type TakeoverContextFragment,
  type TakeoverTerminal,
  type TakeoverToolResult,
  type UncensoredGeneratePort,
} from "../uncensored-takeover/index.js";

interface CachedOutcome {
  terminal: TakeoverTerminal;
  /** Turn that already received the synthetic reminder for this item. */
  injectedTurnId?: string;
}

// Per-runtime, therefore per-session, guard. It closes the same-process duplicate window;
// the durable session entry closes the restart window. Limitation: a second process sharing
// one session relies on `sessionEntries` being implemented by its SessionStorePort.
const outcomesByRuntime = new WeakMap<object, Map<string, CachedOutcome>>();

function outcomesFor(runtime: AgentRuntimeInternal): Map<string, CachedOutcome> {
  let map = outcomesByRuntime.get(runtime);
  if (!map) {
    map = new Map();
    outcomesByRuntime.set(runtime, map);
  }
  return map;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function collectFragments(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  itemText: string,
): readonly TakeoverContextFragment[] {
  const toolInputs = new Map<string, string>();
  for (const entry of state.turnRequestState.entries) {
    if (entry.kind === "attachment" || entry.message.role !== "assistant") continue;
    for (const call of entry.message.toolCalls ?? []) {
      toolInputs.set(call.id, safeStringify(call.input));
    }
  }
  const results: TakeoverToolResult[] = [];
  state.turnRequestState.currentTurnToolResults.forEach((entry, index) => {
    if (entry.kind === "attachment" || entry.message.role !== "tool") return;
    const toolName = entry.message.toolName;
    if (!toolName) return;
    const readOnly = runtime.registry.get(toolName)?.metadata.readOnly === true;
    const toolCallId = entry.message.toolCallId ?? "";
    const inputText = toolInputs.get(toolCallId);
    results.push({
      toolName,
      toolCallId,
      text: modelMessageContentToText(entry.message.content),
      isError: entry.message.isError === true,
      readOnly,
      index,
      ...(inputText ? { inputText } : {}),
    });
  });
  return selectContextFragments({ itemText, results });
}

async function readDurableOutcome(
  runtime: AgentRuntimeInternal,
  taskId: string,
  key: string,
): Promise<CachedOutcome | undefined> {
  const store = runtime.sessionStore;
  if (!store?.sessionEntries) return undefined;
  try {
    const entries = await store.sessionEntries({
      sessionID: runtime.sessionId,
      type: UNCENSORED_TAKEOVER_ENTRY_TYPE,
    });
    for (const entry of entries) {
      const payload = parseTakeoverEntryData(entry.data);
      if (!payload) continue;
      if (payload.status === "running") continue;
      if (payload.taskId !== taskId) continue;
      if (takeoverIdempotencyKey(payload.taskId, payload.itemText) !== key) continue;
      return {
        terminal: {
          status: payload.status,
          providerId: payload.providerId,
          providerName: payload.providerName,
          modelId: payload.modelId,
          output: payload.output,
          ...(payload.reason ? { reason: payload.reason } : {}),
        },
      };
    }
  } catch (error) {
    runtime.logger?.warn("Uncensored takeover durable lookup failed", {
      module: "core.runtime",
      event: "uncensored_takeover.lookup_failed",
      taskId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
  return undefined;
}

async function persistOutcome(
  runtime: AgentRuntimeInternal,
  input: {
    taskId: string;
    itemIndex: number;
    itemText: string;
    agentId: string;
    terminal: TakeoverTerminal;
    createdAt: number;
    updatedAt: number;
  },
): Promise<void> {
  const store = runtime.sessionStore;
  if (!store?.saveSessionEntry) return;
  const entry = buildTakeoverEntry({
    sessionId: input.taskId,
    taskId: input.taskId,
    itemIndex: input.itemIndex,
    itemText: input.itemText,
    agentId: input.agentId,
    terminal: input.terminal,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });
  try {
    await store.saveSessionEntry({
      id: entry.id,
      sessionID: runtime.sessionId,
      type: entry.type,
      time: entry.time,
      data: entry.data,
    });
  } catch (error) {
    runtime.logger?.warn("Uncensored takeover durable write failed", {
      module: "core.runtime",
      event: "uncensored_takeover.persist_failed",
      taskId: input.taskId,
      itemIndex: input.itemIndex,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Turn-loop gate. Single owner of the takeover decision: events, durable row, idempotency and
 * the continuation reminder all live here; the module only shapes the HTTP request.
 * Returns `true` when the turn must continue with the next model step.
 */
export async function runUncensoredTakeoverGate(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: { querySource: string; result: RuntimeModelTextResult },
): Promise<boolean> {
  if (options.querySource !== "main_turn") return false;
  const takeover = this.config.uncensoredTakeover;
  if (!takeover) return false;
  const providerReason = detectRefusal({
    finishReason: options.result.finishReason,
    rawFinishReason: options.result.rawFinishReason ?? state.lastStepDiagnostics?.rawFinishReason,
  });
  // Cascade layer 2: a normal `stop` with no tool calls can still be a textual refusal.
  // Only the last assistant message is inspected; tool output and clarifying questions are
  // never treated as refusals.
  let lastAssistantText = "";
  let lastAssistantHasToolCalls = false;
  let lastUserText = "";
  for (const entry of state.turnRequestState.entries) {
    if (entry.kind === "attachment") continue;
    if (entry.message.role === "user") {
      lastUserText = modelMessageContentToText(entry.message.content);
      continue;
    }
    if (entry.message.role !== "assistant") continue;
    lastAssistantText = modelMessageContentToText(entry.message.content);
    lastAssistantHasToolCalls = (entry.message.toolCalls?.length ?? 0) > 0;
  }
  const finishIsStop =
    options.result.finishReason === undefined || options.result.finishReason === "stop";
  // The marker is checked on the raw model text: the assistant entry may already be stripped.
  const textReason =
    !providerReason && finishIsStop
      ? hasRefusalMarker(options.result.text) ||
        hasRefusalMarker(lastAssistantText) ||
        detectTextRefusal(lastAssistantText, { hasToolCalls: lastAssistantHasToolCalls })
        ? TEXT_REFUSAL_REASON
        : null
      : null;
  const reason = providerReason ?? textReason;
  if (!reason) return false;
  if (!this.sessionStore?.readTodos) return false;
  let todos;
  try {
    todos = await this.sessionStore.readTodos({ sessionID: this.sessionId });
  } catch (error) {
    this.logger?.warn("Uncensored takeover todo read failed", {
      module: "core.runtime",
      event: "uncensored_takeover.todo_read_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  // The current turn's input is authoritative: the message entries may still describe the
  // previous turn at this point, which routed a stale item to the fallback model (one turn late).
  const currentUserText = state.input.trim().length > 0 ? state.input : lastUserText;
  const item = attributeTurnItem(todos, currentUserText, lastAssistantText);
  if (!item) return false;

  const taskId = String(this.sessionId);
  const key = takeoverIdempotencyKey(taskId, item.itemText);
  const outcomes = outcomesFor(this);
  const cached = outcomes.get(key);
  const existing = cached ?? (await readDurableOutcome(this, taskId, key));

  if (existing) {
    // Duplicate: no second model.refusal, no second spawn/stop, no HTTP. A reminder for an item
    // already injected in this very turn is skipped, so a refusing main model cannot loop.
    if (existing.injectedTurnId === state.turnId) return false;
    const reminder = buildTakeoverReminder({
      itemIndex: item.itemIndex,
      terminal: existing.terminal,
    });
    commitTurnRequestEntries(this, state.turnRequestState, [
      systemReminderAttachmentEntry("uncensored_takeover", reminder),
    ]);
    outcomes.set(key, { terminal: existing.terminal, injectedTurnId: state.turnId });
    state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
    return true;
  }

  const agentId = takeoverAgentId(taskId, item.itemIndex, item.itemText);
  const refusalEvent = this.createEvent(
    SessionEventType.ModelRefusal,
    { taskId, itemIndex: item.itemIndex, itemText: item.itemText, reason },
    state.turnTraceContext,
  );
  await this.appendEvent(refusalEvent, state.turnTraceContext);
  state.events.push(refusalEvent);

  const baseTakeover = {
    taskId,
    itemIndex: item.itemIndex,
    itemText: item.itemText,
    providerId: null,
    providerName: null,
    modelId: null,
    status: "running" as const,
    output: "",
  };
  const spawnedEvent = this.createEvent(
    SessionEventType.SubagentSpawned,
    {
      agentId,
      agentType: UNCENSORED_TAKEOVER_AGENT_TYPE,
      status: "running",
      description: `Uncensored takeover for task item ${item.itemIndex}`,
      takeover: baseTakeover,
    },
    state.turnTraceContext,
  );
  await this.appendEvent(spawnedEvent, state.turnTraceContext);
  state.events.push(spawnedEvent);

  const startedAt = Date.now();
  const workspacePath = this.config.workspacePath?.trim() || this.workingDirectory;
  const workspaceIdentity = this.config.workspaceIdentity;
  // Uses the mirrored normal provider/model — the exact configuration that works in chat.
  const generate: UncensoredGeneratePort = {
    generate: async ({ providerId, modelId, messages, signal }) => {
      const timeout = AbortSignal.timeout(60_000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const result = await this.generateWorkspaceText(
        {
          selection: { providerId, modelId },
          messages: messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          querySource: "uncensored_takeover",
          maxOutputTokens: 4096,
        },
        { abortSignal: combined, traceContext: state.turnTraceContext },
      );
      return { text: result.text, finishReason: result.finishReason };
    },
  };
  const terminal = await runUncensoredTakeover({
    configPort: takeover.configPort,
    workspace: {
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    },
    taskId,
    itemIndex: item.itemIndex,
    itemText: item.itemText,
    fragments: collectFragments(this, state, item.itemText),
    generate,
    ...(takeover.fetch ? { fetch: takeover.fetch } : {}),
    signal: state.turnAbortSignal,
    ...(this.logger ? { logger: this.logger } : {}),
  });
  const updatedAt = Date.now();
  await persistOutcome(this, {
    taskId,
    itemIndex: item.itemIndex,
    itemText: item.itemText,
    agentId,
    terminal,
    createdAt: startedAt,
    updatedAt,
  });

  const stoppedEvent = this.createEvent(
    SessionEventType.SubagentStopped,
    {
      agentId,
      agentType: UNCENSORED_TAKEOVER_AGENT_TYPE,
      status: terminal.status === "done" ? "completed" : "failed",
      description: `Uncensored takeover for task item ${item.itemIndex}`,
      durationMs: updatedAt - startedAt,
      takeover: {
        ...baseTakeover,
        providerId: terminal.providerId,
        providerName: terminal.providerName,
        modelId: terminal.modelId,
        status: terminal.status,
        output: terminal.output,
        ...(terminal.reason ? { reason: terminal.reason } : {}),
      },
    },
    state.turnTraceContext,
  );
  await this.appendEvent(stoppedEvent, state.turnTraceContext);
  state.events.push(stoppedEvent);
  outcomes.set(key, { terminal, injectedTurnId: state.turnId });

  if (state.turnAbortSignal.aborted) return true;
  commitTurnRequestEntries(this, state.turnRequestState, [
    systemReminderAttachmentEntry(
      "uncensored_takeover",
      buildTakeoverReminder({ itemIndex: item.itemIndex, terminal }),
    ),
  ]);
  state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
  return true;
}
