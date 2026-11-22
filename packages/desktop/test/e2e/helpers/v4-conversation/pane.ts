import {
  TID_CHAT_SUMMARY_PANEL,
  TID_TASK_ITEM,
  TID_V4_QUEUE_ITEM,
  TID_V4_ROW,
  TID_V4_SESSION_PANE,
  TID_V4_STOP,
  TID_V4_TIMELINE,
  testId,
} from "@zcode/shared/test-ids";
import { readV4ChatRootSnapshotInBrowser } from "../conversation-session-chat-root-snapshot-script.js";
import { getTaskStoreSnapshot as readTaskStoreSnapshotForDiagnostics } from "../conversation-session-store.js";
import { clickTestIdByDom } from "../desktop-app.js";
import { V4_MAIN_PANE_ID } from "./constants.js";
import type { V4ConversationStateSnapshot, V4PaneSnapshot } from "./types.js";

export function getV4PaneSnapshot(paneId: string = V4_MAIN_PANE_ID): Promise<V4PaneSnapshot> {
  return browser.execute(
    (paneTestId, stopTestId, timelineTestId, rowPrefix) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
      const timeline = pane?.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
      return {
        sessionId: pane?.getAttribute("data-session-id") ?? null,
        initialDraftProvider: pane?.getAttribute("data-initial-draft-provider") ?? "",
        initialDraftModel: pane?.getAttribute("data-initial-draft-model") ?? "",
        canStop: Boolean(pane?.querySelector(`[data-testid="${stopTestId}"]`)),
        timelineText: (timeline?.innerText ?? "").replace(/\u00a0/g, " "),
        rowCount: pane?.querySelectorAll(`[data-testid^="${rowPrefix}-"]`).length ?? 0,
      };
    },
    testId(TID_V4_SESSION_PANE, paneId),
    TID_V4_STOP,
    TID_V4_TIMELINE,
    TID_V4_ROW,
  );
}

export async function waitForV4Pane(
  predicate: (snapshot: V4PaneSnapshot) => boolean,
  timeoutMsg: string,
  timeout = 30000,
  paneId: string = V4_MAIN_PANE_ID,
) {
  let latest: V4PaneSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getV4PaneSnapshot(paneId);
        return predicate(latest);
      },
      { timeout, timeoutMsg },
    );
  } catch (error) {
    latest = await getV4PaneSnapshot(paneId);
    throw new Error(`${timeoutMsg}; latest=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
  // 原因：会话切换时 pane 可能短暂经过 draft。waitUntil 已命中目标快照后若再读一次 DOM，
  // 调用方拿到的可能反而是下一帧过渡态，造成“条件通过但返回值不满足条件”的假失败。
  return latest ?? getV4PaneSnapshot(paneId);
}

export async function waitForV4ConversationState(
  predicate: (snapshot: V4ConversationStateSnapshot) => boolean,
  timeoutMsg: string,
  timeout = 30000,
) {
  let latest: V4ConversationStateSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getV4ConversationState();
        return predicate(latest);
      },
      { timeout, timeoutMsg },
    );
  } catch (error) {
    latest = await getV4ConversationState();
    throw new Error(`${timeoutMsg}; latest=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
  // 修复原因：命中 predicate 后再次读取会跨过 running/completed 瞬时边界，
  // 让调用方拿到与 waitUntil 判定不一致的状态。
  return latest ?? getV4ConversationState();
}

export async function getV4ConversationState(): Promise<V4ConversationStateSnapshot> {
  const browserSnapshot = await browser.execute(
    readV4ChatRootSnapshotInBrowser,
    testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID),
    TID_V4_QUEUE_ITEM,
    TID_V4_STOP,
  );
  if (browserSnapshot.bridgeError) {
    throw new Error(
      `无法读取 V4 conversation workspace: ${browserSnapshot.bridgeError}; ` +
        `workspaceKey=${browserSnapshot.workspaceKey}; paneSessionId=${browserSnapshot.paneSessionId}`,
    );
  }

  if (!browserSnapshot.taskId) {
    return {
      activeInputId: null,
      modelSwitchPending: browserSnapshot.modelSwitchPending,
      queueCount: browserSnapshot.queueCount,
      runtimeStatus: browserSnapshot.runtimeStatus,
      sessionId: null,
      state: browserSnapshot.runtimeStatus === "streaming" ? "streaming" : "idle",
      stopRequested: false,
      targetId: null,
      targetObjective: null,
      targetStatus: null,
      taskId: null,
    };
  }

  const taskStore = await readTaskStoreSnapshotForDiagnostics(
    browserSnapshot.taskId,
    browserSnapshot.workspaceKey ?? undefined,
  );
  if (!taskStore.workspaceKey) {
    throw new Error(
      `无法读取 V4 conversation task: ${taskStore.error}; ` +
        `workspaceKey=${browserSnapshot.workspaceKey}; taskId=${browserSnapshot.taskId}`,
    );
  }

  const goalProjection = await browser.execute(
    (paneTestId, panelTestId) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
      const panel = pane?.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
      if (!panel) return null;
      return {
        objective: panel.getAttribute("data-goal-objective"),
        status: panel.getAttribute("data-goal-status"),
      };
    },
    testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID),
    TID_CHAT_SUMMARY_PANEL,
  );
  const hasBlockingGoalWork =
    goalProjection?.status === "active" || goalProjection?.status === "verifying";
  const effectiveRuntimeStatus =
    browserSnapshot.runtimeStatus === "streaming" ? "streaming" : taskStore.runtimeStatus;

  return {
    activeInputId: taskStore.activeInputId,
    modelSwitchPending: browserSnapshot.modelSwitchPending,
    queueCount: browserSnapshot.queueCount,
    runtimeStatus: effectiveRuntimeStatus,
    sessionId: browserSnapshot.taskId,
    state: effectiveRuntimeStatus === "streaming" || hasBlockingGoalWork ? "streaming" : "idle",
    stopRequested: taskStore.stopRequested,
    targetId: taskStore.taskMeta?.targetId ?? null,
    targetObjective: goalProjection?.objective ?? taskStore.taskMeta?.targetObjective ?? null,
    targetStatus: goalProjection?.status ?? taskStore.taskMeta?.targetStatus ?? null,
    taskId: browserSnapshot.taskId,
  };
}

/** 点击侧栏会话项并等待 primary pane 绑定到该 session。 */
export async function selectV4TaskById(sessionId: string, taskListTimeout = 15000) {
  await clickTestIdByDom(testId(TID_TASK_ITEM, sessionId), {
    timeout: taskListTimeout,
    timeoutMsg: `任务列表没有可点击的 v4 task: ${sessionId}`,
  });
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === sessionId,
    `点击侧栏 task 后 primary pane 没有切到 ${sessionId}`,
    30000,
    V4_MAIN_PANE_ID,
  );
}
