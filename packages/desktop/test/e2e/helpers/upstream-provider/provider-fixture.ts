import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import {
  TID_MODEL_PROVIDER_ADD_MODEL_BUTTON,
  TID_MODEL_PROVIDER_API_KEY_INPUT,
  TID_MODEL_PROVIDER_MODEL_INPUT,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";

import {
  DEFAULT_WORKSPACE,
  clickTestIdByDom,
  readModelProvider,
  readModelProviders,
  setInputValueByTestIdDom,
  waitForDefaultWorkspaceReady,
  waitForTestIdByDom,
  waitForWorkspaceApp,
  type E2EModelProviderSnapshot,
} from "../desktop-app.js";
import { createAndConfigurePersonalProvider } from "../personal-provider-settings.js";
import { saveProviderModelMetadataDialog } from "../provider-model-metadata-dialog.js";
import { sel } from "../selectors.js";
import {
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_PROVIDER_NAME,
  UPSTREAM_PROVIDER_NAV_KEY,
  UPSTREAM_THOUGHT_LEVEL,
  getUpstreamApiKey,
} from "./config.js";
import { selectUpstreamModel, selectUpstreamProviderModelById } from "./model-selection.js";
import {
  clickUpstreamProviderNavItem,
  waitForModelProviderNavSelected,
  waitForUpstreamProviderSaved,
} from "./provider-nav.js";
import { selectUpstreamThoughtLevel } from "./thought-level.js";

const MODEL_SELECTION_RECENT_KEY_PREFIX = "zcode-model-selection-recent-v1";

interface EnsureUpstreamProviderOptions {
  /**
   * v4 竖切（M3）：旧 ChatInputToolbar 已删除，模型/思考深度选择 UI 尚未在 v4 pane 重建。
   * 此时依赖 seedUpstreamToolbarPreferences 的 localStorage 偏好 + CLI workspace catalog
   * 默认模型解析，跳过所有 toolbar 交互步骤。模型选择 UI 归 M4 后移除该开关。
   */
  skipToolbarSelection?: boolean;
}

export async function ensureUpstreamProviderForE2E(options: EnsureUpstreamProviderOptions = {}) {
  const upstreamApiKey = getUpstreamApiKey();

  await waitForDefaultWorkspaceReady(30000);
  await seedUpstreamToolbarPreferences();
  if (await hasSeededUpstreamProvider(upstreamApiKey)) {
    if (!options.skipToolbarSelection) {
      await selectUpstreamModel();
      await selectUpstreamThoughtLevel();
    }
    return;
  }

  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15000,
    timeoutMsg: "没有找到设置入口按钮",
  });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });

  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), {
    timeout: 15000,
    timeoutMsg: "设置页没有出现模型供应商分区入口",
  });

  if (!(await tryClickUpstreamProviderNavItem())) {
    const createdProvider = await createMissingUpstreamProvider();
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
      timeout: 15000,
      timeoutMsg: "设置页返回按钮没有出现",
    });
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    await selectUpstreamProviderModelById(UPSTREAM_MODEL, {
      includePlainModelFallback: false,
      providerId: createdProvider.id,
      providerName: createdProvider.name,
    });
    await selectUpstreamThoughtLevel();
    return;
  }
  await waitForModelProviderNavSelected(UPSTREAM_PROVIDER_NAV_KEY);

  await setInputValueByTestIdDom(TID_MODEL_PROVIDER_API_KEY_INPUT, upstreamApiKey, {
    timeout: 15000,
    timeoutMsg: `${UPSTREAM_PROVIDER_NAME} provider API Key 输入框没有出现`,
  });
  await waitForUpstreamProviderSaved(
    (provider) => provider.apiKey.trim().length > 0,
    `${UPSTREAM_PROVIDER_NAME} API Key 没有保存到 e2e app data`,
  );

  const currentProvider = await readModelProvider(UPSTREAM_PROVIDER_ID);
  if (!currentProvider || !hasUpstreamModel(currentProvider, UPSTREAM_MODEL)) {
    await addUpstreamProviderModel(UPSTREAM_MODEL, currentProvider?.models.length ?? 0);
  }

  await waitForUpstreamProviderSaved(
    (provider) => hasUpstreamModel(provider, UPSTREAM_MODEL),
    `${UPSTREAM_PROVIDER_NAME} e2e 模型没有保存到 provider 配置`,
  );

  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15000,
    timeoutMsg: "设置页返回按钮没有出现",
  });
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);

  if (options.skipToolbarSelection) {
    return;
  }
  await selectUpstreamModel();
  if (UPSTREAM_THOUGHT_LEVEL) {
    await selectUpstreamThoughtLevel();
  }
}

async function hasSeededUpstreamProvider(apiKey: string) {
  const currentProvider = await readModelProvider(UPSTREAM_PROVIDER_ID);
  return Boolean(
    currentProvider &&
    currentProvider.enabled !== false &&
    currentProvider.apiKey.trim() === apiKey.trim() &&
    hasUpstreamModel(currentProvider, UPSTREAM_MODEL),
  );
}

