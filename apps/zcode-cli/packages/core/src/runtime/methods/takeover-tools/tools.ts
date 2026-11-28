import type { ModelInputMessage, ModelToolCall, ModelToolContract } from "@zcode/contracts";
import { createRuntimeAssistantEntry, createRuntimeToolResultEntry } from "../../../agent/message-history.js";
import { modelMessageContentToText } from "../../deps.js";
import { modelContentForToolResult } from "../../helpers/index.js";
import type { AgentRuntimeInternal } from "../../internal.js";
import type { RuntimeModelTextResult } from "../../types.js";
import { commitTurnRequestEntries } from "../turn-output-token-continuation.js";
import { recordModelHistoryRound, type RegularTurnLoopState } from "../turn-loop-state.js";

/** Сколько раундов «модель → инструменты» перехват даёт резервной модели. */
export const TAKEOVER_TOOL_ROUNDS = 3;
/** Потолок выходных токенов одного раунда: длинный вывод читается, но не съедает бюджет. */
const TOOL_RESULT_MAX_CHARS = 6_000;

export interface ExecutedToolCall {
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
}

/**
 * Один инструмент исполняется уже при завершённом шаге, вне turn-loop, поэтому
 * реестр от него не ждёт `state.activeTurn`. Ассоциация к turn и участие в
 * permission-потоке работают как обычно.
 */
export async function executeTakeoverToolCall(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  toolCall: ModelToolCall,
): Promise<ExecutedToolCall> {
  try {
    const result = await runtime.executor.execute(
      { id: toolCall.id, name: toolCall.name, input: toolCall.input },
      { traceContext: state.turnTraceContext },
    );
    const text = modelMessageContentToText(modelContentForToolResult(result));
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: text.length > TOOL_RESULT_MAX_CHARS ? `${text.slice(0, TOOL_RESULT_MAX_CHARS)}…` : text,
      isError: result.success === false,
    };
  } catch (error) {
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
}

/**
 * Дописывает раунд резервной модели в ту же request-историю: assistant с tool calls и
 * результаты инструментов. Без этого следующий шаг основной модели не увидел бы работу
 * резервной модели и не смог бы её отбросить.
 */
export function commitTakeoverToolRound(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  result: Pick<RuntimeModelTextResult, "text">,
  calls: readonly ModelToolCall[],
  executed: readonly ExecutedToolCall[],
): void {
  commitTurnRequestEntries(runtime, state.turnRequestState, [
    createRuntimeAssistantEntry(
      result.text,
      calls.map((call) => ({ id: call.id, name: call.name, input: call.input })),
    ),
    ...executed.map((item) =>
      createRuntimeToolResultEntry(item.toolCallId, item.toolName, item.content, item.isError),
    ),
  ]);
  state.toolCallCount += calls.length;
  recordModelHistoryRound(state);
}

/**
 * Какие инструменты получает резервная модель. Тот же список, что у main turn, поэтому
 * наследуются и ограничения turn (allowlist, выключенные subagents, automation-границы).
 * `ToolSearch`/`DeferredToolCall` отфильтрованы: у перехвата нет их состояния загрузки.
 */
export function takeoverToolContracts(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): ModelToolContract[] {
  let tools: ModelToolContract[];
  try {
    tools = runtime.getTools(state.model);
  } catch {
    return [];
  }
  return tools.filter(
    (tool) => tool.name !== "ToolSearch" && tool.name !== "DeferredToolCall",
  );
}

/**
 * Сообщения одного раунда для повторного запроса: assistant со **структурными**
 * `toolCalls` и tool-результаты с `toolCallId`/`toolName`.
 *
 * РЕГРЕССИЯ (живой лог 2026-11-28, 11:45:37Z): раньше раунд собирался текстом —
 * `{role:"tool", content:"Bash (ok): …"}`, — и адаптер (`adapters/src/model/transform.ts`)
 * отвергал его ещё до сети: «Tool model messages require toolCallId and toolName».
 * Инструменты исполнялись, а результаты до модели не доезжали, и раунд обрывался.
 * Текстовое представление вызовов не заменяет их: провайдер сопоставляет результат
 * с вызовом только по этим двум полям.
 */
export function takeoverRoundMessages(
  text: string,
  calls: readonly ModelToolCall[],
  executed: readonly ExecutedToolCall[],
): ModelInputMessage[] {
  return [
    {
      role: "assistant",
      content: text.trim(),
      toolCalls: calls.map((call) => ({ id: call.id, name: call.name, input: call.input })),
    },
    ...executed.map((item) => ({
      role: "tool" as const,
      content: item.content,
      toolCallId: item.toolCallId,
      toolName: item.toolName,
      isError: item.isError,
    })),
  ];
}
