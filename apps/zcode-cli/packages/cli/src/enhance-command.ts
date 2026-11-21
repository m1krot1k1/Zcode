import {
  PROMPT_ENHANCE_MAX_DRAFT_CHARS,
  PromptEnhanceError,
  buildMentionViolationFeedback,
  buildPromptEnhancerSystemPrompt,
  buildPromptEnhancerUserMessage,
  classifyPromptEnhanceTask,
  extractPromptMentions,
  findMissingPromptMentions,
  formatPromptEnhanceMentions,
  parseEnhancedPromptResponse,
  promptEnhanceRequestSchema,
  type PromptEnhanceRequest,
  type PromptEnhanceResult,
} from "@zcode/shared";
import type { ModelSelection } from "@zcode/shared";
import type { AgentRuntime } from "@zcode/core";

/**
 * `/enhance` в CLI.
 *
 * Работает в интерактивном TUI и в неинтерактивном `-p` режиме: оба пути идут через
 * `AgentRuntime.generateWorkspaceText`, поэтому используют ту же модель, auth и admission,
 * что и основной агент, и не создают второй клиент модели. Текст мета-промпта и разбор
 * ответа берутся из `@zcode/shared`, чтобы Host-сервис и CLI не расходились.
 *
 * Улучшенный текст **не отправляется** агенту автоматически: команда возвращает его,
 * а решение отправить/скопировать принимает пользователь. Это защищает от случайного
 * исполнения изменённого намерения.
 */

const QUERY_SOURCE = "prompt_enhance";
const MAX_ENHANCER_OUTPUT_TOKENS = 4_096;

export interface RunEnhanceCommandOptions {
  runtime: Pick<AgentRuntime, "generateWorkspaceText" | "getSessionModelSelection">;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId?: string;
  /** Абсолютный/относительный таймаут; по умолчанию 90 секунд. */
  timeoutMs?: number;
  /** Внешняя отмена из TUI/PromptCommandCenter; комбинируется с таймаутом. */
  abortSignal?: AbortSignal;
}

export interface EnhanceCommandOutcome {
  enhancedText: string;
  result: PromptEnhanceResult;
  /** Сработал ли второй проход восстановления protected mentions. */
  repairedMentions: boolean;
}

let counter = 0;
function createRequestId(): string {
  counter += 1;
  return `enh_cli_${Date.now().toString(36)}_${counter}`;
}

/** Грубая оценка токенов, согласованная с рантаймом (символ/токен ≈ 4). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function resolveSelection(
  runtime: RunEnhanceCommandOptions["runtime"],
): ModelSelection | undefined {
  const selection = runtime.getSessionModelSelection();
  return selection ? structuredClone(selection) : undefined;
}

export async function runEnhanceCommand(
  draftText: string,
  options: RunEnhanceCommandOptions,
): Promise<EnhanceCommandOutcome> {
  const trimmed = draftText.trim();
  if (trimmed.length < 2) {
    throw new PromptEnhanceError("invalid_request", "Provide text to enhance: /enhance <text>");
  }
  const selection = resolveSelection(options.runtime);
  if (!selection) {
    throw new PromptEnhanceError(
      "model_unavailable",
      "No session model is selected. Use /model or log in before /enhance.",
    );
  }

  const request: PromptEnhanceRequest = promptEnhanceRequestSchema.parse({
    requestId: createRequestId(),
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    target: "chat_user_prompt",
    style: "structured_engineering",
    draftText: trimmed.slice(0, PROMPT_ENHANCE_MAX_DRAFT_CHARS),
    // CLI не получает структурированные вложения; извлекаем `@file`/`$skill` из текста,
    // иначе модель может молча удалить ссылку на файл и проверка mentions станет no-op.
    preservedMentions: extractPromptMentions(trimmed),
    activeFilePaths: [],
  });

  const abortSignal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, AbortSignal.timeout(options.timeoutMs ?? 90_000)])
    : AbortSignal.timeout(options.timeoutMs ?? 90_000);
  const classification = classifyPromptEnhanceTask({
    draftText: request.draftText,
    target: request.target,
    ...(request.collaborationMode ? { collaborationMode: request.collaborationMode } : {}),
  });
  const systemPrompt = buildPromptEnhancerSystemPrompt(request, classification);
  const userMessage = buildPromptEnhancerUserMessage({
    draftText: request.draftText,
    mentions: formatPromptEnhanceMentions(request),
    activeFiles: "None",
    contextSections: [],
  });

  const generate = async (messages: Array<{ role: "system" | "user" | "assistant"; content: string }>) =>
    await options.runtime.generateWorkspaceText(
      {
        selection,
        messages,
        querySource: QUERY_SOURCE,
        maxOutputTokens: MAX_ENHANCER_OUTPUT_TOKENS,
      },
      { abortSignal },
    );

  let generated = await generate([
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ]);
  let parsed = parseEnhancedPromptResponse(generated.text);
  let missing = findMissingPromptMentions(parsed.enhancedText, request);
  let repairedMentions = false;
  if (missing.length > 0) {
    const repair = await generate([
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
      { role: "assistant", content: generated.text },
      { role: "user", content: buildMentionViolationFeedback(missing) },
    ]);
    parsed = parseEnhancedPromptResponse(repair.text);
    missing = findMissingPromptMentions(parsed.enhancedText, request);
    repairedMentions = missing.length === 0;
    if (missing.length > 0) {
      throw new PromptEnhanceError(
        "unsupported_changes",
        `Enhancer dropped protected markers: ${missing.join(", ")}`,
      );
    }
    generated = repair;
  }

  const before = estimateTokens(request.draftText);
  const after = estimateTokens(parsed.enhancedText);
  return {
    enhancedText: parsed.enhancedText,
    repairedMentions,
    result: {
      requestId: request.requestId,
      enhancedText: parsed.enhancedText,
      style: request.style,
      framework: classification.framework,
      domain: classification.domain,
      taskKind: classification.taskKind,
      addedClarifications: parsed.addedClarifications,
      assumptions: parsed.assumptions,
      capabilitySuggestions: parsed.capabilitySuggestions.map((suggestion) => ({
        ...suggestion,
        requiresConsent: true,
      })),
      usedContext: [],
      modelUsed: {
        providerId: generated.selection.providerId,
        modelId: generated.selection.modelId,
      },
      tokenDelta: { before, after, method: "char-ratio" },
      elapsedMs: 0,
    },
  };
}

/** Человекочитаемый вывод для TUI и неинтерактивного `-p`. */
export function formatEnhanceOutcome(outcome: EnhanceCommandOutcome): string {
  const lines = ["Enhanced prompt:", "", outcome.enhancedText];
  lines.push(
    "",
    `Framework: ${outcome.result.framework.toUpperCase()} · domain: ${outcome.result.domain} · task: ${outcome.result.taskKind}`,
  );
  if (outcome.result.addedClarifications.length > 0) {
    lines.push("", "Added clarifications:", ...outcome.result.addedClarifications.map((item) => `- ${item}`));
  }
  if (outcome.result.assumptions.length > 0) {
    lines.push(
      "",
      "Assumptions:",
      ...outcome.result.assumptions.map((item) => `- (${item.origin}) ${item.text}`),
    );
  }
  lines.push(
    "",
    `Model: ${outcome.result.modelUsed.providerId}/${outcome.result.modelUsed.modelId}`,
    `Tokens: ${outcome.result.tokenDelta.before} -> ${outcome.result.tokenDelta.after}`,
  );
  return lines.join("\n");
}
