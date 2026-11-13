import {
  TID_CHAT_SUMMARY_PANEL,
  TID_V4_EDIT,
  TID_V4_EDIT_INPUT,
  TID_V4_EDIT_REWIND_WORKSPACE,
  TID_V4_EDIT_SUBMIT,
  TID_V4_EDIT_WORKSPACE_CONFLICT_CONVERSATION_ONLY,
  TID_V4_EDIT_WORKSPACE_CONFLICT_DIALOG,
  TID_V4_SESSION_PANE,
  testId,
} from "@zcode/shared/test-ids";
import { clickTestIdByDom, setInputValueByTestIdDom } from "../desktop-app.js";
import { V4_MAIN_PANE_ID } from "./constants.js";

/** 点击第一个可见的 fork 按钮（完成态 assistant 行），返回是否点到。 */
export async function clickFirstV4Fork() {
  const buttons = await browser.$$('[data-testid^="v4-fork-"]');
  for (const button of buttons) {
    await moveV4ForkRowIntoHoverState(button);
    if (!(await button.isDisplayed()) || !(await button.isEnabled())) {
      continue;
    }
    // Bug 根因：直接在 renderer 里调用 HTMLElement.click() 会绕过 WebDriver 的
    // 用户交互路径；Radix/React 组合控件在长批次中可能只更新视觉层而未提交 fork。
    // 使用 WebDriver 原生 click，保留同一个按钮和断言语义，确保触发真实 pointer/click 事件。
    await button.click();
    return true;
  }
  return false;
}

export async function waitForV4Fork(timeout = 60000) {
  await browser.waitUntil(
    async () => {
      const buttons = await browser.$$('[data-testid^="v4-fork-"]');
      for (const button of buttons) {
        await moveV4ForkRowIntoHoverState(button);
        if ((await button.isDisplayed()) && (await button.isEnabled())) {
          return true;
        }
      }
      return false;
    },
    { timeout, timeoutMsg: "v4 fork 按钮没有出现（assistant 行未完成？）" },
  );
}

async function moveV4ForkRowIntoHoverState(button: WebdriverIO.Element): Promise<void> {
  const rowTestId = await browser.execute(
    (element) => element.closest<HTMLElement>("[data-row-id]")?.dataset.rowId ?? null,
    button,
  );
  const row = rowTestId ? await browser.$(`[data-row-id="${rowTestId}"]`) : await button.$("..");
  // Bug 根因：assistant action toolbar 默认由 group-hover 隐藏，旧 helper 只检查 DOM
  // 存在就直接点隐藏按钮；长列表中该 click 不会触发真实 fork。先把所属 turn 移入
  // hover 状态，再用可见且 enabled 的按钮完成同一用户操作，不改变 case 证明。
  await row.moveTo();
}

/** 点击第一个可见的 edit 按钮（user 行），返回是否点到。 */
export async function clickFirstV4Edit() {
  return browser.execute(() => {
    const btn = document.querySelector<HTMLButtonElement>('[data-testid^="v4-edit-"]');
    btn?.click();
    return Boolean(btn);
  });
}

export async function waitForV4Edit(timeout = 60000) {
  await browser.waitUntil(
    async () =>
      browser.execute((editPrefix) => {
        const exactPattern = new RegExp(`^${editPrefix}-\\d+$`);
        return Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).some(
          (candidate) => exactPattern.test(candidate.dataset.testid ?? ""),
        );
      }, TID_V4_EDIT),
    { timeout, timeoutMsg: "v4 edit 按钮没有出现（user 行未完成？）" },
  );
}

/** 读取 goal 横幅（data-goal-status / data-goal-objective 投影属性）；无目标返回 null。 */
export function getV4GoalProjection(): Promise<{
  status: string | null;
  objective: string | null;
} | null> {
  return browser.execute(
    (paneTestId, paneId, panelTestId) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}-${paneId}"]`);
      const el = pane?.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
      if (!el) return null;
      return {
        status: el.getAttribute("data-goal-status"),
        objective: el.getAttribute("data-goal-objective"),
      };
    },
    TID_V4_SESSION_PANE,
    V4_MAIN_PANE_ID,
    TID_CHAT_SUMMARY_PANEL,
  );
}

