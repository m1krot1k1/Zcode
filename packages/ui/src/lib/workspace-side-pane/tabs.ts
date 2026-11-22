import { createUuid } from "@zcode/shared";
import { inferMediaPreview, isPptxPreviewPath, type CodeViewerSource } from "@/lib/codeViewer.js";
import { normalizeCodeViewerSource } from "@/lib/codeViewerSource.js";
import type {
  BrowserSidePaneTab,
  BrowserUseSidePaneTab,
  CodeViewerSidePaneTab,
  DeveloperToolsSidePaneTab,
  GitSidePaneTab,
  ModelTrajectorySidePaneTab,
  OpenScopedPlanDetailSideTabRequest,
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  OpenSelectionSideChatRequest,
  PlanDetailSidePaneTab,
  SelectionSideChatPaneTab,
  SubagentDirectorySidePaneTab,
  SubagentSessionSidePaneTab,
  TerminalSidePaneTab,
  WhiteboardSidePaneTab,
  WorkflowActorSessionSidePaneTab,
  WorkflowArtifactSidePaneTab,
  WorkflowRunDirectorySidePaneTab,
  WorkflowRunSidePaneTab,
  WorkflowWorkspaceSidePaneTab,
  WorkspaceSidePaneState,
  WorkspaceSidePaneTab,
} from "./types.js";

export function shouldMountSidePaneContent(
  isVisible: boolean,
  tabs: readonly WorkspaceSidePaneTab[],
): boolean {
  return (
    isVisible ||
    tabs.some(
      (tab) => tab.type === "browser" || tab.type === "browser-use" || tab.type === "bash-output",
    )
  );
}

export function shouldMountBrowserTabGuest(
  tab: BrowserSidePaneTab | BrowserUseSidePaneTab,
): boolean {
  return tab.residency !== "suspended" && tab.residency !== "suspend-pending";
}

