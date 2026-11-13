import { TID_V4_COMPOSER } from "@zcode/shared/test-ids";
import type { V4PermissionDockState, V4PermissionRuleScope } from "./types.js";

/** 等待 v4 权限弹窗出现（V4InteractionDialogs → PermissionDialog，role=listbox）。 */
export function hasV4PermissionDialog(): Promise<boolean> {
  return browser.execute(() => {
    const normalize = (value: string | null | undefined) =>
      (value ?? "").replace(/\u00a0/g, " ").trim();
    return Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).some(
      (element) => {
        const label = normalize(element.getAttribute("aria-label"));
        return label === "Permission required" || label === "需要权限";
      },
    );
  });
}

/** V4 普通 permission 声明 freeText 能力时，底部输入行必须实际挂载。 */
export function hasV4PermissionFeedbackInput(): Promise<boolean> {
  return browser.execute(() =>
    Boolean(
      document.querySelector(
        'textarea[aria-label="Optional feedback for the model when denying"],textarea[aria-label="拒绝时给模型的可选反馈"]',
      ),
    ),
  );
}

export async function waitForV4PermissionDialog(timeout = 60000) {
  await browser.waitUntil(hasV4PermissionDialog, { timeout, timeoutMsg: "v4 权限弹窗没有出现" });
}

export async function getV4PermissionRuleScopes(): Promise<V4PermissionRuleScope[]> {
  return browser.execute(() => {
    const normalize = (value: string | null | undefined) =>
      (value ?? "").replace(/\u00a0/g, " ").trim();
    const listbox = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).find(
      (element) => {
        const label = normalize(element.getAttribute("aria-label"));
        return label === "Permission required" || label === "需要权限";
      },
    );
    return Array.from(
      listbox?.querySelectorAll<HTMLElement>("[data-permission-rule-scope]") ?? [],
    ).map((element) => ({
      kind: element.getAttribute("data-permission-rule-scope") === "prefix" ? "prefix" : "exact",
      text: normalize(element.innerText),
    }));
  });
}

async function readV4PermissionDockState(): Promise<V4PermissionDockState> {
  return browser.execute((composerTestId) => {
    const normalize = (v: string | null | undefined) => (v ?? "").replace(/\u00a0/g, " ").trim();
    const listbox = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).find(
      (el) => {
        const label = normalize(el.getAttribute("aria-label"));
        return label === "Permission required" || label === "需要权限";
      },
    );
    const dock = listbox?.closest<HTMLElement>('[data-v4-composer-dock="true"]') ?? null;
    const composer = dock?.querySelector<HTMLElement>(`[data-testid="${composerTestId}"]`) ?? null;
    const composerDisplay = composer ? getComputedStyle(composer).display : null;
    const interactionBeforeComposer = Boolean(
      listbox &&
      composer &&
      listbox.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    return {
      inDock: Boolean(dock),
      composerMounted: Boolean(composer),
      composerHidden:
        composer?.getAttribute("aria-hidden") === "true" && composerDisplay === "none",
      interactionBeforeComposer,
      composerAriaHidden: composer?.getAttribute("aria-hidden") ?? null,
      composerDisplay,
    };
  }, TID_V4_COMPOSER);
}

/**
 * 等待真实权限弹窗进入 v4 composer dock，并确认阻塞期间 composer 只隐藏不卸载。
 */
export async function waitForV4PermissionDialogInComposerDock(timeout = 60000) {
  await waitForV4PermissionDialog(timeout);
  await browser.waitUntil(
    async () => {
      const state = await readV4PermissionDockState();
      return (
        state.inDock &&
        state.composerMounted &&
        state.composerHidden &&
        state.interactionBeforeComposer
      );
    },
    { timeout, timeoutMsg: "v4 权限弹窗没有进入 composer dock 或 composer 未正确隐藏" },
  );
  return readV4PermissionDockState();
}

/**
 * 批准 v4 权限弹窗的第一个选项（Allow once）。PermissionDialog 首项默认选中，
 * 单击已选中项即确认 onRespond → resolveInteraction 命令。为稳妥点两次
 *（第一次若只是选中，第二次确认）。
 */
