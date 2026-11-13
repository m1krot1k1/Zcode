import {
  TID_LOGIN_API_KEY_CONTINUE_BUTTON,
  TID_LOGIN_API_KEY_INPUT,
  TID_LOGIN_USE_API_KEY_BUTTON,
  TID_TASK_NEW_BUTTON,
  TID_V4_COMPOSER_INPUT,
  TID_V4_SESSION_PANE,
  TID_V4_STOP,
  testId,
} from "@zcode/shared/test-ids";
import {
  clickTestIdByDom,
  DEFAULT_WORKSPACE,
  setInputValueByTestIdDom,
  waitForDefaultWorkspaceReady,
} from "../desktop-app.js";
import { skipOccupationOnboardingIfPresent } from "../occupation-onboarding.js";
import {
  ensureUpstreamProviderForE2E,
  selectUpstreamModel,
  selectUpstreamThoughtLevel,
} from "../upstream-provider.js";
import { startDraftFromProject, waitForProjectRow } from "#e2e/helpers/project-sidebar";
import { LOGIN_API_KEY, V4_MAIN_PANE_ID } from "./constants.js";
import { waitForV4Pane } from "./pane.js";

interface PrepareV4ConversationE2EOptions {
  resetDraftBeforeProvider?: boolean;
  skipProvider?: boolean;
  /** 跳过 ensureV4ShellReady 的 ZCodeProject 等待。已登录冷启（真实凭据 seed 后 reloadSession）
   * 的 app 按 startupWorkspace 语义落在 conversation backing workspace，ZCodeProject 永远不出现；
   * 调用方需自行等待 v4 shell 就绪（如侧栏新任务按钮）。见 ANALYSIS r3-rerun §46。 */
  skipShellReady?: boolean;
}

export async function prepareV4ConversationE2E(options: PrepareV4ConversationE2EOptions = {}) {
  if (!options.skipShellReady) {
    await ensureV4ShellReady();
  }
  if (!options.skipShellReady || options.resetDraftBeforeProvider) {
    // Provider helper 也校验固定 cwd，必须先返回夹具项目，且不能把模型写入上一条会话。
    await ensureV4PreparationDraft(options);
  }
  if (!options.skipProvider) {
    await ensureUpstreamProviderForE2E({ skipToolbarSelection: true });
  }
  await ensureV4PreparationDraft(options);
  if (!options.skipShellReady) {
    await waitForDefaultWorkspaceReady(30000);
  }
  if (!options.skipProvider) {
    // 新 Composer 会保留已经初始化的空选择。仅写 Recent 不能覆盖这个草稿；
    // 测试准备必须像用户一样选择目标模型和档位，不能依赖旧初始化副作用。
    await selectUpstreamModel();
    await selectUpstreamThoughtLevel();
  }
}

async function ensureV4ShellReady() {
  try {
    // 新隔离 profile 的职业引导会遮住工作区，先复用真实 UI 跳过流程。
    await skipOccupationOnboardingIfPresent();
    await waitForProjectRow(DEFAULT_WORKSPACE, { timeout: 30000 });
    return;
  } catch (error) {
    if (!(await hasApiKeyLoginButton())) {
      throw error;
    }
    await loginWithApiKey();
    await skipOccupationOnboardingIfPresent();
    await waitForProjectRow(DEFAULT_WORKSPACE, { timeout: 30000 });
  }
}

async function ensureV4PreparationDraft(options: PrepareV4ConversationE2EOptions) {
  // Bug 根因：全局新建会创建独立 cwd；反复点击会让固定目录夹具与 Agent 工作区分离。
  // 只按实际 cwd 复用空草稿；为补项目标签而新建会打断冷启动预热，导致首发失败。
  // 其他 cwd 或已有内容才走项目级新建；显式全局新建 helper 保持原语义。
  const ready = await browser.execute(
    (inputId, paneId, stopId, workspacePath) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${paneId}"]`);
      const input = pane?.querySelector<HTMLElement>(`[data-testid="${inputId}"]`);
      const activePath = (
        window as Window & {
          __zcodeTabStoreE2E?: { getState(): { activeWorkspacePath?: string | null } };
        }
      ).__zcodeTabStoreE2E?.getState().activeWorkspacePath;
      return Boolean(
        pane?.dataset.sessionId === "draft" &&
        input?.getClientRects().length &&
        !input.textContent?.trim() &&
        !pane.querySelector(`[data-testid="${stopId}"]`) &&
        (!workspacePath || activePath === workspacePath),
      );
    },
    TID_V4_COMPOSER_INPUT,
    testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID),
    TID_V4_STOP,
    options.skipShellReady ? null : DEFAULT_WORKSPACE,
  );
  if (ready) return;
  if (options.skipShellReady) {
    await startNewV4Draft();
  } else {
    await startDraftFromProject(DEFAULT_WORKSPACE);
  }
}

async function hasApiKeyLoginButton() {
  const exists = await browser
    .execute(
      (currentTestId) => Boolean(document.querySelector(`[data-testid="${currentTestId}"]`)),
      TID_LOGIN_USE_API_KEY_BUTTON,
    )
    .catch(() => false);
  return Boolean(exists);
}

export async function loginWithApiKey() {
  await clickTestIdByDom(TID_LOGIN_USE_API_KEY_BUTTON, {
    timeout: 30000,
    timeoutMsg: "欢迎页没有出现 API Key 登录入口",
  });
  await setInputValueByTestIdDom(TID_LOGIN_API_KEY_INPUT, LOGIN_API_KEY, {
    timeout: 15000,
    timeoutMsg: "API Key 登录输入框没有出现",
  });
  await browser.waitUntil(
    async () =>
      browser.execute((continueButtonTestId) => {
        const button = document.querySelector<HTMLElement>(
          `[data-testid="${continueButtonTestId}"]`,
        );
        return button instanceof HTMLButtonElement && !button.disabled;
      }, TID_LOGIN_API_KEY_CONTINUE_BUTTON),
    {
      timeout: 15000,
      timeoutMsg: "API Key 登录继续按钮没有变为可用",
    },
  );
  await clickTestIdByDom(TID_LOGIN_API_KEY_CONTINUE_BUTTON, {
    timeout: 15000,
    timeoutMsg: "API Key 登录继续按钮没有出现或不可点击",
  });
}

/** 新建草稿：点侧栏新任务按钮，等 v4 pane 回到 draft 态。 */
export async function startNewV4Draft() {
  await clickTestIdByDom(TID_TASK_NEW_BUTTON, {
    timeout: 15000,
    timeoutMsg: "侧栏新任务按钮没有出现或不可点击",
  });
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === "draft",
    "新建任务后 v4 pane 没有回到 draft 态",
  );
}
