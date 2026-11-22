import {
  CHAT_AUTOCOMPLETE_MAX_CONTEXT_MESSAGES,
  CHAT_AUTOCOMPLETE_MAX_OUTPUT_TOKENS,
  CHAT_AUTOCOMPLETE_REQUEST_TIMEOUT_MS,
  ChatAutocompleteError,
  chatAutocompleteAcceptedSuggestionSchema,
  chatAutocompleteRequestSchema,
  chatAutocompleteResponseSchema,
  classifyPromptEnhanceTask,
  clipGhostSuggestion,
  detectAssistantVoiceSuggestion,
  filterAssistantVoiceSuggestion,
  removePrefixOverlap,
  type ChatAutocompleteAcceptedSuggestion,
  type ChatAutocompleteErrorCode,
  type ChatAutocompleteLexiconProfile,
  type ChatAutocompleteRequest,
} from "@zcode/shared";
import { createServiceLogger, type ServiceLogger } from "../logger/serviceLogger.js";
import type { ChatAutocompleteService } from "./contract.js";
import { PrefixRingCache } from "./prefix-ring-cache.js";
import { UserLexiconStore } from "./user-lexicon-store.js";

/**
 * `ChatAutocompleteService` — малолатентный конвейер ghost-подсказок.
 *
 * Ключевые инварианты:
 * - Один запрос — один `AbortController`. Новый запрос того же workspace отменяет
 *   предыдущий: устаревшая подсказка не может «догнать» курсор.
 * - Кэш префиксов проверяется до модели: повторный ввод отдаётся за микросекунды.
 * - Модель вызывается с жёстким бюджетом (`<= 48` токенов) и таймаутом `<= 1200 мс`.
 * - Текст подсказки никогда не логируется; в логи идут только счётчики.
 * - Профиль лексики пишется через `UserLexiconStore`, второй копии истины нет.
 */

/** Текстовый генератор Host'а (реализуется поверх `zcodeAgentService.generateWorkspaceText`). */
export interface ChatAutocompleteTextGenerator {
  generateText(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    selection: {
      providerId: string;
      modelId: string;
      options?: { reasoningLevel?: string };
    };
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    querySource: string;
    maxOutputTokens?: number;
    signal: AbortSignal;
  }): Promise<{
    text: string;
    selection: { providerId: string; modelId: string };
  }>;
}

export interface ChatAutocompleteModelResolver {
  /**
   * Быстрая/дешёвая модель для ghost-подсказок; `null` — запрос без модели не обслуживается.
   *
   * `reasoningLevels` — допустимые значения из реестра провайдеров. Ghost-подсказка должна
   * идти с самым дешёвым уровнем, но провайдер валидирует его строго: у части моделей есть
   * только `disabled`/`enabled`, поэтому захардкоженный `none` ломал генерацию.
   */
  resolveDefaultSelection(): Promise<{
    providerId: string;
    modelId: string;
    reasoningLevels?: readonly string[];
  } | null>;
}

/**
 * Самый дешёвый допустимый уровень для вспомогательного вызова.
 *
 * 修复原因: ghost-автодополнение раньше жёстко отправляло `reasoningLevel: "none"`,
 * из-за чего модели без такого уровня отклоняли запрос и подсказка не появлялась.
 */
export function pickCheapestReasoningLevel(
  values: readonly string[] | undefined,
): string | undefined {
  if (!values || values.length === 0) return undefined;
  return values[0];
}

/** Компактный контекст: только метаданные, без содержимого файлов и секретов. */
export interface ChatAutocompleteContextPorts {
  history?: {
    readRecentMessages(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      sessionId?: string;
      limit: number;
    }): Promise<Array<{ role: "user" | "assistant"; text: string }>>;
  };
  diffs?: {
    listChangedFiles(params: { workspacePath: string; limit: number }): Promise<string[]>;
  };
  codeSearch?: {
    search(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      query: string;
      limit: number;
    }): Promise<Array<{ path: string; symbolName?: string }>>;
  };
}

