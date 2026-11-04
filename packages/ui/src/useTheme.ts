import { useZCodeStore } from "./store/StoreProvider.js";

export type { ResolvedTheme, Theme } from "./theme.js";
export { applyTheme, isTheme, normalizeThemePreference, resolveTheme } from "./theme.js";

/**
 * 兼容旧调用方的 hook：主题的唯一所有者是 Zustand store。
 * 这里不再维护第二份 localStorage/state，避免两个入口写同一个键。
 */
export function useTheme() {
  const theme = useZCodeStore((state) => state.theme);
  const setTheme = useZCodeStore((state) => state.setTheme);
  return { theme, setTheme } as const;
}
