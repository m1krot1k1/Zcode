import type { Theme } from "@zcode/ui";

import {
  resolveWebRemoteControlInitialTheme,
  WEB_REMOTE_CONTROL_DEFAULT_THEME,
} from "#src/web-remote-control/index.js";

import { isConversationSharePath } from "../share/conversationShareRoute.js";

export function resolveWebThemePreference(
  defaultTheme: Theme = WEB_REMOTE_CONTROL_DEFAULT_THEME,
): Theme {
  const saved = localStorage.getItem("zcode-theme");
  return resolveWebRemoteControlInitialTheme({
    storedTheme: saved,
    defaultTheme,
  });
}

// 初始化主题：默认 Zai dark，后续由 useTheme hook 接管
// system 模式下需要查询系统偏好；非 system 模式直接用存储值
export function applyInitialWebThemePreference(): void {
  // 分享页没有本地主题配置时使用浅色，已有配置仍然沿用；其他 Web 页面继续默认深色。
  const saved = resolveWebThemePreference(
    isConversationSharePath(window.location.pathname) ? "zai-light" : undefined,
  );
  const resolved =
    saved === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : saved === "dark" || saved === "zai-dark"
        ? "dark"
        : "light";
  const appliedTheme =
    saved === "system"
      ? resolved === "dark"
        ? "zai-dark"
        : "zai-light"
      : saved === "dark"
        ? "zai-dark"
        : saved === "light"
          ? "zai-light"
          : saved;
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.classList.toggle(
    "theme-zai-light",
    appliedTheme === "zai-light",
  );
  document.documentElement.classList.toggle(
    "theme-zai-dark",
    appliedTheme === "zai-dark",
  );
}

export function isZhLocale(): boolean {
  return /^zh\b/i.test(navigator.language);
}