export interface ChatAutocompleteServiceOptions {
  textGenerator: ChatAutocompleteTextGenerator;
  modelResolver?: ChatAutocompleteModelResolver;
  contextPorts?: ChatAutocompleteContextPorts;
  lexiconStore?: UserLexiconStore;
  prefixCache?: PrefixRingCache;
  logger?: ServiceLogger;
  /** Таймаут запроса; внедряется, чтобы тесты не ждали реальные 1.2 с. */
  requestTimeoutMs?: number;
  now?: () => number;
  /** Автоочистка кэша с последнего использования (не держим текст вечно). */
  cacheTtlMs?: number;
}

const QUERY_SOURCE = "chat_autocomplete";
const CONTEXT_HISTORY_LIMIT = CHAT_AUTOCOMPLETE_MAX_CONTEXT_MESSAGES;
const CONTEXT_DIFF_LIMIT = 12;
const CONTEXT_CODE_LIMIT = 5;
const CACHE_TEXT_LIMIT = 2_000;

/** workspaceKey: identity важнее пути — совпадает с правилом идентичности репозитория. */
export function resolveAutocompleteWorkspaceKey(params: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  return params.workspaceIdentity?.trim() || params.workspacePath;
}

/**
 * Дебаунс вынесен в `@zcode/shared`, чтобы UI и Host применяли одну политику.
 * Реэкспорт сохраняет существующих потребителей сервисного модуля.
 */
export { resolveAdaptiveGhostDebounceMs as resolveAdaptiveDebounceMs } from "@zcode/shared";

function buildSystemPrompt(): string {
  return [
    "You complete the user's own draft in the chat composer of a coding assistant.",
    "The draft is a message the user is still writing to an AI coding agent.",
    "Predict ONLY what this user would type next at the cursor, in the user's voice, language, person and register: a task, a question, a clarification, a constraint or an acceptance criterion.",
    "Return ONLY the continuation suffix: never repeat the draft, no quotes, no markdown, one line, at most 12 words.",
    "Never answer the draft, never explain it, never describe your own intentions or actions, and never write an assistant plan.",
    'Forbidden openings include "Сначала изучу", "Сначала проверю", "Затем проверю", "Проверю", "Изучу", "Давайте", "I will", "I\'ll", "Let me", "First, I", numbered plans, headings and code fences.',
    "If you cannot continue the user's thought, return an empty string.",
  ].join(" ");
}

