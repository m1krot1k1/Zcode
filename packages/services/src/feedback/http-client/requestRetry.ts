import { isRetryableConnectionEstablishmentError } from "#src/providers/api/networkErrorClassifier.js";

export async function requestWithHandshakeRetry(
  request: () => Promise<Response>,
  onRetry?: (event: { attempt: number; nextAttempt: number; error: unknown }) => void,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      // Cloudflare/本机代理链路偶发 TLS 握手或 Undici 建连阶段失败。
      // 请求还没稳定到达后端时允许多次短重试；即使请求已收口到 ApiClient，
      // 这里仍保留反馈接口自己的轻量重试，避免“我的反馈”等轻量请求直接显示 fetch failed。
      if (attempt >= 3 || !isRetryableConnectionEstablishmentError(error)) {
        break;
      }
      onRetry?.({ attempt, nextAttempt: attempt + 1, error });
      await delay(300 * attempt);
    }
  }
  throw lastError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
