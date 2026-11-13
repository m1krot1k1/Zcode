import {
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_CHAT_VIEW,
  testId,
} from "@zcode/shared/test-ids";

import { waitForTestIdByDom } from "../desktop-app.js";
import { sel } from "../selectors.js";
import {
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_PROVIDER_NAME,
  getUpstreamProviderModelValues,
} from "./config.js";
import { clickFirstExistingTestId, hasAnyExactTestId, hasExactTestId } from "./dom-utils.js";
import { collectModelDropdownDiagnostics } from "./model-diagnostics.js";

export async function selectUpstreamModel() {
  await selectUpstreamModelById(UPSTREAM_MODEL);
}

export async function selectUpstreamModelById(
  modelId: string,
  options: SelectUpstreamProviderModelOptions = {},
) {
  await selectRegistryProviderModelById(modelId, {
    ...options,
    providerId: UPSTREAM_PROVIDER_ID,
    providerName: UPSTREAM_PROVIDER_NAME,
  });
}

interface SelectUpstreamProviderModelOptions {
  /** 团队行使用完整连接身份；普通 Provider 默认沿用 registry key。 */
  providerGroupKey?: string;
  afterModelItemClick?: () => Promise<boolean> | boolean;
  includePlainModelFallback?: boolean;
  providerId?: string;
  providerName?: string;
}

export async function selectRegistryProviderModelById(
  modelId: string,
  {
    afterModelItemClick,
    includePlainModelFallback = true,
    providerId = UPSTREAM_PROVIDER_ID,
    providerName = UPSTREAM_PROVIDER_NAME,
    providerGroupKey = `registry-provider:${providerId}`,
  }: SelectUpstreamProviderModelOptions = {},
) {
  const modelItemTestIds = getUpstreamProviderModelValues(modelId, {
    includePlainModelFallback,
    providerId,
  }).map((value) => testId(TID_CHAT_MODEL_SELECT_ITEM, value));
  const providerGroupTestIds = [testId(TID_CHAT_MODEL_SELECT_GROUP, providerGroupKey)];

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const trigger = $(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
    await trigger.waitForClickable({ timeout: 30000 });
    if (
      !(await isUpstreamModelSelected(modelId, {
        includePlainModelFallback,
        providerId,
      }))
    ) {
      await trigger.click();
      try {
        await browser.waitUntil(
          async () =>
            // Bug 原因：catalog hydration 可能在菜单打开后把目标模型设为当前值，
            // 此时产品会卸载当前菜单项；已选中与菜单项出现都代表等待完成。
            (await isUpstreamModelSelected(modelId, {
              includePlainModelFallback,
              providerId,
            })) || openModelMenuUntilModelVisible(providerGroupTestIds, modelItemTestIds),
          {
            timeout: 45000,
            timeoutMsg: `聊天工具栏没有出现 ${providerName} e2e 模型选项`,
          },
        );
      } catch (error) {
        throw new Error(
          `聊天工具栏没有出现 ${providerName} e2e 模型选项: ${modelId}\n${JSON.stringify(
            await collectModelDropdownDiagnostics(modelItemTestIds, providerId),
            null,
            2,
          )}`,
          { cause: error },
        );
      }

      const clickedModelItem = await clickFirstExistingTestId(modelItemTestIds);
      if (!clickedModelItem) {
        if (
          await isUpstreamModelSelected(modelId, {
            includePlainModelFallback,
            providerId,
          })
        ) {
          await waitForModelSwitchIdle(`${providerName} 模型 ${modelId} 已选中但持久化没有完成`);
          if (
            await isUpstreamModelSelected(modelId, {
              includePlainModelFallback,
              providerId,
            })
          ) {
            return;
          }
        }
        // 修复原因：Radix Select 的下拉项在 portal 中会随 focus/scroll 重新挂载。
        // 等待阶段已经确认选项出现后，WebDriver 再次用 selector scroll/click 可能取到空元素。
        throw new Error(
          `${providerName} e2e 模型选项在等待后仍不存在: ${modelId}\n${JSON.stringify(
            await collectModelDropdownDiagnostics(modelItemTestIds, providerId),
            null,
            2,
          )}`,
        );
      }

      if (afterModelItemClick && (await afterModelItemClick())) {
        return;
      }

      await waitForUpstreamModelSelected(modelId, {
        includePlainModelFallback,
        providerId,
      });
      if (
        (await trigger.getAttribute("data-composer-combined-model")) === "true" &&
        (await trigger.getAttribute("aria-expanded")) === "true"
      )
        await browser.keys("Escape");
    }

    await waitForModelSwitchIdle(`${providerName} 模型 ${modelId} 切换持久化没有完成`);
    if (
      await isUpstreamModelSelected(modelId, {
        includePlainModelFallback,
        providerId,
      })
    ) {
      return;
    }
    await browser.pause(250);
  }

  throw new Error(
    `${providerName} 模型 ${modelId} 持久化后没有保持选中\n${JSON.stringify(
      await collectModelDropdownDiagnostics(modelItemTestIds, providerId),
      null,
      2,
    )}`,
  );
}