async function tryClickUpstreamProviderNavItem() {
  const navTestId = testId(TID_MODEL_PROVIDER_NAV_ITEM, UPSTREAM_PROVIDER_NAV_KEY);
  return browser
    .waitUntil(
      async () => {
        const clicked = await browser.execute((currentTestId) => {
          const element = document.querySelector<HTMLElement>(`[data-testid="${currentTestId}"]`);
          if (
            !element ||
            (element instanceof HTMLButtonElement &&
              (element.disabled || element.getAttribute("aria-disabled") === "true"))
          ) {
            return false;
          }
          element.click();
          return true;
        }, navTestId);
        if (clicked) {
          return true;
        }
        await browser.pause(150);
        return false;
      },
      {
        timeout: 5000,
        timeoutMsg: `设置页没有出现默认 ${UPSTREAM_PROVIDER_NAME} provider`,
      },
    )
    .then(() => true)
    .catch(() => false);
}

async function createMissingUpstreamProvider() {
  const baseURL = process.env.E2E_PROVIDER_RUNTIME_BASE_URL?.trim();
  if (!baseURL) {
    throw new Error("E2E_PROVIDER_RUNTIME_BASE_URL 未配置，无法通过设置页新增 replay provider");
  }

  await createAndConfigurePersonalProvider({
    apiKey: getUpstreamApiKey(),
    baseURL,
    providerName: UPSTREAM_PROVIDER_ID,
  });

  await clickTestIdByDom(TID_MODEL_PROVIDER_ADD_MODEL_BUTTON, {
    timeout: 15000,
    timeoutMsg: "新增 provider 添加模型按钮没有出现",
  });
  await addUpstreamProviderModelThroughMetadataDialog(UPSTREAM_MODEL);
  await waitForMetadataDialogClosed("新增 provider 模型 metadata 弹窗保存后没有关闭");

  return waitForCreatedProvider(UPSTREAM_PROVIDER_ID, baseURL, UPSTREAM_MODEL);
}

async function seedUpstreamToolbarPreferences() {
  await browser.execute(
    (workspacePath, keyPrefix, providerId, modelId, thoughtLevel, appProvider) => {
      window.localStorage.setItem(
        `${keyPrefix}:${workspacePath}`,
        JSON.stringify({
          providerId,
          modelId,
          ...(thoughtLevel.trim() ? { options: { reasoningLevel: thoughtLevel.trim() } } : {}),
        }),
      );
      window.localStorage.setItem("zcode-last-agent-provider", appProvider);
    },
    DEFAULT_WORKSPACE,
    MODEL_SELECTION_RECENT_KEY_PREFIX,
    UPSTREAM_PROVIDER_ID,
    UPSTREAM_MODEL,
    UPSTREAM_THOUGHT_LEVEL,
    ZCODE_AGENT_PROVIDER,
  );
}

export async function ensureUpstreamModelForE2E(modelId: string) {
  const currentProvider = await readModelProvider(UPSTREAM_PROVIDER_ID);
  if (currentProvider && hasUpstreamModel(currentProvider, modelId)) {
    return;
  }

  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15000,
    timeoutMsg: "没有找到设置入口按钮",
  });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });

  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), {
    timeout: 15000,
    timeoutMsg: "设置页没有出现模型供应商分区入口",
  });
  await clickUpstreamProviderNavItem();
  await waitForModelProviderNavSelected(UPSTREAM_PROVIDER_NAV_KEY);

  const provider = await readModelProvider(UPSTREAM_PROVIDER_ID);
  await addUpstreamProviderModel(modelId, provider?.models.length ?? 0);

  await waitForUpstreamProviderSaved(
    (candidate) => hasUpstreamModel(candidate, modelId),
    `${UPSTREAM_PROVIDER_NAME} e2e 模型没有保存到 provider 配置: ${modelId}`,
  );

  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15000,
    timeoutMsg: "设置页返回按钮没有出现",
  });
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
}

function hasUpstreamModel(
  provider: NonNullable<Awaited<ReturnType<typeof readModelProvider>>>,
  modelId: string,
) {
  // 修复原因：v2 provider store 的 models 是 ModelProviderModelConfig 对象数组，
  // 旧 helper 只用 string includes，会把已经存在的模型误判为缺失。
  return provider.models.some((model) =>
    typeof model === "string" ? model === modelId : model.id === modelId,
  );
}