function buildUserMessage(input: {
  request: ChatAutocompleteRequest;
  lexicon: ChatAutocompleteLexiconProfile | null;
  recentMessages: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
  changedFiles: readonly string[];
  symbols: ReadonlyArray<{ path: string; symbolName?: string }>;
}): string {
  const lines: string[] = [];
  // Same deterministic classifier as the prompt enhancer: no extra model call, but the
  // continuation knows whether the draft is a bugfix/feature/etc. and can bias toward the
  // next missing part of a task brief instead of an assistant plan.
  const classification = classifyPromptEnhanceTask({
    draftText: input.request.prefix,
    target: "chat_user_prompt",
  });
  lines.push(
    "The draft below is NOT sent yet. The draft and the context exist only to predict the user's next words.",
  );
  lines.push(
    "Do not answer the draft and do not plan actions for an assistant. Write only the user's own continuation.",
  );
  if (input.recentMessages.length > 0) {
    lines.push(
      "Conversation so far (context only, never answer it; assistant messages are project facts, not a voice to imitate):",
    );
    for (const message of input.recentMessages) {
      lines.push(`${message.role}: ${message.text.slice(0, 240)}`);
    }
  }
  if (input.request.activeFilePath) lines.push(`Active file: ${input.request.activeFilePath}`);
  if (input.request.openTabPaths.length > 0) {
    lines.push(`Open files: ${input.request.openTabPaths.slice(0, 5).join(", ")}`);
  }
  if (input.changedFiles.length > 0) {
    lines.push(`Changed files: ${input.changedFiles.slice(0, 6).join(", ")}`);
  }
  if (input.symbols.length > 0) {
    lines.push(
      `Relevant symbols: ${input.symbols
        .slice(0, 5)
        .map((symbol) => symbol.symbolName ?? symbol.path)
        .join(", ")}`,
    );
  }
  if (input.lexicon && input.lexicon.frequentPhrases.length > 0) {
    lines.push(
      `User vocabulary: ${input.lexicon.frequentPhrases
        .slice(0, 12)
        .map((phrase) => phrase.text)
        .join(", ")}`,
    );
  }
  if (input.lexicon && input.lexicon.imperativePatterns.length > 0) {
    lines.push(`Typical phrasing: ${input.lexicon.imperativePatterns.slice(0, 5).join(" | ")}`);
  }
  lines.push(
    `Draft shape: ${classification.taskKind}/${classification.domain}. Continue with the next missing part of the user's task brief (scope, constraint, acceptance criterion or missing input), not with an assistant plan.`,
  );
  if (input.request.suffix.length > 0) {
    lines.push("Cursor position: in the middle of the draft.");
    lines.push(`Text after the cursor (do not repeat it): ${input.request.suffix}`);
  } else {
    lines.push("Cursor position: at the end of the draft.");
  }
  lines.push(`Draft before the cursor:\n${input.request.prefix}`);
  lines.push("Continuation (start exactly at the cursor, user voice, one line):");
  return lines.join("\n");
}

/** Последние N слов префикса — запрос к код-индексу остаётся дешёвым. */
function lastWords(prefix: string, count = 4): string {
  return prefix.trim().split(/\s+/).slice(-count).join(" ");
}