export async function approveV4Permission(feedback?: string) {
  await waitForV4PermissionDialog();
  if (feedback !== undefined) {
    const input = await $(
      'textarea[aria-label="Optional feedback for the model when denying"],textarea[aria-label="拒绝时给模型的可选反馈"]',
    );
    await input.waitForDisplayed({ timeout: 15000 });
    await input.setValue(feedback);
  }
  const confirmFirstOption = () =>
    browser.execute(() => {
      const normalize = (v: string | null | undefined) => (v ?? "").replace(/\u00a0/g, " ").trim();
      const listbox = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).find(
        (el) => {
          const label = normalize(el.getAttribute("aria-label"));
          return label === "Permission required" || label === "需要权限";
        },
      );
      const option = listbox?.querySelector<HTMLButtonElement>('button[role="option"]');
      option?.click();
      return Boolean(option);
    });
  await confirmFirstOption();
  // 弹窗消失即视为已应答；若首次点击只是选中，再点一次确认。
  const dismissed = await browser
    .waitUntil(
      async () => {
        const stillOpen = await browser.execute(() => {
          const normalize = (v: string | null | undefined) =>
            (v ?? "").replace(/\u00a0/g, " ").trim();
          return Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).some(
            (el) => {
              const label = normalize(el.getAttribute("aria-label"));
              return label === "Permission required" || label === "需要权限";
            },
          );
        });
        if (stillOpen) {
          await confirmFirstOption();
          return false;
        }
        return true;
      },
      { timeout: 15000, timeoutMsg: "v4 权限弹窗批准后没有关闭" },
    )
    .then(() => true)
    .catch(() => false);
  return dismissed;
}

/** 填写拒绝反馈并确认 Deny，反馈走同一个 resolveInteraction 应答。 */
export async function denyV4PermissionWithFeedback(feedback: string, submitWithEnter = false) {
  await waitForV4PermissionDialog();
  const input = await $(
    'textarea[aria-label="Optional feedback for the model when denying"],textarea[aria-label="拒绝时给模型的可选反馈"]',
  );
  await input.waitForDisplayed({ timeout: 15000 });
  await input.setValue(feedback);

  // 空白输入行不能提交；普通 Deny 仍可确认且只回传基础拒绝文案。
  if (!feedback.trim() && !submitWithEnter) {
    await browser.execute(() => {
      document
        .querySelector<HTMLButtonElement>('[role="option"][data-permission-option-kind^="reject"]')
        ?.focus();
    });
  }
  await browser.waitUntil(
    () =>
      browser.execute((hasFeedback: boolean) => {
        const selectedDeny = document.querySelector(
          '[role="option"][data-permission-option-kind^="reject"][aria-selected="true"]',
        );
        const input = document.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Optional feedback for the model when denying"],textarea[aria-label="拒绝时给模型的可选反馈"]',
        );
        return hasFeedback
          ? !selectedDeny &&
              document.activeElement === input &&
              input?.parentElement?.classList.contains("bg-selected")
          : Boolean(selectedDeny);
      }, Boolean(feedback.trim())),
    { timeout: 5000, timeoutMsg: "权限反馈行与普通 Deny 的独立选择状态不符合预期" },
  );

  if (submitWithEnter) {
    await input.click();
    await browser.keys("Enter");
  }

  const clicked = submitWithEnter
    ? true
    : await browser.execute(() => {
        const normalize = (v: string | null | undefined) =>
          (v ?? "").replace(/\u00a0/g, " ").trim();
        const listbox = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).find(
          (el) => {
            const label = normalize(el.getAttribute("aria-label"));
            return label === "Permission required" || label === "需要权限";
          },
        );
        // 按稳定的阻塞交互区域定位，避免新增视觉分组后依赖 listbox 的直接父节点。
        const confirmButton = listbox
          ?.closest('[data-v4-composer-dock="true"]')
          ?.querySelector<HTMLButtonElement>(
            'button[aria-label="Confirm"],button[aria-label="确认"]',
          );
        confirmButton?.click();
        return Boolean(confirmButton);
      });
  if (!clicked) return false;

  return browser
    .waitUntil(async () => !(await hasV4PermissionDialog()), {
      timeout: 15000,
      timeoutMsg: "v4 权限弹窗拒绝后没有关闭",
    })
    .then(() => true)
    .catch(() => false);
}

/** 选择携带 CLI suggestion 的项目级始终允许选项。 */
export async function approveV4PermissionAlways() {
  await waitForV4PermissionDialog();
  const confirmAlwaysOption = () =>
    browser.execute(() => {
      const normalize = (value: string | null | undefined) =>
        (value ?? "").replace(/\u00a0/g, " ").trim();
      const listbox = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).find(
        (element) => {
          const label = normalize(element.getAttribute("aria-label"));
          return label === "Permission required" || label === "需要权限";
        },
      );
      const option = Array.from(
        listbox?.querySelectorAll<HTMLButtonElement>('button[role="option"]') ?? [],
      ).find((button) => button.dataset.permissionOptionKind === "allowAlways");
      option?.click();
      return Boolean(option);
    });

  if (!(await confirmAlwaysOption())) return false;
  return browser
    .waitUntil(
      async () => {
        const stillOpen = await hasV4PermissionDialog();
        if (stillOpen) {
          await confirmAlwaysOption();
          return false;
        }
        return true;
      },
      { timeout: 15000, timeoutMsg: "v4 项目始终允许后权限弹窗没有关闭" },
    )
    .then(() => true)
    .catch(() => false);
}