/** 打开 latest user query 行内编辑并填入新文本，但不提交。 */
export async function beginFirstV4UserQueryEdit(newText: string) {
  let rowId: string | null = null;
  let lastClickedRowId: string | null = null;
  let lastClickedAt = 0;
  await browser.waitUntil(
    async () => {
      const state = await browser.execute(
        (editPrefix, editInputPrefix) => {
          const actionPattern = new RegExp(`^${editPrefix}-(\\d+)$`);
          const inputPattern = new RegExp(`^${editInputPrefix}-(\\d+)$`);
          const testIds = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"));
          const input = testIds
            .filter((candidate) => inputPattern.test(candidate.dataset.testid ?? ""))
            .at(-1);
          if (input) {
            return {
              inputRowId: inputPattern.exec(input.dataset.testid ?? "")?.[1] ?? null,
              actionRowId: null,
            };
          }
          const action = testIds
            .filter((candidate) => actionPattern.test(candidate.dataset.testid ?? ""))
            .at(-1);
          return {
            inputRowId: null,
            actionRowId: actionPattern.exec(action?.dataset.testid ?? "")?.[1] ?? null,
          };
        },
        TID_V4_EDIT,
        TID_V4_EDIT_INPUT,
      );
      if (state.inputRowId) {
        rowId = state.inputRowId;
        return true;
      }
      if (!state.actionRowId) return false;

      const now = Date.now();
      if (lastClickedRowId !== state.actionRowId || now - lastClickedAt >= 500) {
        lastClickedRowId = state.actionRowId;
        lastClickedAt = now;
        await clickTestIdByDom(testId(TID_V4_EDIT, state.actionRowId), {
          timeout: 2000,
          timeoutMsg: `v4 行内编辑按钮在 projection 收口时消失: rowId=${state.actionRowId}`,
        }).catch(() => undefined);
      }
      return false;
    },
    {
      timeout: 15000,
      timeoutMsg: "v4 latest user edit action 出现后没有进入稳定行内编辑态",
      interval: 100,
    },
  );
  if (!rowId) {
    throw new Error("v4 latest user edit action 没有出现");
  }
  // Bug 根因：compact success 会先投影成功 marker，再清理 active work；这两帧之间
  // 旧 edit action 可能短暂可见后被 canEdit 收口撤下。单次 DOM click 会把刚打开的
  // 本地 editing 状态随 onEdit 消失一起关闭。等待稳定 input，并在 action 恢复后重试。
  await setInputValueByTestIdDom(testId(TID_V4_EDIT_INPUT, rowId), newText, {
    timeout: 15000,
    timeoutMsg: `v4 行内编辑输入框没有出现: rowId=${rowId}`,
  });
  return rowId;
}

/** 按真实行内编辑交互提交 latest user query，主 composer 草稿不参与。 */
export async function editFirstV4UserQuery(newText: string) {
  const rowId = await beginFirstV4UserQueryEdit(newText);
  await clickTestIdByDom(testId(TID_V4_EDIT_SUBMIT, rowId), {
    timeout: 15000,
    timeoutMsg: `v4 行内编辑提交按钮没有出现: rowId=${rowId}`,
  });
  return rowId;
}

/** 提交行内编辑的“对话 + 文件重置”路径。 */
export async function clickV4EditWorkspaceReset(rowId: string) {
  await clickTestIdByDom(testId(TID_V4_EDIT_REWIND_WORKSPACE, rowId), {
    timeout: 15000,
    timeoutMsg: `v4 对话 + 文件重置按钮没有出现或不可点击: rowId=${rowId}`,
  });
}

export async function waitForV4EditWorkspaceConflict(timeout = 30000) {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (testIdValue) => Boolean(document.querySelector(`[data-testid="${testIdValue}"]`)),
        TID_V4_EDIT_WORKSPACE_CONFLICT_DIALOG,
      ),
    { timeout, timeoutMsg: "v4 edit 文件冲突弹窗没有出现" },
  );
}

export async function clickV4EditConflictConversationOnly() {
  await clickTestIdByDom(TID_V4_EDIT_WORKSPACE_CONFLICT_CONVERSATION_ONLY, {
    timeout: 15000,
    timeoutMsg: "v4 edit 冲突弹窗没有出现仅重置对话按钮",
  });
}
