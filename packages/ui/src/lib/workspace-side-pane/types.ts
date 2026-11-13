import { type BrowserTabResidencyState } from "@zcode/shared";
import type { PluginUiSidePaneTab } from "@/plugin-ui/contract.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";

export interface BrowserSidePaneTab {
  id: string;
  type: "browser";
  /** 打开 tab 时冻结的对话归属；null 表示草稿态。 */
  ownerTaskId?: string | null;
  /** 工作区隔离 key（workspaceIdentity || workspacePath）。 */
  workspaceKey?: string | null;
  remoteSessionId?: string | null;
  faviconUrl?: string | null;
  initialUrl?: string | null;
  /** 由 Agent 控制的页面触发的 popup；不应套用人类浏览器的持久化显示偏好。 */
  agentOpened?: boolean;
  openedAt?: number;
  title?: string | null;
  residency?: BrowserTabResidencyState;
  residencyGeneration?: number;
}

export type BrowserSidePaneMetadata = Partial<Pick<BrowserSidePaneTab, "faviconUrl" | "title">>;

export const BROWSER_USE_OPERATION_INDICATOR_DURATION_MS = 5_000;

export interface BrowserPermissionsSidePaneTab {
  id: string;
  type: "browser-permissions";
  origin: string;
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
}

export interface GitSidePaneTab {
  id: "git";
  type: "git";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
}

export interface FileManagerTarget {
  workspacePath: string;
  workspaceName?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  revealPath?: string;
  temporaryExternalDirectory?: boolean;
}

export interface FileManagerSidePaneTab {
  id: string;
  type: "file-manager";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  target: FileManagerTarget;
  source: CodeViewerSource | null;
}

export interface CodeViewerSidePaneTab {
  id: string;
  type: "code-viewer";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  source: CodeViewerSource;
  sourceKey: string | null;
}

export type TreemappingSidePaneSource =
  | { kind: "current" }
  | { kind: "message"; messageId: string; turnIndex?: number };

export interface TreemappingSidePaneTab {
  id: "treemapping";
  type: "treemapping";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  source?: TreemappingSidePaneSource;
}

export interface WhiteboardSidePaneTab {
  id: string;
  type: "whiteboard";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  boardId: string;
  openedAt?: number;
  title: string;
}

export interface ModelTrajectorySidePaneTab {
  id: string;
  type: "model-trajectory";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  /** 目标 task/session id；model-io 按该 id 匹配。 */
  taskId: string;
  title?: string | null;
}

export interface PluginMarketSidePaneTab {
  id: "plugin-market";
  type: "plugin-market";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
}

export interface DeveloperToolsSidePaneTab {
  id: "developer-tools";
  type: "developer-tools";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
}

export interface AgentWorkbenchSidePaneTab {
  id: string;
  type: "agent-workbench";
  ownerTaskId?: null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface TerminalSidePaneTab {
  id: string;
  type: "terminal";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  title: string;
  cwd?: string;
  remoteSessionId?: string | null;
}

/** browser-use 受控浏览器视图（renderer `<webview>` + main CDP）。 */
export interface BrowserUseSidePaneTab {
  id: string;
  type: "browser-use";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  remoteSessionId?: string | null;
  sessionId: string;
  /** main 分配的 opaque IAB tab identity，也是 webview attach key。 */
  tabId: string;
  browserId?: string;
  browserGeneration?: number;
  openedAt?: number;
  title?: string | null;
  faviconUrl?: string | null;
  residency?: BrowserTabResidencyState;
  residencyGeneration?: number;
  /** 最近一次 agent browser-use 操作的 UI 指示截止时间。 */
  browserUseOperationUntil?: number;
  /** 模型布局命令对应的单调版本；目标 view 据此重建 ResizeObserver 基线。 */
  browserUseResizeBaselineVersion?: number;
}

export interface OpenBackgroundBashSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId: string;
  sessionId: string;
  workId: string;
  title: string;
}

export interface BackgroundBashSidePaneTab extends OpenBackgroundBashSideTabRequest {
  id: string;
  type: "bash-output";
  workspaceKey: string;
  ownerTaskId: string;
  openedAt?: number;
}

export interface SubagentSessionSidePaneTab {
  id: string;
  type: "subagent-session";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId: string;
  parentSessionId: string;
  childSessionId: string;
  subagentType: string;
  title: string;
}

export interface SubagentDirectorySidePaneTab {
  id: string;
  type: "subagent-directory";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId: string;
  parentSessionId: string;
}

