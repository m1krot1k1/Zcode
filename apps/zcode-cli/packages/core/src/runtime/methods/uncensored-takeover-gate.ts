import { createModelId, createModelProviderId } from "@zcode/contracts";
import type { ModelId, ModelProviderId, TodoItem } from "@zcode/contracts";
import {
  createMessageId,
  createPartId,
  modelMessageContentToText,
  SessionEventType,
  TurnMachineImpl,
} from "../deps.js";
import type { MessageId } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeModelTextResult } from "../types.js";
import { recordModelHistoryRound, type RegularTurnLoopState } from "./turn-loop-state.js";
import { createRuntimeModel } from "./runtime-model.js";
import {
  commitTakeoverToolRound,
  executeTakeoverToolCall,
  TAKEOVER_TOOL_ROUNDS,
  takeoverToolContracts,
  takeoverRoundMessages,
} from "./uncensored-takeover-tools.js";
import { commitTurnRequestEntries } from "./turn-output-token-continuation.js";
import {
  createRuntimeAssistantEntry,
  systemReminderAttachmentEntry,
} from "../../agent/message-history.js";
import {
  attributeTodoItem,
  attributeTurnItem,
  buildTakeoverEntry,
  buildTakeoverReminder,
  detectRefusal,
  detectTextRefusal,
  hasRefusalMarker,
  normalizeItemText,
  parseTakeoverEntryData,
  runUncensoredTakeover,
  selectContextFragments,
  takeoverAgentId,
  takeoverIdempotencyKey,
  TAKEOVER_MAX_TOKENS,
  TEXT_REFUSAL_REASON,
  truncateItemText,
  UNCENSORED_TAKEOVER_AGENT_TYPE,
  UNCENSORED_TAKEOVER_ENTRY_TYPE,
  type TakeoverContextFragment,
  type TakeoverTerminal,
  type TakeoverToolResult,
  type UncensoredGeneratePort,
} from "../uncensored-takeover/index.js";

interface CachedOutcome {
  terminal: TakeoverTerminal;
  /** Turn that already settled this item: a reminder was injected or the final text written. */
  resolvedTurnId?: string;
}

/** Per-runtime, therefore per-session, guard. It closes the same-process duplicate window;
 * the durable session entry closes the restart window. Limitation: a second process sharing
 * one session relies on `sessionEntries` being implemented by its SessionStorePort.
 */
const outcomesByRuntime = new WeakMap<object, Map<string, CachedOutcome>>();

/**
 * Gate outcome. `finish` means the fallback outcome is already persisted as the turn's final
 * assistant answer; the caller must end the turn instead of requesting another model step.
 */
export type UncensoredTakeoverGateResult =
  | { action: "unhandled" }
  | { action: "continue" }
  | { action: "finish"; assistantMessageId: MessageId; finalText: string };

/**
 * Text the user must see as the turn's final answer when the fallback model, not the main
 * model, owns the outcome. A successful takeover returns its output verbatim; every other
 * terminal state is an explicit error text so a repeated main-model refusal can never stand
 * in for the fallback result.
 */
function takeoverFinalText(terminal: TakeoverTerminal): string {
  if (terminal.status === "done" && terminal.output.trim().length > 0) return terminal.output;
  const reason = terminal.reason ? `: ${terminal.reason}` : "";
  if (!terminal.modelId) {
    return `No fallback model produced an answer (status: ${terminal.status})${reason}.`;
  }
  const provider = terminal.providerName ?? terminal.providerId ?? "unknown";
  return `Fallback model ${provider}/${terminal.modelId} did not produce an answer (status: ${terminal.status})${reason}.`;
}

/**
 * Valid options for one takeover attempt. The registry validates strictly against the model's
 * own `optionSpecs`: the lowest supported reasoning level, and an output budget inside its
 * range. Both values come from the runtime model, so a mirror model with `disabled` only and
 * a small max output no longer fails before any request.
 */
function takeoverModelOptions(
  runtime: AgentRuntimeInternal,
  providerId: string,
  modelId: string,
): { options: { reasoningLevel?: string; maxOutputTokens?: number }; maxOutputTokens?: number } {
  if (!runtime.modelFactory) return { options: {} };
  let model;
  try {
    model = createRuntimeModel(runtime, {
      selection: {
        providerId: createModelProviderId(providerId),
        modelId: createModelId(modelId),
      },
      scope: "workspace",
      admissionPriority: "background",
    });
  } catch {
    return { options: {} };
  }
  const reasoningLevel = model.optionSpecs.reasoningLevel?.values[0];
  const maxOutputTokens = model.optionSpecs.maxOutputTokens?.max;
  const budget =
    typeof maxOutputTokens === "number"
      ? Math.min(TAKEOVER_MAX_TOKENS, maxOutputTokens)
      : TAKEOVER_MAX_TOKENS;
  return {
    options: {
      ...(reasoningLevel === undefined ? {} : { reasoningLevel }),
      maxOutputTokens: budget,
    },
    maxOutputTokens: budget,
  };
}

