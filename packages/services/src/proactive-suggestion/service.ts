import {
  PROACTIVE_SUGGESTION_MAX_OUTPUT_TOKENS,
  PROACTIVE_SUGGESTION_REQUEST_TIMEOUT_MS,
  proactiveSuggestionRequestSchema,
  proactiveSuggestionResponseSchema,
  type ProactiveSuggestionRequest,
} from "@zcode/shared";
import { createServiceLogger, type ServiceLogger } from "../logger/serviceLogger.js";
import { ProactiveSuggestionError, type ProactiveSuggestionService } from "./contract.js";
import type {
  ProactiveSuggestionModelResolver,
  ProactiveSuggestionTextGenerator,
} from "./ports.js";
import {
  PROACTIVE_SUGGESTION_SYSTEM_PROMPT,
  buildProactiveSuggestionPrompt,
  normalizeProactiveSuggestion,
} from "./prompt.js";

export interface ProactiveSuggestionServiceOptions {
  textGenerator: ProactiveSuggestionTextGenerator;
  modelResolver?: ProactiveSuggestionModelResolver;
  logger?: ServiceLogger;
  requestTimeoutMs?: number;
  now?: () => number;
}

const QUERY_SOURCE = "proactive_suggestion";

function pickCheapestReasoningLevel(values: readonly string[] | undefined): string | undefined {
  return values && values.length > 0 ? values[0] : undefined;
}

function resolveWorkspaceKey(request: ProactiveSuggestionRequest): string {
  return request.workspaceIdentity?.trim() || request.workspacePath;
}

export function createProactiveSuggestionService(
  options: ProactiveSuggestionServiceOptions,
): ProactiveSuggestionService {
  const logger = options.logger ?? createServiceLogger("proactive-suggestion");
  const requestTimeoutMs = options.requestTimeoutMs ?? PROACTIVE_SUGGESTION_REQUEST_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const active = new Map<
    string,
    {
      controller: AbortController;
      workspaceKey: string;
      abortCode: "aborted" | "timeout" | null;
    }
  >();

  const abortPreviousForWorkspace = (workspaceKey: string, keepRequestId: string): void => {
    for (const [requestId, entry] of active) {
      if (requestId === keepRequestId || entry.workspaceKey !== workspaceKey) continue;
      entry.abortCode = "aborted";
      entry.controller.abort(new ProactiveSuggestionError("aborted", "superseded"));
    }
  };

  return {
    async complete(rawRequest) {
      const parsed = proactiveSuggestionRequestSchema.safeParse(rawRequest);
      if (!parsed.success) {
        throw new ProactiveSuggestionError(
          "invalid_request",
          parsed.error.issues.map((issue) => issue.message).join("; "),
        );
      }
      const request = parsed.data;
      const workspaceKey = resolveWorkspaceKey(request);
      const startedAt = now();

      if (active.has(request.requestId)) {
        throw new ProactiveSuggestionError("invalid_request", "Duplicate requestId is running");
      }
      abortPreviousForWorkspace(workspaceKey, request.requestId);
      const controller = new AbortController();
      const entry = {
        controller,
        workspaceKey,
        abortCode: null as "aborted" | "timeout" | null,
      };
      active.set(request.requestId, entry);
      const timeout = setTimeout(() => {
        entry.abortCode = "timeout";
        controller.abort(new ProactiveSuggestionError("timeout", "Proactive suggestion timed out"));
      }, requestTimeoutMs);

      try {
        const selection = await options.modelResolver?.resolveDefaultSelection();
        controller.signal.throwIfAborted();
        if (!selection) {
          throw new ProactiveSuggestionError(
            "model_unavailable",
            "No proactive suggestion model configured",
          );
        }

        const generated = await options.textGenerator.generateText({
          workspacePath: request.workspacePath,
          ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
          selection: {
            providerId: selection.providerId,
            modelId: selection.modelId,
            options: {
              reasoningLevel: pickCheapestReasoningLevel(selection.reasoningLevels) ?? "none",
            },
          },
          messages: [
            { role: "system", content: PROACTIVE_SUGGESTION_SYSTEM_PROMPT },
            { role: "user", content: buildProactiveSuggestionPrompt(request) },
          ],
          querySource: QUERY_SOURCE,
          maxOutputTokens: PROACTIVE_SUGGESTION_MAX_OUTPUT_TOKENS,
          signal: controller.signal,
        });

        const normalized = normalizeProactiveSuggestion(generated.text);
        const latencyMs = Math.max(0, now() - startedAt);
        if (normalized.suggestion) {
          logger.debug(undefined, "Proactive suggestion completed", {
            requestId: request.requestId,
            latencyMs,
            suggestionChars: normalized.suggestion.length,
          });
        } else {
          logger.debug(undefined, "Proactive suggestion skipped", {
            requestId: request.requestId,
            reason: normalized.reason,
          });
        }
        return proactiveSuggestionResponseSchema.parse({
          requestId: request.requestId,
          suggestion: normalized.suggestion,
          reason: normalized.reason,
          latencyMs,
          modelUsed: {
            providerId: generated.selection.providerId,
            modelId: generated.selection.modelId,
          },
        });
      } catch (error) {
        const code =
          error instanceof ProactiveSuggestionError
            ? error.code
            : (entry.abortCode ?? (controller.signal.aborted ? "aborted" : "model_failed"));
        if (code === "aborted" || code === "timeout") {
          logger.debug(undefined, "Proactive suggestion cancelled", {
            requestId: request.requestId,
            code,
          });
        } else {
          logger.warn(undefined, "Proactive suggestion failed", {
            requestId: request.requestId,
            code,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (error instanceof ProactiveSuggestionError) throw error;
        const surfaced = code === "aborted" || code === "timeout" ? code : "model_failed";
        throw new ProactiveSuggestionError(
          surfaced,
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
      entry.controller.abort(new ProactiveSuggestionError("aborted", "cancelled"));
    },
  };
}