export interface SelectionSideChatPaneTab {
  id: string;
  type: "selection-side-chat";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  childSessionId: string;
  ordinal: number;
}

export interface PlanDetailSidePaneTab {
  id: string;
  type: "plan-detail";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  toolCallId: string;
  markdown: string;
  planFilePath?: string;
}

export interface OpenPlanDetailSideTabRequest {
  parentSessionId: string;
  toolCallId: string;
  markdown: string;
  planFilePath?: string;
}

/**
 * workflow run 的详情页 tab。
 *
 * 身份是 **run**（`runId`），不是发起它的工具调用：一次 CreateWorkflow 只启一个 run，
 * 但 run 才是引擎、journal 与 `cancelBackgroundWork {workId}` 三处共用的键
 * （`workId ≡ taskId ≡ runId`）。`toolCallId` 仍要带上——静态因果图在那条工具调用行的
 * display 里，详情页按它在父会话投影里找图。
 *
 * ## 这个 tab 刻意**没有 GC**，别加
 *
 * 看起来很自然的两条回收规则都是错的：
 *
 * - **run 被 `WORKFLOW_RUNS_LIMITS.maxRuns`（8 条）淘汰时不要关它。** 详情页的事件日志读的是
 *   **journal**，不是 `workflowRuns` 投影。被淘汰的 run 丢的只有实时叠加状态，它的事件日志
 *   仍然**完整**——那恰恰是用户会把这个 tab 留着的场景（回看一次已结束的 run 是怎么跑的）。
 *   自动关掉等于亲手销毁一次已完结 run 的唯一持久视图。淘汰只降级成详情页里那块
 *   「已不在实时跟踪范围内」的空态，措辞也必须诚实：丢的是实时状态，run 本身没有消失。
 * - **父会话 edit / retry 时不要关它。** run 身份不会因为对话被改写而失效，最多是那条工具
 *   调用行不在窗口里了——那同样只降级成"没有图可画"，不是"这个 tab 该消失"。
 *
 * 可见性已经按 `parentSessionId` 收窄（同 plan-detail），所以 tab 不会泄漏到别的对话里。
 * `syncSubagentSessionSidePaneTabs` 那套回收只作用于 subagent-session，不要把它扩过来。
 */
export interface WorkflowRunSidePaneTab {
  id: string;
  type: "workflow-run";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  toolCallId: string;
  runId: string;
  /** 打开时冻结的展示名，仅作投影缺席（run 被淘汰 / 冷启动）时的标题兜底。 */
  workflowName?: string;
  /** 落点：展开这一站、列出全部、节头滚到顶。缺席即停在原处。 */
  focusPhaseId?: string;
}

export interface OpenWorkflowRunSideTabRequest {
  parentSessionId: string;
  toolCallId: string;
  runId: string;
  workflowName?: string;
  /** 落点：详情页展开这一站、列出全部、滚到节头。缺席即停在原处。 */
  phaseId?: string;
  /**
   * 「配置」之后面板跟着工作流走：
   * 把显示这个 run 的 tab **原地**换成新 run 的 tab——同一个位置、沿用它的名字与归属。没有这样的
   * tab（已关掉）就什么都不做：面板不会为此重新打开。
   */
  replaceRunId?: string;
}

/**
 * 一条对话的 workflow run 目录 tab。
 *
 * 身份是**对话**（`parentSessionId`）：一条对话只有一份 run 目录，所以页脚行重复点击幂等地
 * 聚焦同一个 tab——与 `subagent-directory` 同构。
 *
 * 这个 tab 不带任何 run 数据：目录页自己按 `parentSessionId` 读一页 journal（run 目录的
 * 单一信源）。把摘要冻进 tab 会让「重启后打开一个恢复出来的 tab」显示
 * 一份过期名单，而它恰恰就是为重启后那一刻存在的。
 */
export interface WorkflowRunDirectorySidePaneTab {
  id: string;
  type: "workflow-directory";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
}

export interface OpenWorkflowRunDirectorySideTabRequest {
  parentSessionId: string;
}