/** Fallback model attribution from the terminal fact; `null` when no model produced it. */
function takeoverModelAttribution(
  terminal: TakeoverTerminal,
): { providerId: ModelProviderId; modelId: ModelId } | null {
  if (!terminal.providerId || !terminal.modelId) return null;
  return {
    providerId: createModelProviderId(terminal.providerId),
    modelId: createModelId(terminal.modelId),
  };
}

/**
 * Writes the fallback outcome as the turn's final assistant answer. The text is persisted for
 * cold replay and streamed through the normal ModelStreaming projection for the live UI, so
 * the final visible text is deterministic instead of depending on the next main-model step.
 */
async function commitTakeoverFinalText(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  terminal: TakeoverTerminal,
): Promise<{ assistantMessageId: MessageId; finalText: string }> {
  const text = takeoverFinalText(terminal);
  const attribution = takeoverModelAttribution(terminal);
  const createdAt = Date.now();
  const messageId = createMessageId();
  const partId = createPartId();
  const traceContext = state.turnTraceContext;
  // Synthetic answer, not a model step. `persistCompletedAssistantStep` is intentionally not
  // reused: it commits `state.modelResponse` (the primary refusal) and the primary step's
  // `step-finish`/usage, which would attribute the fallback answer to the wrong step. These
  // primitives match the existing synthetic assistant carriers.
  await runtime.persistAssistantMessage(
    messageId,
    state.currentUserMessageId,
    createdAt,
    { completed: createdAt, finish: "stop" },
    traceContext,
    attribution,
  );
  await runtime.persistPart(
    {
      id: partId,
      sessionID: runtime.sessionId,
      messageID: messageId,
      type: "text",
      text,
      time: { start: createdAt, end: createdAt },
    },
    traceContext,
  );
  for (const payload of [
    { kind: "text_start" as const, delta: "", done: false },
    { kind: "text_delta" as const, delta: text, done: false },
    { kind: "text_end" as const, delta: "", done: true },
  ]) {
    await runtime.emitModelStreamingEvent(
      { ...payload, assistantMessageId: messageId, partId },
      traceContext,
      state.events,
    );
  }
  recordModelHistoryRound(state);
  commitTurnRequestEntries(runtime, state.turnRequestState, [
    createRuntimeAssistantEntry(text, undefined, undefined, attribution ?? undefined),
  ]);
  return { assistantMessageId: messageId, finalText: text };
}

/** The attributed todo item is last when no other pending/in_progress item remains. */
function hasRemainingTodoWork(todos: readonly TodoItem[], itemIndex: number): boolean {
  return todos.some(
    (todo, index) =>
      index !== itemIndex && (todo.status === "pending" || todo.status === "in_progress"),
  );
}

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
 * Returns `continue` when the turn must request the next model step, and `finish` when the
 * fallback outcome is already the turn's final visible assistant answer.
 */
