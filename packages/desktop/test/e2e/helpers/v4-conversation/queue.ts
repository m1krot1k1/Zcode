import {
  TID_V4_AUTODRAIN_TOGGLE,
  TID_V4_COMPOSER_CLEAR_QUEUE_SEND,
  TID_V4_COMPOSER_KEEP_QUEUE_SEND,
  TID_V4_FOLLOWUP_TOGGLE,
  TID_V4_PAUSED_QUEUE_SEND_DIALOG,
  TID_V4_QUEUE,
  TID_V4_QUEUE_PAUSED_BANNER,
  TID_V4_QUEUE_RESUME,
} from "@zcode/shared/test-ids";
import { clickTestIdByDom } from "../desktop-app.js";
import { sendV4Prompt } from "./composer.js";

/** 读取 v4 queue 面板当前项数与文本。 */
export function getV4QueueItems(): Promise<Array<{ queueItemId: string; text: string }>> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>('li[data-testid^="v4-queue-item-"]'))
      // 修复原因：删除/编辑/立即发送按钮以及行内输入都共享
      // `v4-queue-item-*` 前缀和 data-queue-item-id；只按前缀会把一个 item
      // 统计成 4~5 个，误报 projection 没有显示 queue。列表项元素是唯一权威行。
      .filter((el) => el.hasAttribute("data-queue-item-id"))
      .map((el) => ({
        queueItemId: el.getAttribute("data-queue-item-id") ?? "",
        text: (el.innerText || "").replace(/ /g, " ").trim(),
      })),
  );
}

/** 读取 queue.autoDrain 权威 DOM 投影，供 fault/恢复 case 证明错误后不会自动消费。 */
export function getV4QueueAutoDrain(): Promise<boolean | null> {
  return browser.execute((queueTestId) => {
    const queue = document.querySelector<HTMLElement>(`[data-testid="${queueTestId}"]`);
    const value = queue?.getAttribute("data-queue-auto-drain");
    return value === null || value === undefined ? null : value === "true";
  }, TID_V4_QUEUE);
}

export async function waitForV4QueueCount(expected: number, timeout = 30000) {
  await browser.waitUntil(async () => (await getV4QueueItems()).length === expected, {
    timeout,
    timeoutMsg: `v4 queue 项数没有达到 ${expected}`,
  });
}

/** 点击某 queue 项的删除按钮（按 queueItemId）。 */
export async function clickV4QueueItemDelete(queueItemId: string) {
  return browser.execute((id) => {
    const btn = document.querySelector<HTMLButtonElement>(
      `[data-testid="v4-queue-item-delete-${id}"]`,
    );
    btn?.click();
    return Boolean(btn);
  }, queueItemId);
}

/** 点击某 queue 项的编辑按钮（按 queueItemId，撤回到 composer）。 */
export async function clickV4QueueItemEdit(queueItemId: string, clickCount = 1) {
  return browser.execute(
    (id, count) => {
      const btn = document.querySelector<HTMLButtonElement>(
        `[data-testid="v4-queue-item-edit-${id}"]`,
      );
      for (let index = 0; index < count; index += 1) {
        btn?.click();
      }
      return Boolean(btn);
    },
    queueItemId,
    clickCount,
  );
}

/** 点击某 queue 项的立即发送按钮（按 queueItemId）。 */
export async function clickV4QueueItemSendNow(queueItemId: string) {
  return browser.execute((id) => {
    const btn = document.querySelector<HTMLButtonElement>(
      `[data-testid="v4-queue-item-send-now-${id}"]`,
    );
    btn?.click();
    return Boolean(btn);
  }, queueItemId);
}

// ── 暂停队列发送确认与恢复（B06/B07/B14/B15/C08）──
// 原因：旧 E2E 把 clear/keep 当作 composer 的两颗替代发送按钮；产品交互改成
// 正常发送按钮先打开 modal 后，必须显式走“发送 → 等 modal → 选择”，否则测试会
// 把只打开弹窗误判成消息已经提交。

/** 暂停队列发送确认 modal 与两个操作按钮是否同时存在。 */
export function hasV4PausedQueueSendDialog(): Promise<boolean> {
  return browser.execute(
    (dialogTestId, clearTestId, keepTestId) =>
      Boolean(
        document.querySelector(`[data-testid="${dialogTestId}"]`) &&
        document.querySelector(`[data-testid="${clearTestId}"]`) &&
        document.querySelector(`[data-testid="${keepTestId}"]`),
      ),
    TID_V4_PAUSED_QUEUE_SEND_DIALOG,
    TID_V4_COMPOSER_CLEAR_QUEUE_SEND,
    TID_V4_COMPOSER_KEEP_QUEUE_SEND,
  );
}

/** 等待正常发送按钮提交后出现暂停队列确认 modal。 */
export async function waitForV4PausedQueueSendDialog(timeout = 30000) {
  await browser.waitUntil(async () => hasV4PausedQueueSendDialog(), {
    timeout,
    timeoutMsg: "暂停队列发送确认 modal 没有出现（清空/发送按钮缺失）",
  });
}

/** 通过正常发送按钮打开 modal，再选择“保留队列并发送”。 */
export async function sendV4PausedQueueKeep(prompt: string) {
  await sendV4Prompt(prompt);
  await waitForV4PausedQueueSendDialog();
  await clickTestIdByDom(TID_V4_COMPOSER_KEEP_QUEUE_SEND, {
    timeout: 15000,
    timeoutMsg: "暂停队列确认 modal 的“发送消息”按钮没有出现或不可点击",
  });
}