/**
 * 一个 dwf actor 实例的 transcript tab。
 *
 * 身份是 **actor 会话**：一个实例一条真实持久会话，所以 `actorSessionId` 就是 tab 身份。
 * `runId` / `siteId` / `ordinal` 一起带上是为了标题、搜索与排查——它们是 journal 的键，
 * 而会话 id 是 run service 按 `(runId, actorRef)` 铸造出来的，不该被 renderer 反解。
 *
 * ## 为什么是**独立类型**，不是给 `subagent-session` 加一个变体标记
 *
 * `syncSubagentSessionSidePaneTabs` 会删掉 `childSessionId` 不在 `validChildSessionIds`
 * 里的 subagent tab，而 actor 会话**永远不在**那个集合里（它不是子智能体的子会话）。复用
 * 那个类型等于：父会话的 subagent 投影每更新一次，这个 tab 就被回收一次。修法只能是教那套
 * 回收认识变体标记，也就是同样的工作量，只是把不变式藏进了回收逻辑里。
 *
 * 另外两处也会打架：subagent tab 的可见性按 `rootSessionId` 收窄（actor tab 要按
 * `parentSessionId`，同 workflow-run），而 `lastActiveSubagentTabByRootRef` 按
 * `rootSessionId` 记忆 active tab——actor tab 没有、也不该有一个 root 会话。
 *
 * ## GC：同 `workflow-run`，**没有**，别加
 *
 * actor 会话在 run 结束后继续存在（这正是持久化落库换来的durable-audit）。run 被 8-run
 * 上限淘汰、父会话 edit/retry、run 结算——三者都不该关掉一份仍然可读的 transcript。
 * 可见性已按 `parentSessionId` 收窄，所以它也不会泄漏到别的对话里。
 */
export interface WorkflowActorSessionSidePaneTab {
  id: string;
  type: "workflow-actor-session";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  runId: string;
  /**
   * actor 会话 id：嵌套只读 SessionPane 读的那条会话。**可缺席**——从一枚还没启动的药丸开的
   * tab 打开时没有会话；面板按
   * 槽位在实时投影里找它，找到即自愈。身份不在这里，在 (runId, siteId, ordinal)。
   */
  actorSessionId?: string;
  /** actor 站点 id 与序号：与 runId 一起是 tab 的身份，从不参与命名。 */
  siteId: string;
  ordinal: number;
  /** 脚本里写下的名字（`agent("reviewer")`）；分析拿不到字面量时缺席，标题走本地化兜底。 */
  actorName?: string;
}

export interface OpenWorkflowActorSessionSideTabRequest {
  parentSessionId: string;
  runId: string;
  /** 打开时已知的会话 id；未启动的槽位缺席。 */
  actorSessionId?: string;
  siteId: string;
  ordinal: number;
  actorName?: string;
}

export interface OpenScopedWorkflowActorSessionSideTabRequest extends OpenWorkflowActorSessionSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

/**
 * 一个 workflow run 的**脚本 transcript** tab：
 * 脚本里 `files.*` / `git.*` / `world.run` 的每一次调用回放成一张工具卡。
 *
 * 与 actor transcript 同一逻辑层级（都是「run 里某个参与者做过什么」），但工作区没有会话，
 * 所以它是自己的类型而不是 actor tab 的变体：面板不嵌 SessionPane，而是拿两条 journal 查询
 * 自己画卡片。身份是 **(workspace, 父会话, run)**——一个 run 一个 tab，从哪一站点开都是它；
 * `focusPhaseId` 只是落点（滚到那一站的第一张卡），每次打开都重新落。
 *
 * GC：同 `workflow-actor-session`，**没有**——journal 行在 run 结束后继续存在，这份回放正是
 * 为事后审计而存在的。可见性按 `parentSessionId` 收窄。
 */
export interface WorkflowWorkspaceSidePaneTab {
  id: string;
  type: "workflow-workspace";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  /** 发起该 run 的工具调用 id：静态图（阶段名、步标签）挂在那条行上，与 workflow-run tab 同一条路。 */
  toolCallId: string;
  runId: string;
  /** 打开时冻结的展示名，仅作投影缺席时的标题兜底。 */
  workflowName?: string;
  /** 落点：滚到这一站的第一张卡；还没到的站落到末尾。缺席即停在原处。 */
  focusPhaseId?: string;
}

export interface OpenWorkflowWorkspaceSideTabRequest {
  parentSessionId: string;
  toolCallId: string;
  runId: string;
  workflowName?: string;
  phaseId?: string;
}

export interface OpenScopedWorkflowWorkspaceSideTabRequest extends OpenWorkflowWorkspaceSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

