import {
  PROMPT_ENHANCE_REQUEST_TIMEOUT_MS,
  PromptEnhanceError,
  buildMentionViolationFeedback,
  buildPromptEnhancerSystemPrompt,
  buildPromptEnhancerUserMessage,
  findMissingPromptMentions,
  formatPromptEnhanceMentions,
  parseEnhancedPromptResponse,
  promptEnhanceRequestSchema,
  promptEnhanceResultSchema,
  type PromptEnhanceCancelParams,
  type PromptEnhanceRequest,
  type PromptEnhanceResult,
  type PromptEnhanceStreamDelta,
} from "@zcode/shared";
import { createServiceLogger, type ServiceLogger } from "../logger/serviceLogger.js";
import type { PromptEnhancerService } from "./contract.js";
import {
  collectPromptEnhanceContext,
  type CollectedPromptEnhanceContext,
  type PromptEnhanceContextPorts,
} from "./context-collector.js";

/**
 * Текстовый генератор Host'а. Реализуется поверх `zcodeAgentService.generateWorkspaceText`,
 * поэтому сервис не создаёт собственный клиент модели и не обходит admission.
 */
export interface PromptEnhancerTextGenerator {
  generateText(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    selection: { providerId: string; modelId: string; options?: { reasoningLevel?: string } };
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    querySource: string;
    maxOutputTokens?: number;
    signal: AbortSignal;
  }): Promise<{
    text: string;
    selection: { providerId: string; modelId: string };
  }>;
}

export interface PromptEnhancerModelResolver {
  /**
   * Быстрая/дешёвая модель по умолчанию для улучшения промпта. `null` — использовать
   * текущую модель сессии, если клиент её передал.
   *
   * `reasoningLevels` — фактические значения `optionSpecs.reasoningLevel.values` этой
   * модели из реестра провайдеров. Улучшение — вспомогательная операция, но провайдер
   * всё равно валидирует уровень строго (`ERR`-код `reasoning-level-not-supported`),
   * поэтому жёсткий `"minimal"` ломает модели, где доступен только `"disabled"`.
   */
  resolveDefaultSelection(): Promise<{
    providerId: string;
    modelId: string;
    reasoningLevels?: readonly string[];
  } | null>;
}

/**
 * Низший доступный уровень рассуждений: для вспомогательного вызова нам нужен самый
 * дешёвый вариант, а не «минимальный» любой ценой.
 *
 * 修复原因：у части провайдеров (например `opencode-go-messages/minimax-m3`) единственное
 * допустимое значение — `disabled`, и захардкоженный `minimal` приводил к падению
 * `prompt-enhancer.enhance` с `Reasoning level is required for ...`.
 */
export function pickLowestReasoningLevel(
  values: readonly string[] | undefined,
): string | undefined {
  if (!values || values.length === 0) return undefined;
  // Реестр перечисляет уровни от самого дешёвого к самому дорогому; первый — наш выбор.
  return values[0];
}

export interface PromptEnhancerServiceOptions {
  textGenerator: PromptEnhancerTextGenerator;
  modelResolver?: PromptEnhancerModelResolver;
  contextPorts?: PromptEnhanceContextPorts;
  logger?: ServiceLogger;
  /** Оценка токенов; внедряется, чтобы тесты не зависели от токенизатора. */
  estimateTokens?: (text: string) => { tokens: number; method: "tokenlens" | "char-ratio" };
  requestTimeoutMs?: number;
  now?: () => number;
}

const QUERY_SOURCE = "prompt_enhance";
const MAX_ENHANCER_OUTPUT_TOKENS = 4_096;

/** Отношение символ/токен, согласованное с грубой оценкой рантайма. */
const CHAR_RATIO = 4;

function defaultEstimateTokens(text: string): { tokens: number; method: "char-ratio" } {
  return { tokens: Math.ceil(text.length / CHAR_RATIO), method: "char-ratio" };
}