// 兼容现有 上游 场景的测试 helper 名称；跨 Provider 的新场景统一使用上面的
// Registry 命名，避免把通用模型选择能力误解成 上游 特化逻辑。
export const selectUpstreamProviderModelById = selectRegistryProviderModelById;

export async function waitForUpstreamModelSelected(
  modelId: string,
  options: {
    includePlainModelFallback?: boolean;
    providerId?: string;
  } = {},
) {
  await browser.waitUntil(async () => isUpstreamModelSelected(modelId, options), {
    timeout: 15000,
    timeoutMsg: `上游 模型没有切换到 ${modelId}`,
  });
}

async function isUpstreamModelSelected(
  modelId: string,
  {
    includePlainModelFallback = true,
    providerId = UPSTREAM_PROVIDER_ID,
  }: {
    includePlainModelFallback?: boolean;
    providerId?: string;
  } = {},
) {
  const expectedValues = getUpstreamProviderModelValues(modelId, {
    includePlainModelFallback,
    providerId,
  });
  return browser.execute(
    (triggerTestId, expectedModel, modelValues) => {
      const trigger = document.querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`);
      const currentValue = trigger?.dataset.modelCurrentValue?.trim() ?? "";
      if (currentValue && modelValues.includes(currentValue)) {
        return true;
      }
      // 修复原因：自定义模型已被选中时，Radix 二级菜单可能只展示 provider 分组，
      // 不再稳定挂载当前模型项。E2E 以工具栏当前选择作为最终语义，避免误判。
      // 若组件尚未暴露 data-model-current-value，才退回可见文本；新组件优先用严格 value。
      return !currentValue && (trigger?.innerText ?? "").includes(expectedModel);
    },
    TID_CHAT_MODEL_SELECT_TRIGGER,
    modelId,
    expectedValues,
  );
}

export function getSelectedUpstreamModelLabel() {
  return browser.execute((triggerTestId) => {
    const trigger = document.querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`);
    return {
      ariaLabel: trigger?.getAttribute("aria-label") ?? "",
      currentValue: trigger?.dataset.modelCurrentValue ?? "",
      text: trigger?.innerText.trim() ?? "",
      title: trigger?.querySelector<HTMLElement>("[title]")?.getAttribute("title") ?? "",
    };
  }, TID_CHAT_MODEL_SELECT_TRIGGER);
}

export async function waitForModelSwitchIdle(timeoutMsg = "模型切换没有完成") {
  await browser.waitUntil(
    () =>
      browser.execute((chatViewTestId) => {
        const chatView = document.querySelector<HTMLElement>(`[data-testid="${chatViewTestId}"]`);
        return chatView?.dataset.modelSwitchPending !== "true";
      }, TID_CHAT_VIEW),
    {
      timeout: 30000,
      timeoutMsg,
    },
  );
}

async function openModelMenuUntilModelVisible(
  providerGroupTestIds: string[],
  modelItemTestIds: string[],
) {
  // 修复原因：模型菜单有两种形态：宽屏下可能按 provider 分组，窄屏/特定状态下会
  // 直接展开为模型项列表。用例的语义是“用户能选择目标模型”，不能强绑某一种菜单层级。
  if (await hasAnyExactTestId(modelItemTestIds)) {
    return true;
  }
  const combinedProvider = $('[data-testid="composer-provider-trigger"]');
  if (
    (await combinedProvider.isExisting()) &&
    (await combinedProvider.getAttribute("aria-expanded")) !== "true"
  ) {
    await combinedProvider.click();
  }
  for (const providerGroupTestId of providerGroupTestIds) {
    if (!(await hasExactTestId(providerGroupTestId))) {
      continue;
    }
    await openModelProviderGroup(providerGroupTestId);
    if (await hasAnyExactTestId(modelItemTestIds)) {
      return true;
    }
  }
  return false;
}

async function openModelProviderGroup(providerGroupTestId: string) {
  await waitForTestIdByDom(providerGroupTestId, {
    timeout: 15000,
    timeoutMsg: "聊天工具栏没有出现 上游 provider 分组",
  });
  // 修复原因：自定义 provider 模型在二级菜单里，不能只打开一级模型菜单后等待模型项。
  // 这里先触发 provider 子菜单，再用模型项 test id 判断是否可选。
  await browser.execute((currentTestId) => {
    const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
      (item) => item.dataset.testid === currentTestId,
    );
    if (!element) {
      return;
    }
    element.focus();
    for (const eventName of ["pointerenter", "mouseenter", "mousemove"] as const) {
      element.dispatchEvent(
        new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );
    }
    element.click();
  }, providerGroupTestId);
}
