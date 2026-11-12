/**
 * 首 token 看门狗。
 *
 * 背景：`readNextWithStreamIdleTimeout` 只对每次 `next()` 施加 idle 超时（默认 600s），
 * 它无法区分“provider 一直没吐第一个 token”和“流到一半变慢”。因此在缺少首 token 时，
 * UI 会静默悬挂十分钟（叠加既有重试可长达数小时），用户无从判断请求是否还在工作。
 *
 * 看门狗只负责一件事：`model.request.started` 之后若在 `firstTokenTimeoutMs` 内没有任何
 * provider 输出，就用带类型的错误中止本次 attempt 的 AbortController；随后的重试、
 * 预算和最终错误码由既有 retry 逻辑与 failure classifier 决定。
 *
 * 约束：不改变 mid-stream 的 idle 超时（600s），也不改变重试次数。
 */


export { DEFAULT_MODEL_FIRST_TOKEN_TIMEOUT_MS } from "@zcode/contracts";

/** 与 `ModelErrorCode.FirstTokenTimeout` 保持一致。 */
const MODEL_FIRST_TOKEN_TIMEOUT_CODE = "first_token_timeout";

export class ModelFirstTokenTimeoutError extends Error {
  readonly code = MODEL_FIRST_TOKEN_TIMEOUT_CODE;

  constructor(readonly timeoutMs: number) {
    super(
      `Model first token timeout: no content or reasoning delta received within ${timeoutMs}ms.`,
    );
    this.name = "ModelFirstTokenTimeoutError";
  }
}

export function isModelFirstTokenTimeoutError(
  error: unknown,
): error is ModelFirstTokenTimeoutError {
  return error instanceof ModelFirstTokenTimeoutError;
}

export interface FirstTokenWatchdog {
  /** 幂等；首个 provider 输出到达或 attempt 结束时调用。 */
  cancel(): void;
}

interface FirstTokenWatchdogOptions {
  /** <=0 或非有限值时关闭看门狗（用于显式退出）。 */
  timeoutMs: number;
  controller: Pick<AbortController, "abort" | "signal">;
}

/**
 * 启动看门狗。触发时先清理计时器再 abort，避免同一次 attempt 内重复中止，
 * 也避免 90s 的计时器在 attempt 结束后继续挂在事件循环上。
 */
export function createFirstTokenWatchdog(
  options: FirstTokenWatchdogOptions,
): FirstTokenWatchdog {
  const { timeoutMs, controller } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { cancel: () => {} };
  }

  let cancelled = false;
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    clearTimeout(timer);
  };
  const timer = setTimeout(() => {
    cancel();
    if (!controller.signal.aborted) {
      controller.abort(new ModelFirstTokenTimeoutError(timeoutMs));
    }
  }, timeoutMs);
  // Node 下不要让待触发的看门狗单独吊住进程；浏览器环境没有 unref。
  (timer as unknown as { unref?: () => void }).unref?.();

  return { cancel };
}

/**
 * 是否属于“provider 已经产出东西”的流事件。除了文本/推理增量，工具调用与结束事件
 * 同样证明连接是活的，否则会在“模型直接调工具”或极短回答时误杀正常请求。
 */
const FIRST_TOKEN_OUTPUT_PART_TYPES = new Set([
  "text-delta",
  "reasoning-delta",
  "tool-call",
  "tool-input-start",
  "tool-input-delta",
  "finish",
  "error",
]);

export function isFirstTokenOutputPart(part: { type?: string } | undefined): boolean {
  return typeof part?.type === "string" && FIRST_TOKEN_OUTPUT_PART_TYPES.has(part.type);
}
