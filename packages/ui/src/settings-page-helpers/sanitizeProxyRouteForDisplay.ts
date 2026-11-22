/**
 * 代理地址展示值：只暴露 scheme 与 host，不泄漏代理凭据和 URL 附加信息。
 *
 * 从 `settingsPageHelpers.tsx` 拆出，保持原有导出名与行为不变；
 * 归并到 `settings-page-helpers/` 后单文件不再需要 max-lines 例外。
 */

/** UI route labels reveal only scheme and endpoint, never proxy credentials or URL extras. */
export function sanitizeProxyRouteForDisplay(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
    if (!["http:", "https:", "socks:", "socks5:", "socks5h:"].includes(url.protocol)) {
      return undefined;
    }
    return `${url.protocol}//${url.host}`;
  } catch {
    // Never fall back to showing the original string: legacy proxy formats can contain secrets.
    return undefined;
  }
}
