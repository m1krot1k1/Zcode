export interface V4PaneSnapshot {
  /** data-session-id；draft 表示未绑定 CLI session。 */
  sessionId: string | null;
  initialDraftProvider: string;
  initialDraftModel: string;
  /** stop 按钮是否存在（= projection.control.canStop）。 */
  canStop: boolean;
  /** timeline 全部行文本（虚拟滚动下为当前渲染窗口内的行）。 */
  timelineText: string;
  rowCount: number;
}

export interface V4CompactMarkerSnapshot {
  origin: string | null;
  rowId: number | null;
  status: string | null;
  text: string;
}

export interface V4ConversationStateSnapshot {
  activeInputId: string | null;
  modelSwitchPending: boolean;
  queueCount: number;
  runtimeStatus: string | null;
  sessionId: string | null;
  state: string | null;
  stopRequested: boolean;
  targetId: string | null;
  targetObjective: string | null;
  targetStatus: string | null;
  taskId: string | null;
}

export interface V4MessageSnapshot {
  id: string | null;
  role: "assistant" | "user";
  text: string;
}

export interface V4TimelineScrollState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** raw projection window 行数。 */
  windowRowCount: number;
  /** turn-level logical render unit 数。 */
  renderUnitCount: number;
  /** 全序行数（data-total-row-count）。 */
  totalRowCount: number;
  /** 底部跟随态（data-following："true" | "false"）。 */
  following: string | null;
  /** 实际挂载到 DOM 的 turn unit 数（虚拟化窗口 + overscan）。 */
  mountedRenderUnitCount: number;
  /** 「回到底部」按钮是否出现。 */
  hasBackToBottom: boolean;
}

export interface V4TurnNavigatorState {
  centerOffsetPx: number;
  composerLeftGutterPx: number;
  exists: boolean;
  firstItemLeftOffsetPx: number;
  visible: boolean;
  itemCount: number;
  paneWidthPx: number;
  items: Array<{
    active: boolean;
    height: number;
    left: number;
    testId: string;
    top: number;
    turnId: string | null;
    unitIndex: number | null;
    visualColorTone: string | null;
    visualScale: number | null;
    visualTone: string | null;
  }>;
}

export interface V4PermissionRuleScope {
  kind: "exact" | "prefix";
  text: string;
}

export interface V4PermissionDockState {
  inDock: boolean;
  composerMounted: boolean;
  composerHidden: boolean;
  interactionBeforeComposer: boolean;
  composerAriaHidden: string | null;
  composerDisplay: string | null;
}
