import {
  TID_V4_ROW,
  TID_V4_SESSION_PANE,
  TID_V4_STOP,
  TID_V4_TIMELINE,
  TID_V4_TIMELINE_BOTTOM,
  testId,
} from "@zcode/shared/test-ids";
import { clickTestIdByDom } from "../desktop-app.js";
import { getV4ComposerText } from "./composer.js";
import { V4_MAIN_PANE_ID } from "./constants.js";
import { getV4ConversationState, waitForV4Pane } from "./pane.js";
import { getV4QueueItems } from "./queue.js";
import type { V4CompactMarkerSnapshot, V4MessageSnapshot, V4TimelineScrollState } from "./types.js";

export async function waitForV4TimelineContaining(text: string, timeout = 60000) {
  await waitForV4Pane(
    (snapshot) => snapshot.timelineText.includes(text),
    `v4 timeline 中没有出现: ${text}`,
    timeout,
  );
}

/**
 * 只等待当前 V4 pane 的 assistant 正文，避免用户 prompt 中的同名 marker
 * 抢先满足完成屏障。formal case 不应为此回退到 legacy conversation helper。
 */
export async function waitForV4AssistantMessageContaining(
  text: string,
  timeout = 90000,
  paneId: string = V4_MAIN_PANE_ID,
) {
  let latestAssistantMessages: string[] = [];
  const readAssistantMessages = () =>
    browser.execute(
      (paneTestId, timelineTestId) => {
        const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
        const timeline = pane?.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
        return Array.from(timeline?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [])
          .filter((row) => row.classList.contains("group/assistant-row"))
          .map((row) => row.innerText.replace(/\u00a0/g, " ").trim());
      },
      testId(TID_V4_SESSION_PANE, paneId),
      TID_V4_TIMELINE,
    );

  try {
    await browser.waitUntil(
      async () => {
        latestAssistantMessages = await readAssistantMessages();
        return latestAssistantMessages.some((message) => message.includes(text));
      },
      {
        timeout,
        timeoutMsg: `v4 assistant 消息中没有出现: ${text}`,
      },
    );
  } catch (error) {
    latestAssistantMessages = await readAssistantMessages().catch(() => latestAssistantMessages);
    throw new Error(
      `v4 assistant 消息中没有出现: ${text}; latest=${JSON.stringify(latestAssistantMessages)}`,
      { cause: error },
    );
  }
}

export function getV4Messages(role?: "assistant" | "user"): Promise<V4MessageSnapshot[]> {
  return browser.execute(
    (paneTestId, timelineTestId, selectedRole) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
      const timeline = pane?.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
      return Array.from(timeline?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [])
        .map((element) => {
          const currentRole = element.classList.contains("group/user-row")
            ? "user"
            : element.classList.contains("group/assistant-row")
              ? "assistant"
              : null;
          return {
            id: element.getAttribute("data-row-id"),
            role: currentRole,
            text: element.innerText.replace(/\u00a0/g, " ").trim(),
          };
        })
        .filter(
          (message): message is V4MessageSnapshot =>
            message.role !== null && (!selectedRole || message.role === selectedRole),
        );
    },
    testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID),
    TID_V4_TIMELINE,
    role,
  );
}

export async function waitForV4UserMessageContaining(text: string) {
  let latestMessages: V4MessageSnapshot[] = [];
  try {
    await browser.waitUntil(
      async () => {
        latestMessages = await getV4Messages("user");
        return latestMessages.some((message) => message.text.includes(text));
      },
      {
        timeout: 60000,
        timeoutMsg: `v4 user 消息中没有出现: ${text}`,
      },
    );
  } catch (error) {
    const [state, composer, queue] = await Promise.all([
      getV4ConversationState().catch((stateError) => ({
        error: stateError instanceof Error ? stateError.message : String(stateError),
      })),
      getV4ComposerText().catch((composerError) =>
        composerError instanceof Error ? composerError.message : String(composerError),
      ),
      getV4QueueItems().catch((queueError) => [
        {
          queueItemId: "<queue-read-error>",
          text: queueError instanceof Error ? queueError.message : String(queueError),
        },
      ]),
    ]);
    throw new Error(
      `v4 user 消息中没有出现: ${text}; latestMessages=${JSON.stringify(latestMessages)}; state=${JSON.stringify(state)}; queue=${JSON.stringify(queue)}; composer=${JSON.stringify(composer)}`,
      { cause: error },
    );
  }
}

export async function assertVisibleV4UserMessagesNotContaining(text: string) {
  const messages = await getV4Messages("user");
  expect(messages.map((message) => message.text).join("\n")).not.toContain(text);
}

export async function clickV4Stop() {
  await clickTestIdByDom(TID_V4_STOP, {
    timeout: 30000,
    timeoutMsg: "v4 stop 按钮没有出现或不可点击",
  });
}

