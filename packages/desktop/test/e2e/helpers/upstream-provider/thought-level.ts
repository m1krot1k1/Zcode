import {
  TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM,
  TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
  TID_V4_MODEL_CONFIG,
  testId,
} from "@zcode/shared/test-ids";

import { selectCombinedComposerThoughtLevel } from "../composer-model-picker.js";
import { DEFAULT_WORKSPACE, clickTestIdByDom, waitForTestIdByDom } from "../desktop-app.js";
import { UPSTREAM_THOUGHT_LEVEL, getUpstreamThoughtLevelLabels } from "./config.js";
import { waitForModelSwitchIdle } from "./model-selection.js";

const UPSTREAM_THOUGHT_LEVEL_MAX_ATTEMPTS = 8;

export async function selectUpstreamThoughtLevel() {
  if (!UPSTREAM_THOUGHT_LEVEL) {
    return;
  }

  await selectUpstreamThoughtLevelValue(UPSTREAM_THOUGHT_LEVEL);
}

export async function selectUpstreamThoughtLevelValue(thoughtLevel: string) {
  if (!thoughtLevel) {
    return;
  }

  if (await selectCombinedComposerThoughtLevel(thoughtLevel)) {
    await waitForUpstreamThoughtLevelSelectedValue(thoughtLevel);
    return;
  }
  await waitForTestIdByDom(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER, {
    timeout: 45000,
    timeoutMsg: "聊天工具栏没有出现 上游 思考深度选择器",
  });
  if (await isUpstreamThoughtLevelSelected(thoughtLevel)) {
    await waitForModelSwitchIdle(`上游 思考深度 ${thoughtLevel} 已选中但持久化没有完成`);
    return;
  }

  const itemTestId = testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, thoughtLevel);

  for (let attempt = 0; attempt < UPSTREAM_THOUGHT_LEVEL_MAX_ATTEMPTS; attempt += 1) {
    await clickTestIdByDom(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER, {
      timeout: 15000,
      timeoutMsg: "聊天工具栏思考深度选择器不可点击",
    });
    await browser.pause(150);

    if (await hasUpstreamThoughtLevelItem(itemTestId)) {
      await clickTestIdByDom(itemTestId, {
        timeout: 15000,
        timeoutMsg: `聊天工具栏 ${thoughtLevel} 思考深度选项不可点击`,
      });
      await waitForUpstreamThoughtLevelSelected(
        thoughtLevel,
        `上游 思考深度没有切换到 ${thoughtLevel}`,
      );
      await waitForModelSwitchIdle(`上游 思考深度 ${thoughtLevel} 切换持久化没有完成`);
      return;
    }

    // 修复原因：小宽度/特定 toolbar 形态下思考深度是循环按钮，不会挂载
    // Radix SelectItem。此时一次 click 就是一次真实的用户切换动作。
    if (await isUpstreamThoughtLevelSelected(thoughtLevel)) {
      await waitForModelSwitchIdle(`上游 思考深度 ${thoughtLevel} 切换持久化没有完成`);
      return;
    }
  }

  throw new Error(
    `聊天工具栏无法切换到 ${thoughtLevel} 思考深度\n${JSON.stringify(
      await collectThoughtLevelDiagnostics(itemTestId),
      null,
      2,
    )}`,
  );
}

export async function waitForUpstreamThoughtLevelSelectedValue(thoughtLevel: string) {
  await waitForUpstreamThoughtLevelSelected(
    thoughtLevel,
    `上游 思考深度没有切换到 ${thoughtLevel}`,
  );
}

async function waitForUpstreamThoughtLevelSelected(thoughtLevel: string, timeoutMsg: string) {
  try {
    await browser.waitUntil(async () => isUpstreamThoughtLevelSelected(thoughtLevel), {
      timeout: 15000,
      timeoutMsg,
    });
  } catch (error) {
    throw new Error(
      `${timeoutMsg}\n${JSON.stringify(
        await collectThoughtLevelDiagnostics(
          testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, thoughtLevel),
        ),
        null,
        2,
      )}`,
      { cause: error },
    );
  }
}