export function createChatAutocompleteService(
  options: ChatAutocompleteServiceOptions,
): ChatAutocompleteService {
  const logger = options.logger ?? createServiceLogger("chat-autocomplete");
  const requestTimeoutMs = options.requestTimeoutMs ?? CHAT_AUTOCOMPLETE_REQUEST_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const cache = options.prefixCache ?? new PrefixRingCache({ now });
  const lexicon = options.lexiconStore ?? new UserLexiconStore({ now });
  const active = new Map<
    string,
    {
      controller: AbortController;
      workspaceKey: string;
      abortCode: "aborted" | "timeout" | null;
    }
  >();

  /**
   * Один активный запрос на workspace: гонка «старый ответ пришёл после нового»
   * закрывается отменой, а не фильтром по времени.
   */
  const abortPreviousForWorkspace = (workspaceKey: string, keepRequestId: string): void => {
    for (const [requestId, entry] of active) {
      if (requestId === keepRequestId) continue;
      if (entry.workspaceKey !== workspaceKey) continue;
      entry.abortCode = "aborted";
      entry.controller.abort(new ChatAutocompleteError("aborted", "superseded"));
    }
  };

  return {
    async complete(rawRequest) {
      const parsed = chatAutocompleteRequestSchema.safeParse(rawRequest);
      if (!parsed.success) {
        throw new ChatAutocompleteError(
          "invalid_request",
          parsed.error.issues.map((issue) => issue.message).join("; "),
        );
      }
      const request = parsed.data;
      const workspaceKey = resolveAutocompleteWorkspaceKey(request);
      const startedAt = now();

      if (!request.cursorAtEndOfLine) {
        // Курсор в середине мысли: продолжение не имеет смысла и стоило бы токенов.
        return chatAutocompleteResponseSchema.parse({
          requestId: request.requestId,
          suggestion: "",
          source: "prefix_cache_exact",
          latencyMs: Math.max(0, now() - startedAt),
        });
      }

      const cached = cache.lookup(workspaceKey, request.prefix);
      if (cached) {
        logger.debug(undefined, "Chat autocomplete cache hit", {
          requestId: request.requestId,
          source: cached.source,
        });
        return chatAutocompleteResponseSchema.parse({
          requestId: request.requestId,
          suggestion: cached.suggestion,
          source: cached.source,
          latencyMs: Math.max(0, now() - startedAt),
        });
      }

      if (active.has(request.requestId)) {
        throw new ChatAutocompleteError("invalid_request", "Duplicate requestId is running");
      }
      // Сначала отменяем устаревший запрос, потом регистрируем новый: в `active`
      // не должно быть двух конкурентов за один workspace.
      abortPreviousForWorkspace(workspaceKey, request.requestId);
      const controller = new AbortController();
      // Причина отмены хранится в записи: ответ генератора может прийти раньше,
      // чем `signal.reason` доедет до catch, и код ошибки не должен от этого зависеть.
      const entry = {
        controller,
        workspaceKey,
        abortCode: null as "aborted" | "timeout" | null,
      };
      active.set(request.requestId, entry);
      const timeout = setTimeout(() => {
        entry.abortCode = "timeout";
        controller.abort(new ChatAutocompleteError("timeout", "Autocomplete timed out"));
      }, requestTimeoutMs);

      try {
        const picked =
          request.modelSelection ?? (await options.modelResolver?.resolveDefaultSelection());
        const selection = picked as
          | {
              providerId: string;
              modelId: string;
              reasoningLevels?: readonly string[];
            }
          | null
          | undefined;
        if (!selection) {
          throw new ChatAutocompleteError("model_unavailable", "No autocomplete model configured");
        }

        const [recentMessages, changedFiles, symbols, profile] = await Promise.all([
          request.context.history && options.contextPorts?.history
            ? options.contextPorts.history
                .readRecentMessages({
                  workspacePath: request.workspacePath,
                  ...(request.workspaceIdentity
                    ? { workspaceIdentity: request.workspaceIdentity }
                    : {}),
                  ...(request.sessionId ? { sessionId: request.sessionId } : {}),
                  limit: CONTEXT_HISTORY_LIMIT,
                })
                .catch(() => [])
            : Promise.resolve([]),
          request.context.diffs && options.contextPorts?.diffs
            ? options.contextPorts.diffs
                .listChangedFiles({
                  workspacePath: request.workspacePath,
                  limit: CONTEXT_DIFF_LIMIT,
                })
                .catch(() => [])
            : Promise.resolve([]),
          request.context.codeIndex && options.contextPorts?.codeSearch
            ? options.contextPorts.codeSearch
                .search({
                  workspacePath: request.workspacePath,
                  ...(request.workspaceIdentity
                    ? { workspaceIdentity: request.workspaceIdentity }
                    : {}),
                  query: lastWords(request.prefix),
                  limit: CONTEXT_CODE_LIMIT,
                })
                .catch(() => [])
            : Promise.resolve([]),
          request.context.userLexicon ? lexicon.read().catch(() => null) : Promise.resolve(null),
        ]);
        controller.signal.throwIfAborted();

        const generated = await options.textGenerator.generateText({
          workspacePath: request.workspacePath,
          ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
          selection: {
            providerId: selection.providerId,
            modelId: selection.modelId,
            // Ghost-подсказка всегда идёт с самым дешёвым доступным уровнем; если реестр
            // его не сообщил (старый Host), оставляем прежний `none` как безопасный дефолт.
            options: {
              reasoningLevel: pickCheapestReasoningLevel(selection.reasoningLevels) ?? "none",
            },
          },
          messages: [
            { role: "system", content: buildSystemPrompt() },
            {
              role: "user",
              content: buildUserMessage({
                request,
                lexicon: profile,
                recentMessages,
                changedFiles,
                symbols,
              }),
            },
          ],
          querySource: QUERY_SOURCE,
          maxOutputTokens: CHAT_AUTOCOMPLETE_MAX_OUTPUT_TOKENS,
          signal: controller.signal,
        });

        const normalized = clipGhostSuggestion(generated.text);
        const overlapped = removePrefixOverlap(request.prefix, normalized);
        const suggestion = filterAssistantVoiceSuggestion(overlapped);
        if (!suggestion && overlapped) {
          // Модель ответила как ассистент. Подсказку не показываем и не кладём в кэш;
          // в лог идёт только причина, без текста ответа.
          logger.debug(undefined, "Chat autocomplete filtered assistant voice", {
            requestId: request.requestId,
            reason: detectAssistantVoiceSuggestion(overlapped),
          });
        }
        if (!suggestion.trim()) {
          throw new ChatAutocompleteError("empty_suggestion", "Model returned no continuation");
        }

        cache.record(workspaceKey, request.prefix.slice(-CACHE_TEXT_LIMIT), suggestion);
        const latencyMs = Math.max(0, now() - startedAt);
        logger.debug(undefined, "Chat autocomplete completed", {
          requestId: request.requestId,
          latencyMs,
          suggestionChars: suggestion.length,
          contextMessages: recentMessages.length,
          contextSymbols: symbols.length,
        });
        return chatAutocompleteResponseSchema.parse({
          requestId: request.requestId,
          suggestion,
          source: "model_stream",
          latencyMs,
          modelUsed: {
            providerId: generated.selection.providerId,
            modelId: generated.selection.modelId,
          },
        });
      } catch (error) {
        // Причина отмены берётся из записи: таймаут и пользовательская отмена —
        // разные состояния, и UI не должен показывать таймаут как отмену.
        const code =
          error instanceof ChatAutocompleteError
            ? error.code
            : (entry.abortCode ?? (controller.signal.aborted ? "aborted" : "model_failed"));
        // Ожидаемые отмены и таймауты не должны засорять логи как ошибки.
        if (code === "aborted" || code === "timeout" || code === "empty_suggestion") {
          logger.debug(undefined, "Chat autocomplete skipped", {
            requestId: request.requestId,
            code,
          });
        } else {
          logger.warn(undefined, "Chat autocomplete failed", {
            requestId: request.requestId,
            code,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (error instanceof ChatAutocompleteError) throw error;
        // Таймаут и отмена — валидные коды контракта: не сворачиваем их в `model_failed`,
        // иначе UI не отличит ожидаемое скрытие подсказки от настоящей ошибки модели.
        const surfacedCode: ChatAutocompleteErrorCode =
          code === "aborted" || code === "timeout" || code === "empty_suggestion"
            ? code
            : "model_failed";
        throw new ChatAutocompleteError(
          surfacedCode,
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        clearTimeout(timeout);
        active.delete(request.requestId);
      }
    },

    async cancel(params) {
      const entry = active.get(params.requestId);
      if (!entry) return;
      entry.abortCode = "aborted";
      entry.controller.abort(new ChatAutocompleteError("aborted", "cancelled"));
    },

    async recordAcceptedSuggestion(rawParams: ChatAutocompleteAcceptedSuggestion) {
      const parsed = chatAutocompleteAcceptedSuggestionSchema.safeParse(rawParams);
      if (!parsed.success) {
        throw new ChatAutocompleteError(
          "invalid_request",
          parsed.error.issues.map((issue) => issue.message).join("; "),
        );
      }
      // Профиль общий для пользователя: identity используется только как ключ кэша.
      try {
        await lexicon.observe(parsed.data.fullPrompt);
      } catch (error) {
        logger.warn(undefined, "Chat autocomplete lexicon update failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async getLexiconProfile() {
      return lexicon.read();
    },

    async clearLexiconProfile() {
      await lexicon.clear();
      logger.info(undefined, "Chat autocomplete lexicon cleared");
    },
  };
}