/** 通过正常发送按钮打开 modal，再选择“清空队列并发送”。 */
export async function sendV4PausedQueueClear(prompt: string) {
  await sendV4Prompt(prompt);
  await waitForV4PausedQueueSendDialog();
  await clickTestIdByDom(TID_V4_COMPOSER_CLEAR_QUEUE_SEND, {
    timeout: 15000,
    timeoutMsg: "暂停队列确认 modal 的“清空队列”按钮没有出现或不可点击",
  });
}

/** 暂停提示条与“继续”按钮是否同时存在。 */
export function hasV4PausedQueueBanner(): Promise<boolean> {
  return browser.execute(
    (bannerTestId, resumeTestId) =>
      Boolean(
        document.querySelector(`[data-testid="${bannerTestId}"]`) &&
        document.querySelector(`[data-testid="${resumeTestId}"]`),
      ),
    TID_V4_QUEUE_PAUSED_BANNER,
    TID_V4_QUEUE_RESUME,
  );
}

export async function waitForV4PausedQueueBanner(timeout = 30000) {
  await browser.waitUntil(async () => hasV4PausedQueueBanner(), {
    timeout,
    timeoutMsg: "暂停队列提示条或“继续”按钮没有出现",
  });
}

/** 点击暂停队列提示条的“继续”，恢复 CLI FIFO 自动消费。 */
export async function clickV4PausedQueueResume() {
  await waitForV4PausedQueueBanner();
  await clickTestIdByDom(TID_V4_QUEUE_RESUME, {
    timeout: 15000,
    timeoutMsg: "暂停队列提示条的“继续”按钮没有出现或不可点击",
  });
}

/** 读取输入控制条：autoDrain（data-auto-drain）与 followupMode（data-followup-mode）。 */
export function getV4InputControlState(): Promise<{
  autoDrain: string | null;
  followupMode: string | null;
}> {
  return browser.execute(
    (autoDrainTestId, followupTestId) => {
      const autoBtn = document.querySelector<HTMLElement>(`[data-testid="${autoDrainTestId}"]`);
      const followupBtn = document.querySelector<HTMLElement>(`[data-testid="${followupTestId}"]`);
      return {
        autoDrain: autoBtn?.getAttribute("data-auto-drain") ?? null,
        followupMode: followupBtn?.getAttribute("data-followup-mode") ?? null,
      };
    },
    TID_V4_AUTODRAIN_TOGGLE,
    TID_V4_FOLLOWUP_TOGGLE,
  );
}

/** 点击 autoDrain 开关（setAutoDrain 命令）。 */
export async function clickV4AutoDrainToggle() {
  return clickTestIdByDom(TID_V4_AUTODRAIN_TOGGLE, {
    timeout: 15000,
    timeoutMsg: "v4 autoDrain 开关没有出现",
  });
}

/** 点击 followupMode 开关（setFollowupMode 命令）。 */
export async function clickV4FollowupToggle() {
  return clickTestIdByDom(TID_V4_FOLLOWUP_TOGGLE, {
    timeout: 15000,
    timeoutMsg: "v4 followupMode 开关没有出现",
  });
}

/** 拖拽某 queue 项到目标 queue 项上（按 queueItemId）。 */
export async function dragV4QueueItemOnto(sourceQueueItemId: string, targetQueueItemId: string) {
  const positions = (await browser.execute(
    (sourceId, targetId) => {
      const dragHandle = Array.from(
        document.querySelectorAll<HTMLElement>('[data-v4-queue-drag-handle="true"]'),
      ).find((el) => el.getAttribute("data-queue-item-id") === sourceId);
      const targetItem = Array.from(
        document.querySelectorAll<HTMLElement>("li[data-queue-item-id]"),
      ).find((el) => el.getAttribute("data-queue-item-id") === targetId);

      if (!dragHandle || !targetItem) {
        return {
          ok: false,
          reason: "missing-element",
          hasDragHandle: Boolean(dragHandle),
          hasTargetItem: Boolean(targetItem),
        };
      }

      const dragRect = dragHandle.getBoundingClientRect();
      const targetRect = targetItem.getBoundingClientRect();
      return {
        ok: true,
        startX: Math.round(dragRect.left + dragRect.width / 2),
        startY: Math.round(dragRect.top + dragRect.height / 2),
        endX: Math.round(targetRect.left + targetRect.width / 2),
        endY: Math.round(targetRect.top + targetRect.height / 2),
      };
    },
    sourceQueueItemId,
    targetQueueItemId,
  )) as
    | { ok: true; startX: number; startY: number; endX: number; endY: number }
    | {
        ok: false;
        reason: string;
        hasDragHandle: boolean;
        hasTargetItem: boolean;
      };

  if (!positions.ok) {
    throw new Error(`v4 队列项拖拽元素不存在: ${JSON.stringify(positions)}`);
  }

  await browser.performActions([
    {
      id: "v4-queue-drag-pointer",
      type: "pointer",
      parameters: { pointerType: "mouse" },
      actions: [
        {
          type: "pointerMove",
          duration: 0,
          x: positions.startX,
          y: positions.startY,
        },
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: 80 },
        {
          type: "pointerMove",
          duration: 120,
          x: positions.startX,
          y: positions.startY - 10,
        },
        {
          type: "pointerMove",
          duration: 260,
          x: positions.endX,
          y: positions.endY,
        },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await browser.releaseActions();

  // 修复原因：dnd-kit 会屏蔽拖拽结束后的紧随 click，E2E 用空白 click 消耗这次屏蔽，
  // 避免后续按钮点击被误吞。
  await browser.execute(() => {
    document.body.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
      }),
    );
  });
  await browser.pause(50);
}
