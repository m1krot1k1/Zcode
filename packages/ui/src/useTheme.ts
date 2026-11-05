import { useZCodeStoreWithDefault } from "./store/StoreProvider.js";
import { applyTheme, normalizeThemePreference, type Theme } from "./theme.js";

export type { ResolvedTheme, Theme } from "./theme.js";
export { applyTheme, isTheme, normalizeThemePreference, resolveTheme } from "./theme.js";

const DEFAULT_THEME: Theme = "zai-dark";

function applyFallbackTheme(next: Theme): void {
  applyTheme(normalizeThemePreference(next));
}

/**
 * 兼容旧调用方的 hook：主题的唯一所有者是 Zustand store。
 * 这里不再维护第二份 localStorage/state，避免两个入口写同一个键。
 * 没有 StoreProvider（单测、嵌入式消费者）时返回稳定默认值并直接应用 DOM 主题，
 * 而不是抛错。
 */
export function useTheme() {
  const theme = useZCodeStoreWithDefault((state) => state.theme, DEFAULT_THEME);
  const setTheme = useZCodeStoreWithDefault((state) => state.setTheme, applyFallbackTheme);
  return { theme, setTheme } as const;
}
