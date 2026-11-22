import { useCallback } from "react";

/** 分享页外链白名单：只放行 http(s) 且排除本机地址，其余保持不可操作。 */
export function useOpenShareExternalUrl(): (url: string) => void {
  return useCallback((url: string) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      if (/^(localhost|127\..*|0\.0\.0\.0|\[::1\])$/iu.test(parsed.hostname))
        return;
      window.open(parsed.toString(), "_blank", "noopener,noreferrer");
    } catch {
      // 外链来自不可信 Markdown；解析失败时保持不可操作，不交给浏览器未知协议。
    }
  }, []);
}
