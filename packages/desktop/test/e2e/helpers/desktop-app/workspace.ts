import { access } from "node:fs/promises";
import {
  TID_COMPOSER_WORKSPACE_TRIGGER,
  TID_V4_SESSION_PANE,
  TID_WORKSPACE_PATH,
} from "@zcode/shared/test-ids";
import { dismissOccupationOnboarding } from "../occupation-onboarding.js";
import { projectSectionSelector } from "../project-sidebar.js";
import { DEFAULT_WORKSPACE } from "./paths.js";
import {
  getBrowserTargetInfo,
  getAllWindowInfo,
  switchToWorkspaceRendererWindow,
} from "./windows.js";

export interface WorkspaceAppProbeParams {
  workspacePathTestId: string;
  workspaceItemTestId: string;
  sessionPanePrefix: string;
  composerWorkspaceTriggerTestId: string;
  expectedPath: string;
}

// 在 renderer 内执行（browser.execute 序列化），不能引用模块作用域变量。
export function probeWorkspaceAppState(
  params: WorkspaceAppProbeParams,
): "ready" | "onboarding" | "pending" {
  // 修复原因：职业引导在“无作答记录且本机无 Task”时自动展示，E2E 每个 worker 都是
  // 全新隔离 HOME，必然命中；引导判定完成前 Root 不渲染主界面、展示时整页替换主界面，
  // 两者互斥，所以这里如实上报 onboarding，由调用方走真实 UI 关闭后继续等待工作区。
  if (document.querySelector('[data-testid="onboarding-page"]')) {
    return "onboarding";
  }

  const pathBadge = document.querySelector<HTMLElement>(
    `[data-testid="${params.workspacePathTestId}"]`,
  );
  if (pathBadge?.dataset.workspaceAbsPath === params.expectedPath) {
    return "ready";
  }

  // 修复原因：API Key 登录后进入空任务态时，主区域只展示新任务草稿，
  // 不一定渲染 WorkspaceHeader 的路径徽标。此时侧栏工作区项和会话 pane
  // 同时存在，才代表用户已经进入可操作的目标工作区。
  // 修复原因：Windows workspacePath 会进入 data-testid，反斜杠直接拼到
  // CSS attribute selector 会被当作转义字符，导致 DOM 里有元素也查不到。
  const workspaceItem =
    (
      window as Window & {
        __zcodeTabStoreE2E?: { getState(): { activeWorkspacePath?: string | null } };
      }
    ).__zcodeTabStoreE2E?.getState().activeWorkspacePath === params.expectedPath;
  const conversationWorkspaceReady =
    params.expectedPath.replace(/\\/g, "/").endsWith("/.zcode/workspace/default") &&
    Boolean(document.querySelector(`[data-testid="${params.composerWorkspaceTriggerTestId}"]`));
  // v4 硬切后聊天区是 v4 session pane（testid 带 paneId 后缀，用前缀匹配）。
  return (workspaceItem || conversationWorkspaceReady) &&
    document.querySelector(`[data-testid^="${params.sessionPanePrefix}-"]`)
    ? "ready"
    : "pending";
}

// Bugfix: WorkspaceHeader 里的 TID_WORKSPACE_TITLE 现在展示的是 activeTaskTitle，
// 不再稳定代表当前工作区名。路径徽标的上下文改由 tooltip 承载，改读 data-workspace-abs-path。
// 虚拟项目侧栏不再渲染真实目录节点，新建任务草稿下以 tab store 的导航 owner + 可见
// session pane 判定，覆盖默认工作区自动打开及多标签切换。
export async function waitForWorkspaceApp(workspacePath: string, timeout = 10000) {
  const timeoutMsg = `主界面没有切到工作区: ${workspacePath}`;
  const probeParams: WorkspaceAppProbeParams = {
    workspacePathTestId: TID_WORKSPACE_PATH,
    workspaceItemTestId: "virtual-project-row",
    sessionPanePrefix: TID_V4_SESSION_PANE,
    composerWorkspaceTriggerTestId: TID_COMPOSER_WORKSPACE_TRIGGER,
    expectedPath: workspacePath,
  };

  try {
    await browser.waitUntil(
      async () => {
        const state = await browser.execute(probeWorkspaceAppState, probeParams);
        if (state === "onboarding") {
          // Bug 根因：此前只有 v4 helper 先跳过引导，conversation-session、automations、
          // smoke 等走本函数的 spec 会被引导页挡满 30s 后失败。关闭后由下一轮轮询确认工作区。
          await dismissOccupationOnboarding();
          return false;
        }
        return state === "ready";
      },
      {
        timeout,
        timeoutMsg,
      },
    );
  } catch (error) {
    // 修复原因：e2e 曾经只报等待超时，真实白屏原因藏在 renderer 状态里。
    // 失败时附带当前 DOM、窗口和存储摘要，后续 case 卡住能直接定位初始化边界。
    throw new Error(`${timeoutMsg}\n${await collectWorkspaceDiagnostics(workspacePath)}`, {
      cause: error,
    });
  }
}

