import { useMemo } from "react";
import { type ZCodeApiRetryStatus } from "@zcode/shared";
import { TID_CHAT_LOADING } from "@zcode/shared/test-ids";
import type { ApiRetryState } from "@zcode/shared/zcode-protocol-v4";
import { ChatLoading } from "@/components/ai-elements/chat-loading.js";
import { ChatApiRetryStatus } from "@/chat-input-toolbar/display.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const MIN_VISIBLE_API_RETRY_ATTEMPT = 3;

function toRetryStatus(apiRetry: ApiRetryState): ZCodeApiRetryStatus {
  const attempt = Math.max(1, Math.floor(apiRetry.attempt));
  // v4 maxAttempts 包含首次请求，而展示口径是重试次数；直接展示会把
  // 默认 10 次重试写成 1/11。
  const maxRetries = Math.max(Math.floor(apiRetry.maxAttempts) - 1, attempt);
  return {
    kind: "api_retry",
    attempt,
    maxRetries,
    retryDelayMs: 0,
    errorStatus: null,
    error: apiRetry.reasonCode,
  };
}

/** 轮底进度槽：provider fallback 提示、可见 retry 计数与普通 ChatLoading 的单一出口。 */
export function TurnChatLoadingSlot({
  apiRetry,
  eligible,
}: {
  apiRetry: ApiRetryState | null;
  eligible: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  const retryStatus = useMemo(() => (apiRetry ? toRetryStatus(apiRetry) : null), [apiRetry]);
  // 前两次短暂恢复对用户等价于普通加载；保留 apiRetry 运行态，但只在
  // 第三次重试开始后显示计数。必须在 retry/loading 分支前收敛，否则会留下空 slot，
  // 而不是回退到 ChatLoading。
  const visibleRetryStatus =
    retryStatus && retryStatus.attempt >= MIN_VISIBLE_API_RETRY_ATTEMPT ? retryStatus : null;
  const providerFallback = apiRetry?.providerFallback;
  const fallbackMessageId =
    providerFallback?.reason === "free_usage_limit"
      ? "chat.providerFallback.freeUsageLimit"
      : providerFallback?.reason === "insufficient_balance"
        ? "chat.providerFallback.insufficientBalance"
        : providerFallback?.reason === "retry_after_exceeded"
          ? "chat.providerFallback.retryAfterExceeded"
          : "chat.providerFallback.notice";
  if (!visibleRetryStatus && !eligible && !providerFallback) return null;
  return (
    <div data-zcode-chat-loading-slot="true" className="min-h-5">
      {providerFallback ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <ChatLoading loading data-testid={TID_CHAT_LOADING} size="sm" />
          <span>
            {intl.formatMessage(
              { id: fallbackMessageId },
              { from: providerFallback.from, to: providerFallback.to },
            )}
          </span>
        </div>
      ) : visibleRetryStatus ? (
        <ChatApiRetryStatus apiRetry={visibleRetryStatus} intl={intl} locale={locale} />
      ) : (
        // running 是 ChatLoading 的权威事实；额外静默计时会让 projection
        // 更新反复重启可见性，并使 UI 晚于真实状态。
        <ChatLoading loading data-testid={TID_CHAT_LOADING} size="sm" />
      )}
    </div>
  );
}