export function normalizeWorkspaceSidePaneState(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState | null {
  if (!current) {
    return null;
  }

  // Treemapping 当前需要从侧边栏隐藏。旧版本可能已经把 treemapping tab
  // 写进了 workspace 级 side pane 记忆，这里在状态边界统一过滤，避免恢复后入口继续出现。
  const filteredTabs = current.tabs.filter((tab) => tab.type !== "treemapping");
  if (filteredTabs.length === 0) {
    return null;
  }

  // 多开引入 `ordinal` 之前创建的辅助对话 tab（HMR/同窗口旧内存状态）没有该
  // 字段，直接参与 getNextSelectionSideChatOrdinal 会得到 NaN/undefined 并造成标题
  // 编号冲突。这里在状态边界按 parent 分组回填最小可用编号，保持既有编号不变。
  let migratedOrdinal = false;
  const tabs = filteredTabs.map((tab, index, allTabs) => {
    if (tab.type !== "selection-side-chat" || Number.isInteger(tab.ordinal)) {
      return tab;
    }
    // allTabs 中本轮迭代已回填的 tab 被原位替换，天然带整数 ordinal 参与占用判定。
    const used = new Set(
      allTabs.flatMap((candidate) =>
        candidate.type === "selection-side-chat" &&
        candidate.workspaceKey === tab.workspaceKey &&
        candidate.parentSessionId === tab.parentSessionId &&
        Number.isInteger(candidate.ordinal)
          ? [candidate.ordinal]
          : [],
      ),
    );
    let ordinal = 1;
    while (used.has(ordinal)) ordinal += 1;
    migratedOrdinal = true;
    const migrated: SelectionSideChatPaneTab = { ...tab, ordinal };
    allTabs[index] = migrated;
    return migrated;
  });

  const activeTabId =
    current.activeTabId === "" || tabs.some((tab) => tab.id === current.activeTabId)
      ? current.activeTabId
      : tabs[tabs.length - 1]!.id;
  if (
    !migratedOrdinal &&
    tabs.length === current.tabs.length &&
    activeTabId === current.activeTabId
  ) {
    return current;
  }

  return {
    tabs,
    activeTabId,
  };
}

export function createBrowserSidePaneTab(options?: {
  tabId?: string;
  initialUrl?: string | null;
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  remoteSessionId?: string | null;
  agentOpened?: boolean;
}): BrowserSidePaneTab {
  return {
    id: options?.tabId ?? `browser:${createUuid()}`,
    type: "browser",
    ...(options?.ownerTaskId !== undefined ? { ownerTaskId: options.ownerTaskId } : {}),
    ...(options?.workspaceKey !== undefined ? { workspaceKey: options.workspaceKey } : {}),
    // human tab 过去从不写 remoteSessionId，而 stampSidePaneTabsOwnership 只补
    // ownerTaskId 未定义的 tab —— 凡是创建时就带 ownerTaskId 的（打开链接/终端 URL/popup/share）
    // 远程下该字段永久缺失。attach 侧 renderer 会用 workspaceRemoteSessionId 兜底冻结 main 的
    // owner，close 侧却按 tab 上的空值比对，scope 判失配后 tab 就再也关不掉。创建即冻结。
    ...(options?.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    faviconUrl: null,
    initialUrl: options?.initialUrl ?? null,
    ...(options?.agentOpened ? { agentOpened: true } : {}),
    openedAt: Date.now(),
    title: null,
  };
}

export function createGitSidePaneTab(): GitSidePaneTab {
  return { id: "git", type: "git", openedAt: Date.now() };
}

export function createModelTrajectorySidePaneTab(options: {
  taskId: string;
  title?: string | null;
}): ModelTrajectorySidePaneTab {
  return {
    // 同一个 task 复用同一个 tab，避免重复打开多份相同轨迹。
    id: `model-trajectory:${options.taskId}`,
    type: "model-trajectory",
    openedAt: Date.now(),
    taskId: options.taskId,
    title: options.title ?? null,
  };
}

export function createDeveloperToolsSidePaneTab(): DeveloperToolsSidePaneTab {
  return {
    id: "developer-tools",
    type: "developer-tools",
    openedAt: Date.now(),
  };
}

export function createTerminalSidePaneTab(options: {
  title: string;
  cwd?: string;
  remoteSessionId?: string | null;
}): TerminalSidePaneTab {
  return {
    id: `terminal:${createUuid()}`,
    type: "terminal",
    openedAt: Date.now(),
    title: options.title,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
  };
}

export function encodeSidePaneTabIdPart(value: string): string {
  return encodeURIComponent(value);
}

export function createSubagentSessionSidePaneTab(options: {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId?: string;
  parentSessionId: string;
  childSessionId: string;
  subagentType: string;
  title: string;
}): SubagentSessionSidePaneTab {
  const rootSessionId = options.rootSessionId ?? options.parentSessionId;
  return {
    id: [
      "subagent-session",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(rootSessionId),
      encodeSidePaneTabIdPart(options.childSessionId),
    ].join(":"),
    type: "subagent-session",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    rootSessionId,
    parentSessionId: options.parentSessionId,
    childSessionId: options.childSessionId,
    subagentType: options.subagentType,
    title: options.title.trim(),
  };
}

export function createSubagentDirectorySidePaneTab(options: {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId?: string;
  parentSessionId: string;
}): SubagentDirectorySidePaneTab {
  const rootSessionId = options.rootSessionId ?? options.parentSessionId;
  return {
    id: [
      "subagent-directory",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(rootSessionId),
      encodeSidePaneTabIdPart(options.parentSessionId),
    ].join(":"),
    type: "subagent-directory",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    rootSessionId,
    parentSessionId: options.parentSessionId,
  };
}

export function createSelectionSideChatPaneTab(
  options: OpenSelectionSideChatRequest & {
    workspaceKey: string;
    ordinal: number;
  },
): SelectionSideChatPaneTab {
  return {
    id: [
      "selection-side-chat",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.childSessionId),
    ].join(":"),
    type: "selection-side-chat",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    childSessionId: options.childSessionId,
    ordinal: options.ordinal,
  };
}

export function createPlanDetailSidePaneTab(
  options: OpenScopedPlanDetailSideTabRequest & { workspaceKey: string },
): PlanDetailSidePaneTab {
  return {
    id: [
      "plan-detail",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.toolCallId),
    ].join(":"),
    type: "plan-detail",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    toolCallId: options.toolCallId,
    markdown: options.markdown,
    ...(options.planFilePath ? { planFilePath: options.planFilePath } : {}),
  };
}

export function createWorkflowRunSidePaneTab(
  options: OpenScopedWorkflowRunSideTabRequest & { workspaceKey: string },
): WorkflowRunSidePaneTab {
  return {
    // 结构化 id：同一个 run 在同一个 workspace + 会话下永远是同一个 tab，重复点击幂等。
    id: [
      "workflow-run",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.runId),
    ].join(":"),
    type: "workflow-run",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    toolCallId: options.toolCallId,
    runId: options.runId,
    ...(options.workflowName ? { workflowName: options.workflowName } : {}),
    ...(options.phaseId ? { focusPhaseId: options.phaseId } : {}),
  };
}

export function createWorkflowRunDirectorySidePaneTab(
  options: OpenScopedWorkflowRunDirectorySideTabRequest & { workspaceKey: string },
): WorkflowRunDirectorySidePaneTab {
  return {
    // 结构化 id：一条对话只有一份 run 目录，所以页脚行重复点击幂等地聚焦同一个 tab。
    id: [
      "workflow-directory",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
    ].join(":"),
    type: "workflow-directory",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
  };
}

export function createWorkflowActorSessionSidePaneTab(
  options: OpenScopedWorkflowActorSessionSideTabRequest & { workspaceKey: string },
): WorkflowActorSessionSidePaneTab {
  return {
    // 结构化 id：同一个槽位在同一个 workspace + 对话下永远是同一个 tab，重复点击幂等。
    // 身份是 (runId, siteId@ordinal) 而不是会话 id：tab 可以在会话存在之前就开（未启动的
    // 药丸），先后从无会话与有会话两端打开必须落到同一个 tab；runId 在 id 里，两个 run 的
    // 同名实例仍不撞。
    id: [
      "workflow-actor-session",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.runId),
      encodeSidePaneTabIdPart(`${options.siteId}@${options.ordinal}`),
    ].join(":"),
    type: "workflow-actor-session",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    runId: options.runId,
    ...(options.actorSessionId ? { actorSessionId: options.actorSessionId } : {}),
    siteId: options.siteId,
    ordinal: options.ordinal,
    ...(options.actorName ? { actorName: options.actorName } : {}),
  };
}

