import {
  collectE2EWebDriverPageHandleCandidates,
  type E2EBrowserTargetInfo,
} from "../e2e-window-target.js";

interface WindowInfo {
  id: number;
  title: string;
  visible: boolean;
  width: number;
  height: number;
  resizable: boolean;
  url: string;
}

export interface ElectronRendererContentSizeSnapshot {
  height: number;
  windowId: number;
  width: number;
}

type WorkspaceRendererSwitchResult =
  | { switched: true }
  | {
      switched: false;
      reason: string;
      currentUrl?: string | null;
      handleInspections?: Array<{
        currentHandle: string | null;
        currentUrl: string | null;
        error?: string;
        handle: string;
        targetUrl: string;
      }>;
      handles?: string[];
      target?: E2EBrowserTargetInfo | null;
      targets?: E2EBrowserTargetInfo[];
      windowUrl?: string | null;
      windows?: WindowInfo[];
      error?: string;
    };

export async function getAllWindowInfo(): Promise<WindowInfo[]> {
  return browser.electron.execute((electron) => {
    return electron.BrowserWindow.getAllWindows()
      .filter((win) => !win.isDestroyed())
      .map((win) => ({
        id: win.id,
        title: win.getTitle(),
        visible: win.isVisible(),
        width: win.getBounds().width,
        height: win.getBounds().height,
        resizable: win.isResizable(),
        url: win.webContents.getURL(),
      }));
  });
}

export async function setCurrentElectronRendererContentSize(
  width: number,
  height?: number,
): Promise<ElectronRendererContentSizeSnapshot> {
  const currentUrl = await browser.getUrl();
  const result = await browser.electron.execute(
    (electron, targetUrl, nextWidth, nextHeight) => {
      const target = electron.BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed() && candidate.webContents.getURL() === targetUrl,
      );
      if (!target) {
        return {
          ok: false as const,
          candidateUrls: electron.BrowserWindow.getAllWindows()
            .filter((candidate) => !candidate.isDestroyed())
            .map((candidate) => candidate.webContents.getURL()),
        };
      }

      const [originalWidth = 0, originalHeight = 0] = target.getContentSize();
      // 修复原因：ChromeDriver 的 window/rect 会调用 Electron 未实现的
      // Browser.getWindowForTarget；E2E 必须通过 Electron 权威窗口 API 调整 client viewport。
      target.setContentSize(nextWidth, nextHeight ?? originalHeight);
      target.focus();
      const [appliedWidth = 0, appliedHeight = 0] = target.getContentSize();
      return {
        ok: true as const,
        appliedHeight,
        appliedWidth,
        zoomFactor: target.webContents.getZoomFactor(),
        snapshot: {
          height: originalHeight,
          windowId: target.id,
          width: originalWidth,
        },
      };
    },
    currentUrl,
    width,
    height,
  );

  if (!result.ok) {
    throw new Error(
      `当前 WebDriver URL 没有精确匹配 Electron renderer 窗口: ${currentUrl}; candidates=${JSON.stringify(result.candidateUrls)}`,
    );
  }
  if (
    Math.abs(result.appliedWidth - width) > 1 ||
    (height !== undefined && Math.abs(result.appliedHeight - height) > 1)
  ) {
    await restoreElectronRendererContentSize(result.snapshot);
    throw new Error(
      `Electron renderer content size 没有应用: requested=${width}x${height ?? "preserve"}; applied=${result.appliedWidth}x${result.appliedHeight}`,
    );
  }

  const expectedRendererWidth = Math.round(result.appliedWidth / result.zoomFactor);
  const expectedRendererHeight = Math.round(result.appliedHeight / result.zoomFactor);
  let latestRendererViewport: { height: number; width: number } | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latestRendererViewport = await browser.execute(() => ({
          height: window.innerHeight,
          width: window.innerWidth,
        }));
        return (
          Math.abs(latestRendererViewport.width - expectedRendererWidth) <= 1 &&
          (height === undefined ||
            Math.abs(latestRendererViewport.height - expectedRendererHeight) <= 1)
        );
      },
      {
        timeout: 10000,
        timeoutMsg: `renderer viewport 没有收敛到 ${expectedRendererWidth}x${height === undefined ? "preserve" : expectedRendererHeight}`,
      },
    );
  } catch (error) {
    await restoreElectronRendererContentSize(result.snapshot);
    throw new Error(
      `renderer viewport 没有收敛: expected=${expectedRendererWidth}x${height === undefined ? "preserve" : expectedRendererHeight}; actual=${JSON.stringify(latestRendererViewport)}; zoomFactor=${result.zoomFactor}`,
      { cause: error },
    );
  }

  return result.snapshot;
}

export async function restoreElectronRendererContentSize(
  snapshot: ElectronRendererContentSizeSnapshot,
): Promise<void> {
  const result = await browser.electron.execute((electron, original) => {
    const target = electron.BrowserWindow.fromId(original.windowId);
    if (!target || target.isDestroyed()) {
      return { ok: true as const, windowMissing: true as const };
    }
    target.setContentSize(original.width, original.height);
    const [restoredWidth = 0, restoredHeight = 0] = target.getContentSize();
    return {
      ok:
        Math.abs(restoredWidth - original.width) <= 1 &&
        Math.abs(restoredHeight - original.height) <= 1,
      restoredHeight,
      restoredWidth,
      windowMissing: false as const,
    };
  }, snapshot);

  if (!result.ok) {
    throw new Error(
      `Electron renderer content size 恢复失败: expected=${snapshot.width}x${snapshot.height}; actual=${result.restoredWidth}x${result.restoredHeight}`,
    );
  }
}