async function addUpstreamProviderModel(modelId: string, nextModelIndex: number) {
  await clickTestIdByDom(TID_MODEL_PROVIDER_ADD_MODEL_BUTTON, {
    timeout: 15000,
    timeoutMsg: `${UPSTREAM_PROVIDER_NAME} provider 添加模型按钮没有出现`,
  });
  const modelInputTestId = testId(TID_MODEL_PROVIDER_MODEL_INPUT, String(nextModelIndex));
  const hasInlineInput = await waitForTestIdByDom(modelInputTestId, {
    timeout: 3000,
    timeoutMsg: `${UPSTREAM_PROVIDER_NAME} provider 新模型输入框没有出现`,
  })
    .then(() => true)
    .catch(() => false);

  if (hasInlineInput) {
    await setInputValueByTestIdDom(modelInputTestId, modelId, {
      timeout: 15000,
      timeoutMsg: `${UPSTREAM_PROVIDER_NAME} provider 新模型输入框没有出现`,
    });
    return;
  }

  // 修复原因：设置页新增模型已从内联空行改成 metadata 弹窗。
  // E2E helper 需要兼容新旧两种形态，否则只在新增第二模型/变体时失败。
  await addUpstreamProviderModelThroughMetadataDialog(modelId);
}

async function addUpstreamProviderModelThroughMetadataDialog(modelId: string) {
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        return Boolean(dialog?.querySelector("input"));
      }),
    {
      timeout: 15000,
      timeoutMsg: `${UPSTREAM_PROVIDER_NAME} provider 新模型 metadata 弹窗没有出现`,
    },
  );

  const inputDiagnostics = await browser.execute(() => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) {
      return {
        inputCount: 0,
        reason: "dialog-missing",
        selectedInputIndex: -1,
      };
    }

    const inputs = Array.from(dialog.querySelectorAll<HTMLInputElement>("input"));
    const descriptors = inputs.map((input, index) => ({
      index,
      inputMode: input.getAttribute("inputmode") ?? "",
      label: input.parentElement?.querySelector("label")?.textContent?.trim() ?? "",
      placeholder: input.getAttribute("placeholder") ?? "",
      readOnly: input.readOnly,
      type: input.getAttribute("type") ?? "",
      value: input.value,
    }));
    const selectedInputIndex =
      descriptors.find((descriptor) =>
        [descriptor.label, descriptor.placeholder].some((text) =>
          /^(模型 ID|Model ID)$/i.test(text.trim()),
        ),
      )?.index ??
      descriptors.find((descriptor) => descriptor.inputMode !== "numeric" && !descriptor.readOnly)
        ?.index ??
      -1;
    return {
      descriptors,
      inputCount: inputs.length,
      reason: selectedInputIndex >= 0 ? "model-input-found" : "model-input-missing",
      selectedInputIndex,
    };
  });
  if (inputDiagnostics.selectedInputIndex < 0) {
    throw new Error(
      `${UPSTREAM_PROVIDER_NAME} provider 新模型 metadata 弹窗没有模型 ID 输入框: ${JSON.stringify(
        inputDiagnostics,
      )}`,
    );
  }

  const inputs = await $$('[role="dialog"] input');
  const modelInput = inputs[inputDiagnostics.selectedInputIndex];
  if (!modelInput) {
    throw new Error(
      `${UPSTREAM_PROVIDER_NAME} provider 新模型 metadata 弹窗输入框索引失效: ${JSON.stringify(
        inputDiagnostics,
      )}`,
    );
  }
  await modelInput.waitForDisplayed({ timeout: 5000 });
  await modelInput.setValue(modelId);
  await browser.waitUntil(async () => (await modelInput.getValue()) === modelId, {
    timeout: 5000,
    timeoutMsg: `${UPSTREAM_PROVIDER_NAME} provider 新模型 ID 没有写入输入框: ${modelId}`,
  });
  await saveProviderModelMetadataDialog(UPSTREAM_PROVIDER_NAME);
}

async function waitForMetadataDialogClosed(timeoutMsg: string) {
  await browser.waitUntil(
    () => browser.execute(() => !document.querySelector<HTMLElement>('[role="dialog"]')),
    {
      timeout: 10000,
      timeoutMsg,
    },
  );
}

async function waitForCreatedProvider(providerName: string, baseURL: string, modelId: string) {
  let latestProviders: E2EModelProviderSnapshot[] = [];
  await browser.waitUntil(
    async () => {
      latestProviders = await readModelProviders();
      const provider = latestProviders.find((candidate) => candidate.name === providerName);
      return Boolean(
        provider &&
        provider.apiKey.trim() === getUpstreamApiKey() &&
        hasEndpoint(provider, baseURL) &&
        hasModel(provider, modelId),
      );
    },
    {
      timeout: 30000,
      timeoutMsg: `新增 provider 没有保存到本地配置: ${providerName}`,
    },
  );

  const provider = latestProviders.find((candidate) => candidate.name === providerName);
  if (!provider) {
    throw new Error(`新增 provider 等待后仍不存在: ${providerName}`);
  }
  return provider;
}

function hasEndpoint(provider: E2EModelProviderSnapshot, baseURL: string) {
  return Object.values(provider.endpoints ?? {}).some((value) => {
    if (typeof value !== "string") {
      return false;
    }
    return value.trim() === baseURL;
  });
}

function hasModel(provider: E2EModelProviderSnapshot, modelId: string) {
  return provider.models.some((model) =>
    typeof model === "string" ? model === modelId : model.id === modelId,
  );
}