export function createWorkflowWorkspaceSidePaneTab(
  options: OpenScopedWorkflowWorkspaceSideTabRequest & { workspaceKey: string },
): WorkflowWorkspaceSidePaneTab {
  return {
    // 结构化 id：(workspace, 父会话, run)。阶段**不在** id 里——一个 run 一份脚本 transcript，
    // 从 plan 站点开还是从 verify 站点开都是同一个 tab，只是落点不同。
    id: [
      "workflow-workspace",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.runId),
    ].join(":"),
    type: "workflow-workspace",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    toolCallId: options.toolCallId,
    runId: options.runId,
    ...(options.workflowName ? { workflowName: options.workflowName } : {}),
    ...(options.phaseId ? { focusPhaseId: options.phaseId } : {}),
  };
}

export function createWorkflowArtifactSidePaneTab(
  options: OpenScopedWorkflowArtifactSideTabRequest & { workspaceKey: string },
): WorkflowArtifactSidePaneTab {
  return {
    // 结构化 id：**不含版本**。同一个产物的 v1 与 v2 是同一件东西的两个时刻，再次点击
    // （通知 chip / 中枢 chip / 侧板卡片）只该聚焦同一个 tab 并翻到新版，不该并排开两个。
    id: [
      "workflow-artifact",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.runId),
      encodeSidePaneTabIdPart(options.artifactId),
    ].join(":"),
    type: "workflow-artifact",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    runId: options.runId,
    artifactId: options.artifactId,
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.title ? { title: options.title } : {}),
  };
}

export function createWhiteboardSidePaneTab(options: {
  boardId: string;
  title: string;
}): WhiteboardSidePaneTab {
  return {
    id: `whiteboard:${options.boardId}`,
    type: "whiteboard",
    boardId: options.boardId,
    openedAt: Date.now(),
    title: options.title,
  };
}

export function getCodeViewerTabSourceKey(source: CodeViewerSource): string | null {
  const workspaceScope = source.workspaceIdentity?.trim()
    ? source.workspaceIdentity.trim()
    : (source.workspacePath ?? "");
  const scopedKeyPrefix = workspaceScope ? `${workspaceScope}:` : "";
  // 文件树把 PPTX 表示为通用 `file` source，引用反向打开则使用带导航意图的
  // `pptx` source。旧 key 直接包含 source.type，导致同一 workspace 路径被拆成两个 tab。
  // source type 只是入口表示，不是文件身份；这里只归一 PPTX，避免扩大其它预览类型的语义。
  const resourceType =
    source.type === "pptx" || (source.type === "file" && isPptxPreviewPath(source.path))
      ? "pptx"
      : source.type === "media" || (source.type === "file" && inferMediaPreview(source.path))
        ? "media"
        : source.type;

  if (
    source.type === "file" ||
    source.type === "code-review" ||
    source.type === "image" ||
    source.type === "media" ||
    source.type === "pdf" ||
    source.type === "pptx"
  ) {
    return `${scopedKeyPrefix}${resourceType}:${source.path}`;
  }

  if (source.type === "text" && source.path) {
    return `${scopedKeyPrefix}${source.type}:${source.path}`;
  }

  if (source.type === "patch") {
    // file diff 之前只按 path 复用 tab，导致同一个文件在不同轮次产生的不同 patch
    // 会互相覆盖，看起来像“diff 面板只能打开一个 tab”。这里把 patch 内容摘要纳入 key，
    // 让不同 diff 可以并排保留，同时同一份 diff 重复点击仍然复用已有 tab。
    return `${scopedKeyPrefix}patch:${source.path ?? source.title}:${hashCodeViewerContent(source.patch)}`;
  }

  if (source.type === "multi-file-diff") {
    return `${scopedKeyPrefix}multi-file-diff:${source.path ?? source.title}:${hashCodeViewerContent(`${source.beforeContent}\0${source.afterContent}`)}`;
  }

  return null;
}

function hashCodeViewerContent(content: string): string {
  let hash = 0;
  for (let index = 0; index < content.length; index += 1) {
    hash = (hash * 31 + content.charCodeAt(index)) | 0;
  }

  return Math.abs(hash).toString(36);
}

export function createCodeViewerSidePaneTab(source: CodeViewerSource): CodeViewerSidePaneTab {
  const normalizedSource = normalizeCodeViewerSource(source);
  const sourceKey = getCodeViewerTabSourceKey(normalizedSource);
  return {
    id: sourceKey ? `code-viewer:${sourceKey}` : `code-viewer:${createUuid()}`,
    type: "code-viewer",
    openedAt: Date.now(),
    source: normalizedSource,
    sourceKey,
  };
}