/** 读取结构化 compact marker；状态与来源只读 data-*，不依赖本地化 label。 */
export function getV4CompactMarkers(
  paneId: string = V4_MAIN_PANE_ID,
): Promise<V4CompactMarkerSnapshot[]> {
  return browser.execute(
    (paneTestId, rowPrefix) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
      return Array.from(
        pane?.querySelectorAll<HTMLElement>(
          `[data-testid^="${rowPrefix}-"][data-row-kind="timelineMarker"][data-marker-type="compact"]`,
        ) ?? [],
      ).map((row) => {
        const rowId = row.dataset.rowId ? Number(row.dataset.rowId) : Number.NaN;
        return {
          origin: row.dataset.origin ?? null,
          rowId: Number.isFinite(rowId) ? rowId : null,
          status: row.dataset.status ?? null,
          text: row.innerText.trim(),
        };
      });
    },
    testId(TID_V4_SESSION_PANE, paneId),
    TID_V4_ROW,
  );
}

/** 等待结构化 compact marker；不读取本地化 label。 */
export async function waitForV4CompactMarker(
  expected: { status: string; origin: "manual" | "auto" },
  timeout = 90000,
) {
  await browser.waitUntil(
    async () =>
      (await getV4CompactMarkers()).some(
        (marker) => marker.status === expected.status && marker.origin === expected.origin,
      ),
    {
      timeout,
      timeoutMsg: `v4 compact marker 未达到 ${expected.origin}/${expected.status}`,
    },
  );
}

// ── M5④ 虚拟滚动：timeline 滚动状态读写 ──
// 虚拟化后 DOM 只有挂载的 turn units；raw 行数分别走 timeline 容器的
// data-window-row-count（rows.window）与 data-total-row-count（rows.totalCount），
// 避免把 mounted unit、logical unit 与持久 raw row 三种计量单位混用。

export function getV4TimelineScrollState(): Promise<V4TimelineScrollState> {
  return browser.execute(
    (timelineTestId, bottomTestId) => {
      const timeline = document.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
      return {
        scrollTop: timeline?.scrollTop ?? 0,
        scrollHeight: timeline?.scrollHeight ?? 0,
        clientHeight: timeline?.clientHeight ?? 0,
        windowRowCount: Number(timeline?.getAttribute("data-window-row-count") ?? 0),
        renderUnitCount: Number(timeline?.getAttribute("data-render-unit-count") ?? 0),
        totalRowCount: Number(timeline?.getAttribute("data-total-row-count") ?? 0),
        following: timeline?.getAttribute("data-following") ?? null,
        mountedRenderUnitCount:
          timeline?.querySelectorAll('[data-v4-turn-unit="true"]').length ?? 0,
        hasBackToBottom: Boolean(document.querySelector(`[data-testid="${bottomTestId}"]`)),
      };
    },
    TID_V4_TIMELINE,
    TID_V4_TIMELINE_BOTTOM,
  );
}

/**
 * 把 timeline 滚到顶（scrollTop=0，触发原生 scroll 事件 → 解除底部跟随），
 * 并等虚拟化窗口对齐到新滚动位置后才返回。
 *
 * bugfix（虚拟化语义）：scrollTop 赋值后 scroll 事件要到下一渲染帧才派发，
 * virtualizer 收到事件才重渲染顶端行——期间 DOM 仍是旧的底部窗口
 * （实测：scrollTop=0 后旧行 58..72 还挂在视口下方 3272px 处），此时视口里没有
 * 任何行。CDP execute 往返快于一帧，调用方紧接着的 DOM 采样会读到过期窗口。
 * 这里等「有行真正落进视口」（虚拟窗口已对齐当前滚动位置）再返回。
 * 注意不能等 scrollTop 停在 0：到顶会触发 loadOlder，prepend 锚定会立刻把
 * scrollTop 平移到保持阅读位置的新值（这正是被测语义），0 只是瞬态。
 */
export async function scrollV4TimelineToTop() {
  await browser.execute((timelineTestId) => {
    const timeline = document.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
    if (!timeline) return;
    // 修复原因：ConversationTimeline 会先用 wheel/touch/key 记录真实用户意图，
    // 仅写 scrollTop 的脚本滚动可能被布局保护窗口归类为虚拟化校正，继续保持底部跟随。
    timeline.dispatchEvent(
      new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -600 }),
    );
    timeline.scrollTop = 0;
    timeline.dispatchEvent(new Event("scroll"));
  }, TID_V4_TIMELINE);
  await browser.waitUntil(
    async () =>
      browser.execute(
        (timelineTestId, rowPrefix) => {
          const timeline = document.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
          if (!timeline) return false;
          const timelineTop = timeline.getBoundingClientRect().top;
          const viewportHeight = timeline.clientHeight;
          return Array.from(
            timeline.querySelectorAll<HTMLElement>(`[data-testid^="${rowPrefix}-"]`),
          ).some((row) => {
            const rect = row.getBoundingClientRect();
            return rect.bottom - timelineTop > 0 && rect.top - timelineTop < viewportHeight;
          });
        },
        TID_V4_TIMELINE,
        TID_V4_ROW,
      ),
    {
      timeout: 15000,
      timeoutMsg: "scrollTop=0 后虚拟化窗口没有对齐到滚动位置（视口内始终没有行）",
    },
  );
}

/** 点「回到底部」按钮（恢复跟随并贴底）。 */
export async function clickV4TimelineBackToBottom() {
  return clickTestIdByDom(TID_V4_TIMELINE_BOTTOM, {
    timeout: 15000,
    timeoutMsg: "v4 回到底部按钮没有出现",
  });
}