/**
 * Разбор ответа модели живёт в `@zcode/shared/prompt-enhancer/pipeline`, чтобы CLI `/enhance`
 * и Host применяли одни и те же инварианты. Здесь оставлены только реэкспорты для
 * существующих потребителей сервисного модуля.
 */
export const parseEnhancerResponse = parseEnhancedPromptResponse;

/** Проверяет, что все protected mentions уцелели дословно. */
export const findMissingMentions = findMissingPromptMentions;

export function createPromptEnhancerService(
  options: PromptEnhancerServiceOptions,
): PromptEnhancerService {
  const logger = options.logger ?? createServiceLogger("prompt-enhancer");
  const estimateTokens = options.estimateTokens ?? defaultEstimateTokens;
  const requestTimeoutMs = options.requestTimeoutMs ?? PROMPT_ENHANCE_REQUEST_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const listeners = new Set<(event: PromptEnhanceStreamDelta) => void>();
  const active = new Map<string, AbortController>();

  const emitDelta = (event: PromptEnhanceStreamDelta): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        logger.warn(undefined, "Prompt enhancer stream listener failed", {
          requestId: event.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const resolveSelection = async (
    request: PromptEnhanceRequest,
  ): Promise<{ providerId: string; modelId: string; options?: { reasoningLevel: string } }> => {
    if (request.modelSelection) {
      // Клиент уже прислал полный выбор: сохраняем его уровень, если он задан.
      // Подставлять «minimal» нельзя — модели с единственным `disabled` отклонят запрос.
      const requestedSelection = request.modelSelection as {
        providerId: string;
        modelId: string;
        options?: { reasoningLevel?: string };
      };
      const requestedLevel = requestedSelection.options?.reasoningLevel;
      return {
        providerId: requestedSelection.providerId,
        modelId: requestedSelection.modelId,
        ...(requestedLevel ? { options: { reasoningLevel: requestedLevel } } : {}),
      };
    }
    const fallback = await options.modelResolver?.resolveDefaultSelection();
    if (fallback) {
      const level =
        pickLowestReasoningLevel(fallback.reasoningLevels) ??
        // Резолвер без списка уровней (старый Host/Web-remote) — самый дешёвый общий вариант.
        "minimal";
      return {
        providerId: fallback.providerId,
        modelId: fallback.modelId,
        options: { reasoningLevel: level },
      };
    }
    throw new PromptEnhanceError("model_unavailable", "No enhancer model is configured");
  };

  return {
    async enhance(rawRequest) {
      const parsed = promptEnhanceRequestSchema.safeParse(rawRequest);
      if (!parsed.success) {
        throw new PromptEnhanceError(
          "invalid_request",
          parsed.error.issues.map((issue) => issue.message).join("; "),
        );
      }
      const request = parsed.data;
      if (active.has(request.requestId)) {
        throw new PromptEnhanceError("invalid_request", "Duplicate requestId is already running");
      }
      const controller = new AbortController();
      active.set(request.requestId, controller);
      const startedAt = now();
      // Таймаут и внешняя отмена сводятся к одному сигналу: сервис не держит две ветки отмены.
      const timeout = setTimeout(() => {
        controller.abort(new PromptEnhanceError("timeout", "Prompt enhancement timed out"));
      }, requestTimeoutMs);
      const abortOnDetach = () => controller.abort(new PromptEnhanceError("aborted", "cancelled"));

      try {
        const selection = await resolveSelection(request);
        let context: CollectedPromptEnhanceContext = { sections: [], sources: [] };
        try {
          context = await collectPromptEnhanceContext(options.contextPorts ?? {}, request, {
            signal: controller.signal,
          });
        } catch {
          // Потеря контекста не должна отменять улучшение: черновик остаётся достаточным входом.
          context = { sections: [], sources: [] };
        }
        controller.signal.throwIfAborted();

        const systemPrompt = buildPromptEnhancerSystemPrompt(request);
        const userMessage = buildPromptEnhancerUserMessage({
          draftText: request.draftText,
          mentions: formatPromptEnhanceMentions(request),
          activeFiles:
            request.activeFilePaths.length > 0 ? request.activeFilePaths.join(", ") : "None",
          contextSections: context.sections,
        });

        logger.debug(undefined, "Prompt enhancement started", {
          requestId: request.requestId,
          target: request.target,
          style: request.style,
          draftChars: request.draftText.length,
          contextSources: context.sources.length,
          providerId: selection.providerId,
          modelId: selection.modelId,
        });

        let generated = await options.textGenerator.generateText({
          workspacePath: request.workspacePath,
          ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
          selection,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          querySource: QUERY_SOURCE,
          maxOutputTokens: MAX_ENHANCER_OUTPUT_TOKENS,
          signal: controller.signal,
        });

        let response = parseEnhancerResponse(generated.text);
        let missing = findMissingMentions(response.enhancedText, request);
        if (missing.length > 0) {
          controller.signal.throwIfAborted();
          // Повтор ровно один раз: модель либо сохраняет маркеры, либо запрос падает явно.
          generated = await options.textGenerator.generateText({
            workspacePath: request.workspacePath,
            ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
            selection,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userMessage },
              { role: "assistant", content: generated.text },
              { role: "user", content: buildMentionViolationFeedback(missing) },
            ],
            querySource: QUERY_SOURCE,
            maxOutputTokens: MAX_ENHANCER_OUTPUT_TOKENS,
            signal: controller.signal,
          });
          response = parseEnhancerResponse(generated.text);
          missing = findMissingMentions(response.enhancedText, request);
          if (missing.length > 0) {
            throw new PromptEnhanceError(
              "unsupported_changes",
              `Enhancer dropped protected markers: ${missing.join(", ")}`,
            );
          }
        }

        emitDelta({
          requestId: request.requestId,
          delta: response.enhancedText,
          accumulated: response.enhancedText,
        });

        const before = estimateTokens(request.draftText);
        const after = estimateTokens(response.enhancedText);
        const result: PromptEnhanceResult = {
          requestId: request.requestId,
          enhancedText: response.enhancedText,
          style: request.style,
          addedClarifications: response.addedClarifications,
          assumptions: response.assumptions,
          usedContext: context.sources,
          modelUsed: {
            providerId: generated.selection.providerId,
            modelId: generated.selection.modelId,
          },
          tokenDelta: {
            before: before.tokens,
            after: after.tokens,
            method: after.method,
          },
          elapsedMs: Math.max(0, now() - startedAt),
        };
        // Валидация ответа тем же контрактом, что увидит клиент: расхождение падает здесь.
        const validated = promptEnhanceResultSchema.parse(result);
        logger.info(undefined, "Prompt enhancement completed", {
          requestId: request.requestId,
          target: request.target,
          style: request.style,
          tokenDelta: validated.tokenDelta.after - validated.tokenDelta.before,
          elapsedMs: validated.elapsedMs,
        });
        return validated;
      } catch (error) {
        const code =
          error instanceof PromptEnhanceError
            ? error.code
            : controller.signal.aborted
              ? "aborted"
              : "model_failed";
        logger.warn(undefined, "Prompt enhancement failed", {
          requestId: request.requestId,
          code,
          error: error instanceof Error ? error.message : String(error),
        });
        if (error instanceof PromptEnhanceError) throw error;
        throw new PromptEnhanceError(
          code === "aborted" ? "aborted" : "model_failed",
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        clearTimeout(timeout);
        controller.signal.removeEventListener("abort", abortOnDetach);
        active.delete(request.requestId);
      }
    },

    async cancel(params: PromptEnhanceCancelParams) {
      const controller = active.get(params.requestId);
      if (!controller) return;
      controller.abort(new PromptEnhanceError("aborted", "cancelled"));
    },

    onStreamDelta(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
