import type { ModelOptionSpecs, ModelSelection } from "@zcode/contracts";

/**
 * Declared static model facts, readable BEFORE a `Model` exists.
 *
 * Why this port must exist: `modelFactory` validates the selection and throws
 * `reasoning-level-missing` exactly when `selection.options.reasoningLevel` is absent. So
 * "build a Model to learn which reasoning level is allowed" cannot work — the level is needed
 * to pass the validation that would reveal it. That cycle was swallowed by a bare `catch`
 * returning empty options, the mirror request then failed for a second reason, and the gate
 * reported it as "tools unsupported" and retried WITHOUT tools, which is why the fallback
 * model answered with text and executed nothing.
 *
 * Declared facts have no cycle: they come from the registry, not from a Model instance.
 */
export interface RuntimeModelFactsPort {
  /** Declared option range; `undefined` when this registry has no such selection. */
  optionSpecs(selection: ModelSelection): ModelOptionSpecs | undefined;
  /**
   * Whether the model declares tool-call support. `undefined` means the fact is absent;
   * an absent fact never proves the capability is missing.
   */
  supportsToolCall(selection: ModelSelection): boolean | undefined;
}

/**
 * A model-selection or request-shape protocol error — not a provider refusing tools.
 *
 * The distinction is load-bearing: the takeover gate used to retry ANY mirror failure without
 * tools. A `reasoning-level-missing` rejection is a malformed request; dropping tools does not
 * fix it and guarantees the fallback answers with text instead of doing the work.
 */
export function isModelSelectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  if (candidate.name !== "ModelProtocolError") return false;
  return candidate.code === "invalid_model_request" || candidate.code === "invalid_model_selection";
}

/**
 * The provider rejected the tools themselves, which is the only case where retrying WITHOUT
 * tools makes sense. Transport, timeout, auth, quota and cancellation are unrelated to tools,
 * so dropping them there would produce a text answer in place of real work.
 *
 * The signal is taken from the provider's own answer text, never from the exception's shape:
 * absence of evidence is not evidence that tools are unsupported.
 */
export function isToolsRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; message?: unknown; code?: unknown };
  if (candidate.name === "AbortError" || candidate.code === "model_request_timeout") return false;
  if (
    candidate.code === "model_rate_limited" ||
    candidate.code === "model_request_auth_missing" ||
    candidate.code === "model_context_exceeded" ||
    candidate.code === "OPENCODE_FREE_LIMIT_REACHED"
  ) {
    return false;
  }
  if (typeof candidate.message !== "string") return false;
  const text = candidate.message.toLowerCase();
  return (
    (text.includes("tool") || text.includes("function")) &&
    (text.includes("not supported") ||
      text.includes("unsupported") ||
      text.includes("unrecognized") ||
      text.includes("not allowed") ||
      text.includes("does not support"))
  );
}