async function isUpstreamThoughtLevelSelected(thoughtLevel: string) {
  return browser.execute(
    (triggerTestId, modelConfigTestId, expectedValue, expectedLabels, defaultWorkspace) => {
      const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
      const readCurrentThoughtLevel = () => {
        const e2eWindow = window as Window & {
          __zcodeSessionStoreE2E?: {
            getState: () => {
              getWorkspaceState?: (
                workspacePath: string,
                workspaceIdentity?: string,
              ) => {
                activeTaskId?: string | null;
                configOptions?: Array<{
                  category?: string;
                  currentValue?: unknown;
                  id?: string;
                  type?: string;
                }> | null;
                taskConfigOptionsByTaskId?: Record<
                  string,
                  Array<{
                    category?: string;
                    currentValue?: unknown;
                    id?: string;
                    type?: string;
                  }>
                >;
              };
            };
          };
        };
        const workspaceState = e2eWindow.__zcodeSessionStoreE2E
          ?.getState()
          .getWorkspaceState?.(defaultWorkspace);
        const readFromOptions = (
          options:
            | Array<{
                category?: string;
                currentValue?: unknown;
                id?: string;
                type?: string;
              }>
            | null
            | undefined,
        ) => {
          const option = (options ?? []).find(
            (candidate) =>
              (candidate.category ?? candidate.id) === "thought_level" &&
              candidate.type === "select",
          );
          return typeof option?.currentValue === "string" ? option.currentValue : "";
        };
        const activeTaskId = workspaceState?.activeTaskId ?? null;
        const taskValue =
          activeTaskId && workspaceState?.taskConfigOptionsByTaskId
            ? readFromOptions(workspaceState.taskConfigOptionsByTaskId[activeTaskId])
            : "";
        return taskValue || readFromOptions(workspaceState?.configOptions);
      };

      const v4CurrentValue = document
        .querySelector<HTMLElement>(`[data-testid="${modelConfigTestId}"]`)
        ?.dataset.thought?.trim();
      const currentValue = v4CurrentValue || readCurrentThoughtLevel();
      const trigger = document.querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`);
      const expected = [expectedValue, ...expectedLabels].map(normalize);
      if (currentValue) {
        // 修复原因：Select 打开/动画期间 trigger 文本可能同时包含多个选项。
        // store 的 currentValue 才是首发请求会读取的真实思考深度。
        return expected.includes(normalize(currentValue));
      }

      const candidates = [
        trigger?.getAttribute("aria-label") ?? "",
        trigger?.innerText ?? "",
        trigger?.textContent ?? "",
      ].map(normalize);

      // 修复原因：产品语义是“当前思考深度已选中 high”，不是“某个下拉项存在”。
      // 这里读取 trigger 的可访问标签，兼容 select 与 cycle 两种 UI 形态。
      return candidates.some((value) => expected.includes(value));
    },
    TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
    TID_V4_MODEL_CONFIG,
    thoughtLevel,
    getUpstreamThoughtLevelLabels(thoughtLevel),
    DEFAULT_WORKSPACE,
  );
}

export function getSelectedUpstreamThoughtLevelLabel() {
  return browser.execute(
    (triggerTestId, modelConfigTestId, defaultWorkspace) => {
      const readCurrentValue = () => {
        const e2eWindow = window as Window & {
          __zcodeSessionStoreE2E?: {
            getState: () => {
              getWorkspaceState?: (
                workspacePath: string,
                workspaceIdentity?: string,
              ) => {
                activeTaskId?: string | null;
                configOptions?: Array<{
                  category?: string;
                  currentValue?: unknown;
                  id?: string;
                  type?: string;
                }> | null;
                taskConfigOptionsByTaskId?: Record<
                  string,
                  Array<{
                    category?: string;
                    currentValue?: unknown;
                    id?: string;
                    type?: string;
                  }>
                >;
              };
            };
          };
        };
        const workspaceState = e2eWindow.__zcodeSessionStoreE2E
          ?.getState()
          .getWorkspaceState?.(defaultWorkspace);
        const readFromOptions = (
          options:
            | Array<{
                category?: string;
                currentValue?: unknown;
                id?: string;
                type?: string;
              }>
            | null
            | undefined,
        ) => {
          const option = (options ?? []).find(
            (candidate) =>
              (candidate.category ?? candidate.id) === "thought_level" &&
              candidate.type === "select",
          );
          return typeof option?.currentValue === "string" ? option.currentValue : "";
        };
        const activeTaskId = workspaceState?.activeTaskId ?? null;
        const taskValue =
          activeTaskId && workspaceState?.taskConfigOptionsByTaskId
            ? readFromOptions(workspaceState.taskConfigOptionsByTaskId[activeTaskId])
            : "";
        return taskValue || readFromOptions(workspaceState?.configOptions);
      };

      const v4CurrentValue = document
        .querySelector<HTMLElement>(`[data-testid="${modelConfigTestId}"]`)
        ?.dataset.thought?.trim();
      const trigger = document.querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`);
      return {
        ariaLabel: trigger?.getAttribute("aria-label") ?? "",
        // 修复原因：V4 投影已确认切换后，legacy store 可能仍保留上一档位；
        // 诊断 helper 必须与实际选择 helper 使用同一个权威事实源。
        currentValue: v4CurrentValue || readCurrentValue(),
        text: trigger?.innerText.trim() ?? "",
        title: trigger?.getAttribute("title") ?? "",
      };
    },
    TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
    TID_V4_MODEL_CONFIG,
    DEFAULT_WORKSPACE,
  );
}

async function hasUpstreamThoughtLevelItem(itemTestId: string) {
  return browser.execute((currentTestId) => {
    return Boolean(document.querySelector(`[data-testid="${currentTestId}"]`));
  }, itemTestId);
}

async function collectThoughtLevelDiagnostics(attemptedTestId: string) {
  return browser.execute(
    (itemPrefix, triggerTestId, expectedItemTestId) => {
      const trigger = document.querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`);
      const items = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid^="${itemPrefix}"]`),
      ).map((element) => ({
        ariaDisabled: element.getAttribute("aria-disabled"),
        testId: element.dataset.testid ?? "",
        text: element.innerText.trim(),
        value: element.getAttribute("value"),
      }));

      return {
        attemptedTestId: expectedItemTestId,
        bodyText: document.body?.innerText?.slice(0, 1200) ?? "",
        itemCount: items.length,
        items,
        triggerAriaLabel: trigger?.getAttribute("aria-label") ?? "",
        triggerText: trigger?.innerText.trim() ?? "",
        url: window.location.href,
      };
    },
    TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM,
    TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
    attemptedTestId,
  );
}