export async function switchToWorkspaceRendererWindow(workspacePath: string, timeout = 10000) {
  let latestResult: WorkspaceRendererSwitchResult = {
    switched: false,
    reason: "not-started",
  };

  try {
    // 修复原因：Electron 启动初期 BrowserWindow 已创建，但 Chromedriver 看到的
    // WebDriver handle / CDP target 可能仍是 chrome-error 过渡页。这里按真实
    // BrowserWindow URL 重试切换，避免 conversation e2e 在错误 renderer 上找欢迎页。
    await browser.waitUntil(
      async () => {
        latestResult = await trySwitchToWorkspaceRendererWindow(workspacePath);
        return latestResult.switched;
      },
      {
        interval: 250,
        timeout,
        timeoutMsg: `未找到可切换的工作区 renderer target: ${workspacePath}`,
      },
    );
  } catch (error) {
    throw new Error(
      `未找到可切换的工作区 renderer target: ${workspacePath}\n诊断: ${JSON.stringify(
        latestResult,
        null,
        2,
      )}`,
      {
        cause: error,
      },
    );
  }
}

async function trySwitchToWorkspaceRendererWindow(
  workspacePath: string,
): Promise<WorkspaceRendererSwitchResult> {
  const windows = await getAllWindowInfo().catch((error: unknown) => ({
    error: serializeError(error),
  }));
  if (!Array.isArray(windows)) {
    return {
      switched: false,
      reason: "window-info-failed",
      error: windows.error,
    };
  }
  const windowUrl =
    windows.find((win) => isWorkspaceRendererUrl(win.url, workspacePath))?.url ??
    windows.find((win) => isRendererUrl(win.url))?.url ??
    null;

  if (!windowUrl) {
    return {
      switched: false,
      reason: "missing-renderer-window-url",
      windows,
    };
  }

  const targets = await getBrowserTargetInfo().catch(() => []);
  const handles = await browser.getWindowHandles().catch(() => []);
  const target =
    targets.find((item) => item.id && isExpectedRendererUrl(item.url, windowUrl, workspacePath)) ??
    null;
  const candidates = collectE2EWebDriverPageHandleCandidates(handles, targets).sort(
    (left, right) =>
      Number(isExpectedRendererUrl(right.targetUrl, windowUrl, workspacePath)) -
      Number(isExpectedRendererUrl(left.targetUrl, windowUrl, workspacePath)),
  );

  if (candidates.length === 0) {
    return {
      switched: false,
      reason: target?.id ? "renderer-target-not-in-webdriver-handles" : "missing-renderer-target",
      currentUrl: await getCurrentRendererUrl().catch(() => null),
      handles,
      target,
      targets,
      windowUrl,
      windows,
    };
  }

  const handleInspections: NonNullable<
    Exclude<WorkspaceRendererSwitchResult, { switched: true }>["handleInspections"]
  > = [];
  for (const candidate of candidates) {
    try {
      await browser.switchToWindow(candidate.handle);
      const currentHandle = await browser.getWindowHandle().catch(() => null);
      const currentUrl = await getCurrentRendererUrl().catch(() => null);
      handleInspections.push({
        currentHandle,
        currentUrl,
        handle: candidate.handle,
        targetUrl: candidate.targetUrl,
      });
      if (
        currentHandle === candidate.handle &&
        typeof currentUrl === "string" &&
        isExpectedRendererUrl(currentUrl, windowUrl, workspacePath)
      ) {
        setElectronWindowHandle(candidate.handle);
        return { switched: true };
      }
    } catch (error) {
      handleInspections.push({
        currentHandle: null,
        currentUrl: null,
        error: serializeError(error),
        handle: candidate.handle,
        targetUrl: candidate.targetUrl,
      });
    }
  }

  return {
    switched: false,
    reason: "webdriver-page-handle-url-mismatch",
    currentUrl: handleInspections.at(-1)?.currentUrl ?? null,
    handleInspections,
    handles,
    target,
    targets,
    windowUrl,
    windows,
  };
}

async function switchToHandle(handle: string) {
  await browser.switchToWindow(handle);
  setElectronWindowHandle(handle);
}

function setElectronWindowHandle(handle: string) {
  (browser.electron as typeof browser.electron & { windowHandle?: string }).windowHandle = handle;
}

export async function getBrowserTargetInfo(): Promise<E2EBrowserTargetInfo[]> {
  const puppeteer = await browser.getPuppeteer();
  return puppeteer.targets().map((target) => ({
    id: (target as unknown as { _targetId?: string })._targetId ?? null,
    type: target.type(),
    url: target.url(),
  }));
}

async function getCurrentRendererUrl() {
  return browser.execute(() => window.location.href);
}

function serializeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isExpectedRendererUrl(currentUrl: string, windowUrl: string, workspacePath: string) {
  return currentUrl === windowUrl || isWorkspaceRendererUrl(currentUrl, workspacePath);
}

function isRendererUrl(url: string) {
  try {
    // 修复原因：E2E 会把 out 复制到 runId/app，renderer 身份不能再绑定共享 out 路径。
    return new URL(url).pathname.endsWith("/renderer/index.html");
  } catch {
    return false;
  }
}

function isWorkspaceRendererUrl(url: string, workspacePath: string) {
  try {
    const parsed = new URL(url);
    return (
      parsed.pathname.endsWith("/renderer/index.html") &&
      parsed.searchParams.get("initialWorkspacePath") === workspacePath
    );
  } catch {
    return false;
  }
}

export async function switchToNewestWindow() {
  const handles = await browser.getWindowHandles();
  const newestHandle = handles.at(-1);

  if (!newestHandle) {
    throw new Error("当前没有可切换的窗口句柄");
  }

  await switchToHandle(newestHandle);
}
