import {
  TAKEOVER_HTTP_TIMEOUT_MS,
  TAKEOVER_REFUSAL_REASONS,
  type TakeoverFetch,
  type TakeoverRequestBody,
} from "./contract.js";
import { normalizeFinishReason } from "./detect.js";

const REFUSAL_REASONS: ReadonlySet<string> = new Set(TAKEOVER_REFUSAL_REASONS);

export type TakeoverAttemptOutcome =
  | { kind: "done"; content: string; finishReason?: string }
  | { kind: "refused"; reason: string }
  | { kind: "error"; reason: string };

/** Production fetch: `redirect: "error"` prevents the key from following a redirect. */
export const defaultTakeoverFetch: TakeoverFetch = (input, init) => {
  const nativeFetch = (
    globalThis as {
      fetch?: (
        url: string,
        init: {
          method: string;
          headers: Record<string, string>;
          body: string;
          redirect: "error";
          signal: AbortSignal;
        },
      ) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
    }
  ).fetch;
  if (!nativeFetch) {
    return Promise.reject(new Error("fetch is not available in this runtime"));
  }
  return nativeFetch(input, init);
};

function combineSignals(
  external: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

function requestHeaders(apiKey: string | null | undefined): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // Empty keys are valid for local OpenAI-compatible endpoints; no header in that case.
  if (typeof apiKey === "string" && apiKey.trim().length > 0) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function parseAttemptBody(bodyText: string): TakeoverAttemptOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { kind: "error", reason: "invalid-json" };
  }
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return { kind: "error", reason: "invalid-json" };
  }
  const first = choices[0] as {
    message?: { content?: unknown };
    finish_reason?: unknown;
  };
  const finishReason = normalizeFinishReason(
    typeof first.finish_reason === "string" ? first.finish_reason : undefined,
  );
  if (finishReason && REFUSAL_REASONS.has(finishReason)) {
    return { kind: "refused", reason: finishReason };
  }
  const content = first.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    return { kind: "error", reason: "empty-content" };
  }
  return {
    kind: "done",
    content,
    ...(finishReason ? { finishReason } : {}),
  };
}

/** Exactly one attempt; no retries, 60s timeout, only status/category ever logged. */
export async function attemptTakeoverModel(input: {
  apiUrl: string;
  apiKey: string | null | undefined;
  modelId: string;
  body: TakeoverRequestBody;
  fetch: TakeoverFetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<TakeoverAttemptOutcome> {
  // Настройки принимают и полный chat-endpoint, и базовый OpenAI-совместимый URL
  // (`…/api/v1`): без второго вида запрос уходил в корень и получал 404.
  const endpoint = /\/chat\/completions\/?$/u.test(input.apiUrl.trim())
    ? input.apiUrl.trim()
    : `${input.apiUrl.trim().replace(/\/+$/u, "")}/chat/completions`;
  const { signal, dispose } = combineSignals(
    input.signal,
    input.timeoutMs ?? TAKEOVER_HTTP_TIMEOUT_MS,
  );
  try {
    const response = await input.fetch(endpoint, {
      method: "POST",
      headers: requestHeaders(input.apiKey),
      body: JSON.stringify(input.body),
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      return { kind: "error", reason: `http-${response.status}` };
    }
    const text = await response.text();
    return parseAttemptBody(text);
  } catch {
    if (input.signal?.aborted) return { kind: "error", reason: "cancelled" };
    if (signal.aborted) return { kind: "error", reason: "timeout" };
    return { kind: "error", reason: "network" };
  } finally {
    dispose();
  }
}