async function isWorkspaceAppVisible(workspacePath: string) {
  try {
    return await browser.execute(
      (workspacePathTestId, sessionPanePrefix, expectedPath) => {
        if (
          (
            window as Window & {
              __zcodeTabStoreE2E?: { getState(): { activeWorkspacePath: string | null } };
            }
          ).__zcodeTabStoreE2E?.getState().activeWorkspacePath === expectedPath &&
          document.querySelector(`[data-testid^="${sessionPanePrefix}-"]`)
        )
          return true;
        const pathBadge = document.querySelector<HTMLElement>(
          `[data-testid="${workspacePathTestId}"]`,
        );
        return pathBadge?.dataset.workspaceAbsPath === expectedPath;
      },
      TID_WORKSPACE_PATH,
      TID_V4_SESSION_PANE,
      workspacePath,
    );
  } catch {
    // Bugfix: browser.reloadSession 后 WebDriver/CDP 会短暂断链；workspace
    // 等待应把这类“还没连上”当作未就绪，而不是提前失败。
    return false;
  }
}

export async function getActiveWorkspacePath() {
  return browser.execute((workspacePathTestId) => {
    const pathBadge = document.querySelector<HTMLElement>(`[data-testid="${workspacePathTestId}"]`);
    return pathBadge?.dataset.workspaceAbsPath ?? null;
  }, TID_WORKSPACE_PATH);
}

async function collectWorkspaceDiagnostics(expectedPath: string) {
  const projectSelector = projectSectionSelector(expectedPath);
  const windows = await getAllWindowInfo().catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  const targets = await getBrowserTargetInfo().catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  const dom = await browser
    .execute(
      (workspacePathTestId, projectSectionSelectorValue) => {
        const pathBadge = document.querySelector<HTMLElement>(
          `[data-testid="${workspacePathTestId}"]`,
        );
        const projectSection = document.querySelector(projectSectionSelectorValue);
        let localStorageKeys: string[] | { error: string };
        try {
          localStorageKeys = Object.keys(window.localStorage).sort();
        } catch (error) {
          localStorageKeys = {
            error: error instanceof Error ? error.message : String(error),
          };
        }
        return {
          bodyText: document.body?.innerText?.slice(0, 1200) ?? "",
          readyState: document.readyState,
          testIds: Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
            .slice(0, 80)
            .map((element) => element.dataset.testid ?? ""),
          title: document.title,
          url: window.location.href,
          projectRowExists: Boolean(projectSection),
          workspaceAbsPath: pathBadge?.dataset.workspaceAbsPath ?? null,
          localStorageKeys,
        };
      },
      TID_WORKSPACE_PATH,
      projectSelector,
    )
    .catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }));

  return `诊断: ${JSON.stringify({ expectedPath, windows, targets, dom }, null, 2)}`;
}

export async function waitForDefaultWorkspaceReady(timeout = 10000) {
  await browser.waitUntil(
    async () => {
      try {
        await access(DEFAULT_WORKSPACE);
        return true;
      } catch {
        return false;
      }
    },
    {
      timeout,
      timeoutMsg: `默认工作区没有自动创建: ${DEFAULT_WORKSPACE}`,
    },
  );

  if (await isWorkspaceAppVisible(DEFAULT_WORKSPACE)) {
    // 修复原因：browser.reloadSession 后 renderer 已经可操作，但 Electron bridge
    // 偶发仍处在重连窗口；此时继续依赖 BrowserWindow 列表会误报“主窗口没有出现”。
    return;
  }

  await browser.waitUntil(
    async () => {
      // Bug 根因：reloadSession 后 renderer DOM 往往先于 Electron service bridge
      // 恢复。旧实现进入这一轮等待后只轮询 BrowserWindow，哪怕页面随后已经可操作，
      // 也会一直等满超时并误报“主窗口没有出现”。两条就绪链路必须并行收敛。
      if (await isWorkspaceAppVisible(DEFAULT_WORKSPACE)) {
        return true;
      }
      try {
        const windows = await getAllWindowInfo();
        return windows.length >= 1;
      } catch {
        return false;
      }
    },
    {
      interval: 250,
      timeout,
      timeoutMsg: "主窗口没有出现",
    },
  );

  if (await isWorkspaceAppVisible(DEFAULT_WORKSPACE)) {
    return;
  }

  await switchToWorkspaceRendererWindow(DEFAULT_WORKSPACE, timeout);
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, timeout);
}
