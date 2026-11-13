import { useCallback } from "react";
import { useAppChromeState } from "@/app-shell/useAppChromeState.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { resolveTheme } from "@/useTheme.js";

/**
 * Chrome и тема App: desktop window controls, fullscreen-состояние, update-статус
 * и переключение светлой/тёмной темы.
 */
export function useAppRootChrome({
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  workspaceAbsPath,
}: {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  workspaceAbsPath: string;
}) {
  const platform = usePlatform();
  const theme = useZCodeStore((s) => s.theme);
  const setTheme = useZCodeStore((s) => s.setTheme);
  const chromeState = useAppChromeState({
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    platform,
    workspaceAbsPath,
  });
  const themeTarget: "dark" | "light" = resolveTheme(theme) === "dark" ? "light" : "dark";
  const handleSwitchTheme = useCallback(() => {
    setTheme(themeTarget);
  }, [setTheme, themeTarget]);

  return {
    ...chromeState,
    theme,
    setTheme,
    themeTarget,
    handleSwitchTheme,
  };
}
