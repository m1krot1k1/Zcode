import {
  TID_CHAT_SUMMARY_PANEL,
  TID_CHAT_VIEW,
  TID_V4_QUEUE_ITEM,
  TID_V4_SESSION_PANE,
  TID_V4_STOP,
  testId,
} from "@zcode/shared/test-ids";
import { readV4ChatRootSnapshotInBrowser } from "../conversation-session-chat-root-snapshot-script.js";
import { getTaskStoreSnapshot as readTaskStoreSnapshotForDiagnostics } from "../conversation-session-store.js";

export interface ChatRootSnapshot {
  activeInputId: string | null;
  queueCount: number;
  runtimeStatus: string | null;
  sessionId: string | null;
  state: string | null;
  modelSwitchPending: boolean;
  stopRequested: boolean;
  targetId: string | null;
  targetObjective: string | null;
  targetStatus: string | null;
  taskId: string | null;
}

export async function waitForChatState(
  predicate: (snapshot: ChatRootSnapshot) => boolean,
  timeoutMsg: string,
  timeout = 30000,
) {
  let latest: ChatRootSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getChatRootSnapshot();
        return predicate(latest);
      },
      {
        timeout,
        timeoutMsg,
      },
    );
  } catch (error) {
    // 修复原因：WebdriverIO 的 timeoutMsg 在 waitUntil 开始时就会固定，
    // 直接拼 latest 会一直显示 null，导致定位状态枚举失败时缺少真实 UI 状态。
    latest = await getChatRootSnapshot();
    throw new Error(`${timeoutMsg}; latest=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
  return getChatRootSnapshot();
}

export async function getChatRootSnapshot(): Promise<ChatRootSnapshot> {
  const legacySnapshot = await browser.execute((chatViewTestId) => {
    const root = document.querySelector<HTMLElement>(`[data-testid="${chatViewTestId}"]`);
    if (!root) {
      return null;
    }
    const rawQueueCount = root.getAttribute("data-queue-count");
    return {
      activeInputId: root.getAttribute("data-active-input-id") || null,
      queueCount: rawQueueCount ? Number(rawQueueCount) : 0,
      runtimeStatus: root.getAttribute("data-runtime-status") || null,
      sessionId: root.getAttribute("data-session-id") || null,
      state: root.getAttribute("data-state") || null,
      modelSwitchPending: root.getAttribute("data-model-switch-pending") === "true",
      stopRequested: root.getAttribute("data-stop-requested") === "true",
      targetId: root.getAttribute("data-target-id") || null,
      targetObjective: root.getAttribute("data-target-objective") || null,
      targetStatus: root.getAttribute("data-target-status") || null,
      taskId: root.getAttribute("data-task-id") || null,
    } satisfies ChatRootSnapshot;
  }, TID_CHAT_VIEW);

  if (legacySnapshot) {
    return legacySnapshot;
  }

  // 修复原因：V4 硬切后 chat-view 的 data-* 状态合同已经删除；共享 helper
  // 仍需保留 legacy ChatRootSnapshot 的 Goal/stop/workspace 隔离语义。
  const v4Snapshot = await browser.execute(
    readV4ChatRootSnapshotInBrowser,
    testId(TID_V4_SESSION_PANE, "workspace-main"),
    TID_V4_QUEUE_ITEM,
    TID_V4_STOP,
  );
  if (v4Snapshot.bridgeError) {
    throw new Error(
      `无法读取 V4 conversation workspace: ${v4Snapshot.bridgeError}; ` +
        `workspaceKey=${v4Snapshot.workspaceKey}; paneSessionId=${v4Snapshot.paneSessionId}`,
    );
  }

  if (!v4Snapshot.taskId) {
    return {
      activeInputId: null,
      queueCount: v4Snapshot.queueCount,
      runtimeStatus: v4Snapshot.runtimeStatus,
      sessionId: null,
      state: v4Snapshot.runtimeStatus === "streaming" ? "streaming" : "idle",
      modelSwitchPending: v4Snapshot.modelSwitchPending,
      stopRequested: false,
      targetId: null,
      targetObjective: null,
      targetStatus: null,
      taskId: null,
    };
  }

  const taskStore = await readTaskStoreSnapshotForDiagnostics(
    v4Snapshot.taskId,
    v4Snapshot.workspaceKey ?? undefined,
  );
  if (!taskStore.workspaceKey) {
    throw new Error(
      `无法读取 V4 conversation task: ${taskStore.error}; ` +
        `workspaceKey=${v4Snapshot.workspaceKey}; taskId=${v4Snapshot.taskId}`,
    );
  }

  // 修复原因：V4 的 active goal 是 session status panel 的实时投影，taskListCache
  // 只承载侧栏摘要，首次创建的 session 在 title/cache 尚未回流时 taskMeta 可以为空。
  // 继续只读 taskMeta 会把已经运行的 goal 误判成无 target。
  const goalProjection = await browser.execute(
    (paneTestId, panelTestId) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
      const panel = pane?.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
      if (!panel) {
        return null;
      }
      return {
        objective: panel.getAttribute("data-goal-objective"),
        status: panel.getAttribute("data-goal-status"),
      };
    },
    testId(TID_V4_SESSION_PANE, "workspace-main"),
    TID_CHAT_SUMMARY_PANEL,
  );
  const hasBlockingGoalWork =
    goalProjection?.status === "active" || goalProjection?.status === "verifying";
  // Bug 根因：V4 Stop 控件已经可见时，store bridge 仍可能停在上一帧 completed。
  // 旧逻辑虽然在 DOM snapshot 合成了 streaming，最终却又被 taskStore 覆盖，
  // 导致 running/queue E2E 把真实运行轮误判成 idle。
  const effectiveRuntimeStatus =
    v4Snapshot.runtimeStatus === "streaming" ? "streaming" : taskStore.runtimeStatus;

  return {
    activeInputId: taskStore.activeInputId,
    queueCount: v4Snapshot.queueCount,
    runtimeStatus: effectiveRuntimeStatus,
    sessionId: v4Snapshot.taskId,
    // Goal continuation/verifier 是独立的 completion work，普通 turn runtime 在这段
    // 时间可以保持 completed；V4 helper 必须合成两套状态，才能保留 legacy 的
    // completion-blocking `state=streaming` 合同。
    state: effectiveRuntimeStatus === "streaming" || hasBlockingGoalWork ? "streaming" : "idle",
    modelSwitchPending: v4Snapshot.modelSwitchPending,
    stopRequested: taskStore.stopRequested,
    targetId: taskStore.taskMeta?.targetId ?? null,
    targetObjective: goalProjection?.objective ?? taskStore.taskMeta?.targetObjective ?? null,
    targetStatus: goalProjection?.status ?? taskStore.taskMeta?.targetStatus ?? null,
    taskId: v4Snapshot.taskId,
  };
}
