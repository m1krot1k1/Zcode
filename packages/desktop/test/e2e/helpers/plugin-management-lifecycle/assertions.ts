import {
  DEFAULT_WORKSPACE,
  setCurrentElectronRendererContentSize,
  waitForWorkspaceApp,
} from "../desktop-app.js";

export async function setPluginPresentation(input: {
  locale: "zh-CN" | "en-US";
  theme: "zai-light" | "zai-dark";
  width: number;
  height: number;
}): Promise<void> {
  await setCurrentElectronRendererContentSize(input.width, input.height);
  await browser.executeAsync((next, done: (result?: string) => void) => {
    const actions = (
      window as typeof window & {
        __testActions?: Record<string, unknown>;
      }
    ).__testActions;
    const setLocale = actions?.setLocale;
    const setTheme = actions?.setTheme;
    if (typeof setLocale !== "function" || typeof setTheme !== "function") {
      done("missing locale/theme test action");
      return;
    }
    (setLocale as (value: string) => void)(next.locale);
    (setTheme as (value: string) => void)(next.theme);
    requestAnimationFrame(() => done());
  }, input);
}

export async function assertPluginStoreFitsViewport(): Promise<void> {
  const layout = await browser.execute(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="plugin-store-root"]');
    return {
      clientWidth: root?.clientWidth ?? 0,
      scrollWidth: root?.scrollWidth ?? 0,
      viewportWidth: window.innerWidth,
    };
  });
  expect(layout.clientWidth).toBeGreaterThan(0);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
  expect(layout.clientWidth).toBeLessThanOrEqual(layout.viewportWidth);
}

export async function restartPluginLifecycleApp(): Promise<void> {
  await browser.reloadSession();
  await browser.waitUntil(
    async () => {
      try {
        return (await browser.getUrl()).startsWith("file://");
      } catch {
        return false;
      }
    },
    {
      timeout: 60000,
      timeoutMsg: "Electron renderer did not recover after reloadSession",
    },
  );
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60000);
}