export async function runUncensoredTakeoverGate(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: { querySource: string; result: RuntimeModelTextResult },
): Promise<UncensoredTakeoverGateResult> {
  if (options.querySource !== "main_turn") return { action: "unhandled" };
  const takeover = this.config.uncensoredTakeover;
  if (!takeover) return { action: "unhandled" };
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
  if (!reason) return { action: "unhandled" };
  if (!this.sessionStore?.readTodos) return { action: "unhandled" };
  let todos;
  try {
    todos = await this.sessionStore.readTodos({ sessionID: this.sessionId });
  } catch (error) {
    this.logger?.warn("Uncensored takeover todo read failed", {
      module: "core.runtime",
      event: "uncensored_takeover.todo_read_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return { action: "unhandled" };
  }
  // The current turn's input is authoritative: the message entries may still describe the
  // previous turn at this point, which routed a stale item to the fallback model (one turn late).
  const currentUserText = state.input.trim().length > 0 ? state.input : lastUserText;
  const item = attributeTurnItem(todos, currentUserText, lastAssistantText);
  if (!item) return { action: "unhandled" };
  // A plain chat turn (no todo list, item equals the whole message) leaves nothing for the main
  // model after the takeover, so its next step can only repeat the refusal.
  const wholeUserMessage =
    todos.length === 0 && item.itemText === truncateItemText(normalizeItemText(currentUserText));
  // The todo branch needs the main model only when another pending/in_progress item remains.
  // On the last item the fallback answer is the turn's final text, same as plain chat.
  const trackedTodoItem = attributeTodoItem(todos);
  const noRemainingWork =
    wholeUserMessage ||
    (trackedTodoItem !== null && !hasRemainingTodoWork(todos, trackedTodoItem.itemIndex));

  const taskId = String(this.sessionId);
  const key = takeoverIdempotencyKey(taskId, item.itemText);
  const outcomes = outcomesFor(this);
  const cached = outcomes.get(key);
  const existing = cached ?? (await readDurableOutcome(this, taskId, key));

  if (existing) {
    // Duplicate: no second model.refusal, no second spawn/stop, no HTTP.
    // Root cause of the repeated refusal: after the reminder the main model may refuse the same
    // item again; that refusal is already streamed and persisted. The fallback outcome owns the
    // final text; the refusal stays in history/metadata but never overrides it.
    if (existing.resolvedTurnId === state.turnId) {
      const outcome = await commitTakeoverFinalText(this, state, existing.terminal);
      return { action: "finish", ...outcome };
    }
    const reminder = buildTakeoverReminder({
      itemIndex: item.itemIndex,
      terminal: existing.terminal,
    });
    commitTurnRequestEntries(this, state.turnRequestState, [
      systemReminderAttachmentEntry("uncensored_takeover", reminder),
    ]);
    outcomes.set(key, { terminal: existing.terminal, resolvedTurnId: state.turnId });
    state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
    return { action: "continue" };
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
  // Options valid for the model the attempt will call. Hardcoded `reasoningLevel: "disabled"`
  // plus the resolver's default output budget broke the range: the Host option map sends
  // `reasoning_effort: "none"` while the model's own maxOutputTokens is lower than the default,
  // and the registry rejected every mirror attempt with
  // "maxOutputTokens is outside the model option range". Only the raw fallback ran, so the
  // takeover worked at ~50 s per attempt instead of the mirror path.
  const optionFor = (providerId: string, modelId: string) => takeoverModelOptions(this, providerId, modelId);
  const toolContracts = takeoverToolContracts(this, state);

  const generate: UncensoredGeneratePort = {
    generate: async ({ providerId, modelId, messages, signal }) => {
      const timeout = AbortSignal.timeout(60_000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const budget = optionFor(providerId, modelId);
      // Локальный список растёт раундами инструментов: у него появляются роли
      // assistant/tool, которых нет у двух стартовых сообщений.
      const requestMessages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }> =
        messages.map((message) => ({ role: message.role, content: message.content }));
      const request = async (withTools: boolean) =>
        this.generateWorkspaceText(
          {
            selection: { providerId, modelId, options: budget.options },
            messages: requestMessages,
            querySource: "uncensored_takeover",
            ...(withTools && toolContracts.length > 0 ? { tools: toolContracts } : {}),
            ...(budget.maxOutputTokens === undefined
              ? {}
              : { maxOutputTokens: budget.maxOutputTokens }),
          },
          { abortSignal: combined, traceContext: state.turnTraceContext },
        );
      let result: Awaited<ReturnType<typeof request>>;
      try {
        result = await request(true);
      } catch (error) {
        // Провайдер может не поддержать инструменты: перехват обязан работать и без них.
        if (toolContracts.length === 0) throw error;
        this.logger?.info("Uncensored takeover retried without tools", {
          module: "core.runtime",
          event: "uncensored_takeover.tools_unsupported",
          reason: error instanceof Error ? error.message : String(error),
        });
        result = await request(false);
      }
      // Инструменты: пока модель их просит — исполняем раунд и повторяем запрос с теми же
      // сообщениями плюс история. Иначе перехват отвечает текстом «что нужно сделать»,
      // не выполнив ничего, хотя у основной модели те же права.
      let calls = (result.toolCalls ?? []).filter((call) => call.name.length > 0);
      let rounds = 0;
      while (calls.length > 0 && rounds < TAKEOVER_TOOL_ROUNDS) {
        const executed = await Promise.all(
          calls.map((call) => executeTakeoverToolCall(this, state, call)),
        );
        commitTakeoverToolRound(this, state, result, calls, executed);
        requestMessages.push(...takeoverRoundMessages(result.text, calls, executed));
        rounds += 1;
        result = await request(true);
        calls = (result.toolCalls ?? []).filter((call) => call.name.length > 0);
      }
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
  outcomes.set(key, { terminal, resolvedTurnId: state.turnId });

  if (state.turnAbortSignal.aborted) return { action: "continue" };
  if (noRemainingWork) {
    // Nothing remains for the main model, so the fallback outcome is the turn's final answer.
    // This also breaks the refusal -> reminder -> refusal chain at its source.
    const outcome = await commitTakeoverFinalText(this, state, terminal);
    return { action: "finish", ...outcome };
  }
  commitTurnRequestEntries(this, state.turnRequestState, [
    systemReminderAttachmentEntry(
      "uncensored_takeover",
      buildTakeoverReminder({ itemIndex: item.itemIndex, terminal }),
    ),
  ]);
  state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
  return { action: "continue" };
}
