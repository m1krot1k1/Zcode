import { encodeCustomModelValue } from "@zcode/shared";
import {
  TID_CHAT_MODE_SELECT_ITEM,
  TID_CHAT_MODE_SELECT_TRIGGER,
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM,
  TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
  TID_V4_MODEL_CONFIG,
  testId,
} from "@zcode/shared/test-ids";
import { selectCombinedComposerThoughtLevel } from "../composer-model-picker.js";
import { sel } from "../selectors.js";

/** 读取 Composer 当前 mode/模型选择显示。 */
export function getV4ModelConfig(): Promise<{
  mode: string | null;
  provider: string | null;
  model: string | null;
  source: string | null;
  thought: string | null;
}> {
  return browser.execute((modelTestId) => {
    const el = document.querySelector<HTMLElement>(`[data-testid="${modelTestId}"]`);
    return {
      mode: el?.getAttribute("data-mode") ?? null,
      provider: el?.getAttribute("data-provider") ?? null,
      model: el?.getAttribute("data-model") ?? null,
      source: el?.getAttribute("data-source") ?? null,
      thought: el?.getAttribute("data-thought") ?? null,
    };
  }, TID_V4_MODEL_CONFIG);
}

/** 等待当前 Composer 已从持久 Draft 完成 mode/模型选择初始化。 */
export async function waitForV4ComposerSelectionReady(timeout = 30_000) {
  let latest = await getV4ModelConfig();
  await browser.waitUntil(
    async () => {
      latest = await getV4ModelConfig();
      return (
        latest.source === "composer" &&
        Boolean(latest.mode?.trim()) &&
        Boolean(latest.provider?.trim()) &&
        Boolean(latest.model?.trim())
      );
    },
    {
      timeout,
      timeoutMsg: `v4 Composer 选择没有就绪: ${JSON.stringify(latest)}`,
    },
  );
}