/**
 * 一个 dwf **产物**的全尺寸查看 tab。
 *
 * ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出（一个文件 / 一段 markdown /
 * 一张 journal 投影出来的看板），**不是**引擎内部 `RunSettlement.artifact` 那个「脚本顶层
 * 返回值」。
 *
 * 身份是 **(run, 产物 id)**，不含版本：同一个产物反复发布是同一件东西的新版本，再点一次
 * 应当**聚焦已开的 tab 并翻到最新版**，而不是并排开出 v1 / v2 两个 tab。`version` 因此只是
 * 打开时的初始落点（通知 chip / 中枢 chip 都不带版本号，缺席即最新版），头部的版本步进器
 * 才是真正的版本导航。
 *
 * ## GC：同 `workflow-run`，**没有**，别加
 *
 * 产物的字节在发布时刻就拷进了 store（发布即钉住的约定），所以一个被 8-run 上限
 * 淘汰、甚至整条对话被 edit 重写的 run，它的产物仍然**完整可读**——那正是用户会把这个 tab
 * 留着的场景。可见性已按 `parentSessionId` 收窄，tab 不会泄漏到别的对话里。
 */
export interface WorkflowArtifactSidePaneTab {
  id: string;
  type: "workflow-artifact";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  runId: string;
  /** 产物 id（脚本里的编译期字面量，`[A-Za-z0-9_.-]` ≤ 64）。 */
  artifactId: string;
  /** 打开时的初始版本；缺席即最新版。**不进 tab 身份**——见类型上那段注释。 */
  version?: number;
  /** 打开时冻结的展示名，仅作元数据缺席（冷恢复 / 老 CLI）时的标题兜底。 */
  title?: string;
}

export interface OpenWorkflowArtifactSideTabRequest {
  parentSessionId: string;
  runId: string;
  artifactId: string;
  version?: number;
  title?: string;
  /**
   * 最新版的 contentType（表面上的摘要带得到就带）。`useAppPanels.handleOpenWorkflowArtifact`
   * 据它决定 html 产物是直接开浏览器 tab 还是开产物 tab；缺席即一律开产物 tab。
   */
  contentType?: string;
  /**
   * 工作区相对的原路径。只有已经合并过 journal 的表面（run 侧板）带得到；缺席时由
   * `handleOpenWorkflowArtifact` 自己查 journal 补齐——摘要刻意不带它（状态帧体积）。
   */
  sourcePath?: string;
}

export interface OpenScopedWorkflowArtifactSideTabRequest extends OpenWorkflowArtifactSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface OpenScopedWorkflowRunSideTabRequest extends OpenWorkflowRunSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface OpenScopedWorkflowRunDirectorySideTabRequest extends OpenWorkflowRunDirectorySideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface OpenScopedPlanDetailSideTabRequest extends OpenPlanDetailSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface OpenSelectionSideChatRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  childSessionId: string;
  /** active child 已确定不存在时，由宿主原子替换对应旧 tab。 */
  replacesChildSessionId?: string;
}

export interface OpenSubagentSideTabRequest {
  rootSessionId?: string;
  parentSessionId: string;
  childSessionId: string;
  subagentType: string;
  title: string;
}

export interface OpenSubagentDirectorySideTabRequest {
  rootSessionId?: string;
  parentSessionId: string;
}

export interface OpenScopedSubagentDirectorySideTabRequest extends OpenSubagentDirectorySideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface SyncSubagentSessionTabsRequest {
  rootSessionId: string;
  parentSessionId: string;
  validChildSessionIds: readonly string[];
}

export interface OpenScopedSubagentSideTabRequest extends OpenSubagentSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface NewTabSidePaneTab {
  id: string;
  type: "new-tab";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
}

export type WorkspaceSidePaneTab =
  | FileManagerSidePaneTab
  | NewTabSidePaneTab
  | BackgroundBashSidePaneTab
  | BrowserSidePaneTab
  | BrowserPermissionsSidePaneTab
  | GitSidePaneTab
  | CodeViewerSidePaneTab
  | TreemappingSidePaneTab
  | WhiteboardSidePaneTab
  | ModelTrajectorySidePaneTab
  | PluginMarketSidePaneTab
  | DeveloperToolsSidePaneTab
  | AgentWorkbenchSidePaneTab
  | TerminalSidePaneTab
  | BrowserUseSidePaneTab
  | SubagentSessionSidePaneTab
  | SubagentDirectorySidePaneTab
  | SelectionSideChatPaneTab
  | PlanDetailSidePaneTab
  | PluginUiSidePaneTab
  | WorkflowRunSidePaneTab
  | WorkflowRunDirectorySidePaneTab
  | WorkflowActorSessionSidePaneTab
  | WorkflowWorkspaceSidePaneTab
  | WorkflowArtifactSidePaneTab;

export interface WorkspaceSidePaneState {
  tabs: WorkspaceSidePaneTab[];
  activeTabId: string;
}
