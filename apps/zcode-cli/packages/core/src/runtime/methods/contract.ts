import type { ModelToolCall, ModelToolContract } from "@zcode/contracts";
import type { ExecutedToolCall } from "./uncensored-takeover-tools.js";

/**
 * cli-core-takeover-tools 对外契约: резервная модель перехвата обязана иметь те же
 * инструменты, что основная; этот модуль решает «какие» и исполняет раунд.
 *
 * Инварианты: набор наследует ограничения turn, результаты усекаются до 6000 символов,
 * помощник исполнения никогда не бросает (ошибка инструмента — это результат с isError).
 */
export interface CliCoreTakeoverToolsContract {
  /** Инструменты для резервной модели: getTools минус ToolSearch/DeferredToolCall. */
  contracts(runtime: unknown, state: unknown): ModelToolContract[];
  /** Исполнить один вызов вне turn-loop; ошибка инструмента не пробрасывается. */
  execute(
    runtime: unknown,
    state: unknown,
    toolCall: ModelToolCall,
  ): Promise<ExecutedToolCall>;
  /** Записать раунд (assistant + tool-результаты) в request-историю turn. */
  commitRound(
    runtime: unknown,
    state: unknown,
    result: { text: string },
    calls: readonly ModelToolCall[],
    executed: readonly ExecutedToolCall[],
  ): void;
  /** Сообщения раунда для повторного запроса к модели. */
  roundMessages(
    text: string,
    calls: readonly ModelToolCall[],
    executed: readonly ExecutedToolCall[],
  ): Array<{ role: "assistant" | "tool"; content: string }>;
}