/** 读取 draft 当前模型及其思考档位；V4 投影优先，legacy 目录仅作水合前 fallback。 */
export function getV4DraftThoughtState(workspacePath: string): Promise<{
  current: string | null;
  model: string | null;
  values: string[];
}> {
  return browser.execute(
    (path, modelTestId) => {
      const e2eWindow = window as Window & {
        __zcodeSessionStoreE2E?: {
          getState: () => {
            getWorkspaceState?: (workspacePath: string) => {
              configOptions?: Array<{
                category?: string;
                currentValue?: unknown;
                options?: Array<{ value: string }>;
              }>;
            };
          };
        };
      };
      const options =
        e2eWindow.__zcodeSessionStoreE2E?.getState().getWorkspaceState?.(path).configOptions ?? [];
      const model = options.find((option) => option.category === "model");
      const thought = options.find((option) => option.category === "thought_level");
      const v4Config = document.querySelector<HTMLElement>(`[data-testid="${modelTestId}"]`);
      const v4ThoughtLevels = (v4Config?.dataset.thoughtLevels ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      return {
        current:
          v4Config?.dataset.thought?.trim() ||
          (typeof thought?.currentValue === "string" ? thought.currentValue : null),
        model:
          v4Config?.dataset.model?.trim() ||
          (typeof model?.currentValue === "string" ? model.currentValue : null),
        values:
          v4ThoughtLevels.length > 0
            ? v4ThoughtLevels
            : (thought?.options?.map((option) => option.value) ?? []),
      };
    },
    workspacePath,
    TID_V4_MODEL_CONFIG,
  );
}

/**
 * 通过 composer 工具条切换模型 + 思考深度（switchModelConfig 命令）。
 * M5：调试表单（provider/model/thought 文本框 + 应用）已被真实模型选择器替换——
 * helper 适配为驱动 ModelConfigSelect（含 provider 分组二级菜单）与思考深度选择器，
 * spec 的断言语义不变（config 投影更新为目标值）。
 */
export async function switchV4Model(provider: string, model: string, thought: string) {
  // 1) 模型：打开菜单 → （必要时展开 provider 分组子菜单）→ 点目标模型项。
  const modelItemTestId = testId(
    TID_CHAT_MODEL_SELECT_ITEM,
    encodeCustomModelValue(provider, model),
  );
  const providerGroupTestIds = [
    testId(TID_CHAT_MODEL_SELECT_GROUP, `registry-provider:${provider}`),
  ];
  // 模型菜单是受控 DropdownMenu（pointerdown 打开），element.click() 不触发；
  // 与旧 upstream helper 同口径用 WebDriver 真实点击。
  const modelTrigger = $(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
  await modelTrigger.waitForClickable({ timeout: 30000 });
  await modelTrigger.click();
  await browser.waitUntil(
    async () =>
      browser.execute(
        (itemTestId, groupTestIds) => {
          const item = document.querySelector<HTMLElement>(`[data-testid="${itemTestId}"]`);
          if (item) {
            item.click();
            return true;
          }
          // 自定义 provider 模型在二级菜单：先触发分组展开（hover + click 双保险）。
          const group = groupTestIds
            .map((groupTestId) =>
              document.querySelector<HTMLElement>(`[data-testid="${groupTestId}"]`),
            )
            .find((candidate): candidate is HTMLElement => Boolean(candidate));
          if (!group) {
            const providerTrigger = document.querySelector<HTMLElement>(
              '[data-testid="composer-provider-trigger"]',
            );
            providerTrigger?.focus();
            providerTrigger?.dispatchEvent(
              new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
            );
          }
          if (group) {
            group.focus();
            for (const eventName of ["pointerenter", "mouseenter", "mousemove"] as const) {
              group.dispatchEvent(
                new MouseEvent(eventName, {
                  bubbles: true,
                  cancelable: true,
                  view: window,
                }),
              );
            }
            group.click();
          }
          return false;
        },
        modelItemTestId,
        providerGroupTestIds,
      ),
    {
      timeout: 45000,
      timeoutMsg: `v4 模型选择器没有出现目标模型项: ${provider}/${model}`,
    },
  );

  // 模型 config 投影落定后再切思考深度：thought 命令的 provider/model 参数取自
  // 最新投影，模型切换未回流前切 thought 会被 UI 跳过（config-empty 防御）。
  await browser.waitUntil(async () => (await getV4ModelConfig()).model === model, {
    timeout: 30000,
    timeoutMsg: `模型切换后 config.model 投影没有更新为 ${model}`,
  });

  if (thought && (await selectCombinedComposerThoughtLevel(thought))) return;
  if (!thought && (await modelTrigger.getAttribute("data-composer-combined-model")) === "true") {
    await browser.keys("Escape");
    return;
  }

  // 无 reasoning metadata 的 custom provider 不渲染 thought selector。协议类 E2E
  // 传空值表示只切模型，不能把不存在的思考深度控件当作模型切换失败。
  if (!thought) {
    return;
  }

  // 2) 思考深度：Radix Select 的 item 在真实 pointer 事件上确认（element.click() 无效），
  // trigger/item 都用 WebDriver 真实点击。
  await selectRadixOption(
    TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
    testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, thought),
    `v4 思考深度选择器没有出现目标档位: ${thought}`,
  );
}

/** Radix Select 通用驱动：真实点击 trigger 展开，item 需要完整 pointer 手势才会确认。 */
async function selectRadixOption(triggerTestId: string, itemTestId: string, timeoutMsg: string) {
  const trigger = $(sel(triggerTestId));
  await trigger.waitForClickable({ timeout: 30000 });
  await trigger.click();
  const item = $(sel(itemTestId));
  try {
    await item.waitForClickable({ timeout: 15000 });
  } catch (error) {
    throw new Error(timeoutMsg, { cause: error });
  }
  // Radix SelectItem 的确认：mouse 手势要求 trusted pointer 链路（合成事件被手势
  // 判定忽略），键盘路径（item 聚焦 + Enter，SELECTION_KEYS）是自动化下最稳的确认方式。
  const confirmResult = await browser.execute((currentTestId) => {
    const element = document.querySelector<HTMLElement>(`[data-testid="${currentTestId}"]`);
    if (!element) {
      return {
        ok: false,
        reason: "item-missing",
        testIds: Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
          .map((el) => el.dataset.testid ?? "")
          .filter((id) => id.includes("select"))
          .slice(0, 40),
      };
    }
    element.focus();
    const focused = document.activeElement === element;
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    return { ok: true, focused };
  }, itemTestId);
  if (!confirmResult || confirmResult.ok !== true) {
    throw new Error(`${timeoutMsg}（item 确认阶段异常: ${JSON.stringify(confirmResult)}）`);
  }
  // 选择生效 ⇔ SelectContent 卸载（item 消失）；未关闭说明确认未生效，抛诊断。
  await browser
    .waitUntil(
      async () =>
        browser.execute(
          (currentTestId) => !document.querySelector(`[data-testid="${currentTestId}"]`),
          itemTestId,
        ),
      { timeout: 5000 },
    )
    .catch(() => {
      throw new Error(`${timeoutMsg}（item 确认后菜单未关闭——选择未生效）`);
    });
}

/** 通过 composer 工具条切换协作模式（switchCollaborationMode 命令）。 */
export async function switchV4Mode(mode: string) {
  await selectRadixOption(
    TID_CHAT_MODE_SELECT_TRIGGER,
    testId(TID_CHAT_MODE_SELECT_ITEM, mode),
    `v4 模式选择器没有出现目标模式项: ${mode}`,
  );
}

/** 读取 config 投影扩展锚点（data-mode / data-usage-*，M5 additive）。 */
export function getV4ConfigProjection(): Promise<{
  mode: string | null;
  planEnabled: boolean;
  usageUsed: number;
  usageMax: number;
}> {
  return browser.execute((modelTestId) => {
    const el = document.querySelector<HTMLElement>(`[data-testid="${modelTestId}"]`);
    return {
      mode: el?.getAttribute("data-mode") ?? null,
      usageUsed: Number(el?.getAttribute("data-usage-used") || 0),
      planEnabled: el?.getAttribute("data-plan-enabled") === "true",
      usageMax: Number(el?.getAttribute("data-usage-max") || 0),
    };
  }, TID_V4_MODEL_CONFIG);
}
