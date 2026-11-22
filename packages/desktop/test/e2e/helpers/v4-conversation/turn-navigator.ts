import {
  TID_V4_COMPOSER,
  TID_V4_SESSION_PANE,
  TID_V4_TIMELINE,
  TID_V4_TURN_NAVIGATOR,
  TID_V4_TURN_NAVIGATOR_ITEM,
  TID_V4_TURN_NAVIGATOR_TOOLTIP,
  testId,
} from "@zcode/shared/test-ids";
import { sel } from "../selectors.js";
import { V4_MAIN_PANE_ID } from "./constants.js";
import type { V4TurnNavigatorState } from "./types.js";

// ── TN：v4 对话轮次导航 minimap ──

export function getV4TurnNavigatorState(): Promise<V4TurnNavigatorState> {
  return browser.execute(
    (navigatorTestId, itemPrefix, timelineTestId, composerTestId, sessionPaneTestId) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${sessionPaneTestId}"]`);
      const scope: Document | HTMLElement = pane ?? document;
      const navigator = scope.querySelector<HTMLElement>(`[data-testid="${navigatorTestId}"]`);
      const timeline = scope.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
      const composer = scope.querySelector<HTMLElement>(`[data-testid="${composerTestId}"]`);
      const style = navigator ? window.getComputedStyle(navigator) : null;
      const rect = navigator?.getBoundingClientRect();
      const timelineRect = timeline?.getBoundingClientRect();
      const composerRect = composer?.getBoundingClientRect();
      const paneRect = pane?.getBoundingClientRect();
      const items = Array.from(
        navigator?.querySelectorAll<HTMLElement>(`[data-testid^="${itemPrefix}-"]`) ?? [],
      ).map((el) => {
        const itemRect = el.getBoundingClientRect();
        return {
          active: el.getAttribute("data-active") === "true",
          height: itemRect.height,
          left: itemRect.left,
          testId: el.dataset.testid ?? "",
          top: itemRect.top,
          turnId: el.getAttribute("data-turn-id"),
          unitIndex:
            el.getAttribute("data-unit-index") === null
              ? null
              : Number(el.getAttribute("data-unit-index")),
          visualColorTone: el.getAttribute("data-visual-color-tone"),
          visualScale:
            el.getAttribute("data-visual-scale") === null
              ? null
              : Number(el.getAttribute("data-visual-scale")),
          visualTone: el.getAttribute("data-visual-tone"),
        };
      });
      const firstItemLeftOffsetPx =
        items[0] && timelineRect ? items[0].left - timelineRect.left : Number.NaN;
      const firstItem = items[0];
      const lastItem = items.at(-1);
      const stackCenter =
        firstItem && lastItem ? (firstItem.top + lastItem.top + lastItem.height) / 2 : Number.NaN;
      const timelineCenter = timelineRect ? timelineRect.top + timelineRect.height / 2 : Number.NaN;
      return {
        centerOffsetPx: stackCenter - timelineCenter,
        composerLeftGutterPx:
          composerRect && timelineRect ? composerRect.left - timelineRect.left : Number.NaN,
        exists: Boolean(navigator),
        firstItemLeftOffsetPx,
        visible: Boolean(
          navigator &&
          style &&
          rect &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0,
        ),
        itemCount: items.length,
        items,
        paneWidthPx: paneRect?.width ?? Number.NaN,
      };
    },
    TID_V4_TURN_NAVIGATOR,
    TID_V4_TURN_NAVIGATOR_ITEM,
    TID_V4_TIMELINE,
    TID_V4_COMPOSER,
    testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID),
  );
}

export async function waitForV4TurnNavigator(
  predicate: (state: V4TurnNavigatorState) => boolean,
  timeoutMsg: string,
  timeout = 30000,
) {
  let latest: V4TurnNavigatorState | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getV4TurnNavigatorState();
        return predicate(latest);
      },
      { timeout, timeoutMsg },
    );
  } catch (error) {
    latest = await getV4TurnNavigatorState();
    throw new Error(`${timeoutMsg}; latest=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
  return getV4TurnNavigatorState();
}

async function getV4TurnNavigatorItemTestIdByIndex(index: number) {
  const state = await getV4TurnNavigatorState();
  const item = state.items[index];
  if (!item) {
    throw new Error(
      `v4 turn navigator item 不存在: index=${index}; latest=${JSON.stringify(state)}`,
    );
  }
  return item.testId;
}

export async function hoverV4TurnNavigatorItemByIndex(index: number) {
  const itemTestId = await getV4TurnNavigatorItemTestIdByIndex(index);
  const item = $(sel(itemTestId));
  await item.waitForDisplayed({ timeout: 15000 });
  await item.moveTo();
  return itemTestId;
}

export async function focusV4TurnNavigatorItemByIndex(index: number) {
  const itemTestId = await getV4TurnNavigatorItemTestIdByIndex(index);
  await browser.execute((currentTestId) => {
    document.querySelector<HTMLElement>(`[data-testid="${currentTestId}"]`)?.focus();
  }, itemTestId);
  return itemTestId;
}

export async function clickV4TurnNavigatorItemByIndex(index: number) {
  const itemTestId = await getV4TurnNavigatorItemTestIdByIndex(index);
  await browser.execute((currentTestId) => {
    document.querySelector<HTMLButtonElement>(`[data-testid="${currentTestId}"]`)?.click();
  }, itemTestId);
  return itemTestId;
}

export function getV4TurnNavigatorTooltipText(): Promise<string> {
  return browser.execute((tooltipPrefix) => {
    const tooltip = document.querySelector<HTMLElement>(`[data-testid^="${tooltipPrefix}-"]`);
    return (tooltip?.innerText ?? "").replace(/\u00a0/g, " ");
  }, TID_V4_TURN_NAVIGATOR_TOOLTIP);
}

export async function waitForV4TurnNavigatorTooltip(
  predicate: (text: string) => boolean,
  timeoutMsg: string,
  timeout = 15000,
) {
  let latest = "";
  try {
    await browser.waitUntil(
      async () => {
        latest = await getV4TurnNavigatorTooltipText();
        return predicate(latest);
      },
      { timeout, timeoutMsg },
    );
  } catch (error) {
    latest = await getV4TurnNavigatorTooltipText();
    throw new Error(`${timeoutMsg}; latest=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
  return getV4TurnNavigatorTooltipText();
}
