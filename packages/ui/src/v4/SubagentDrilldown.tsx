// M5④ subagent 输出预览：内嵌 childSessionId 的只读轻量输出区。
// 轻量实现（P9：不内嵌 child rows，靠订阅 conversation/<childSessionId> 自取）：
// - 数据：复用 SessionDataLayer 租约（引用计数天然支持同会话多订阅视图），
//   可见预览挂 lease、折叠/虚拟卸载即释放（keep-warm 由数据层统一处理）；
// - 展示：不虚拟化，只取窗口最近几条 assistant 文本输出；正文到达前仅展示工具名和安全状态；
// - 只读：不下发 onFork/onRetry/onEdit，行内动作面不出现。
import { memo, useEffect, useMemo, useState } from "react";
import { TID_V4_SUBAGENT_DRILLDOWN, testId } from "@zcode/shared/test-ids";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { ConversationRowView } from "@/v4/ConversationRowView.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

/** 输出预览只展示最近 3 条文本输出；完整 transcript 通过子会话侧栏查看。 */
const SUBAGENT_DRILLDOWN_MAX_ROWS = 3;
const SUBAGENT_DRILLDOWN_MAX_TOOL_ROWS = 3;

interface SubagentDrilldownProps {
  childSessionId: string;
  /** 父行渲染上下文（theme/codePreviewSettings 沿用；宿主保证引用稳定）。 */
  context: ConversationRowRenderContext;
}

function isSubagentOutputRow(row: ConversationRow): boolean {
  return row.kind === "assistantText";
}

/**
 * 挂载即订阅、卸载即释放。memo：props 为字符串 + 稳定 context，
 * 父行重渲染不牵动已展开的输出预览。
 */
export const SubagentDrilldown = memo(function SubagentDrilldown({
  childSessionId,
  context,
}: SubagentDrilldownProps) {
  const { intl } = useZCodeIntl();
  const { layer } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);
  useEffect(() => {
    const nextLease = layer.acquire(childSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, childSessionId]);
  const state = useConversationProjection(lease);

  // 嵌套抑制：迷你 timeline 里的 subagent 行不再提供下钻入口。
  const drilldownContext = useMemo<ConversationRowRenderContext>(
    () => ({ ...context, inSubagentDrilldown: true }),
    [context],
  );

  const sourceRows = state.snapshot?.rows.window ?? [];
  const rows = sourceRows.filter(isSubagentOutputRow);
  const toolRows = sourceRows.filter(
    (row): row is Extract<ConversationRow, { kind: "toolCall" }> => row.kind === "toolCall",
  );
  const latestTurnHeader = sourceRows
    .filter(
      (row): row is Extract<ConversationRow, { kind: "turnHeader" }> => row.kind === "turnHeader",
    )
    .at(-1);
  const childTurnRunning = latestTurnHeader?.state === "running";
  const visibleToolRows = toolRows.slice(-SUBAGENT_DRILLDOWN_MAX_TOOL_ROWS);
  const visibleRows =
    rows.length > SUBAGENT_DRILLDOWN_MAX_ROWS ? rows.slice(-SUBAGENT_DRILLDOWN_MAX_ROWS) : rows;
  const hiddenCount = rows.length - visibleRows.length;
  const statusText =
    state.status === "connecting"
      ? intl.formatMessage({ id: "chat.toolCall.agent.output.syncing" })
      : state.status === "error"
        ? intl.formatMessage(
            { id: "chat.toolCall.agent.output.error" },
            { error: state.lastError ?? "" },
          )
        : hiddenCount > 0
          ? intl.formatMessage(
              { id: "chat.toolCall.agent.output.recentRows" },
              {
                visible: String(visibleRows.length),
                total: String(rows.length),
              },
            )
          : null;

  return (
    <section
      data-testid={testId(TID_V4_SUBAGENT_DRILLDOWN, childSessionId)}
      data-child-session-id={childSessionId}
      data-row-count={rows.length}
      data-visible-row-count={visibleRows.length}
      data-source-row-count={sourceRows.length}
      data-tool-row-count={toolRows.length}
      className="space-y-2"
    >
      <div className="flex min-w-0 items-center gap-2">
        <h4 className="shrink-0 text-ui-base font-medium tracking-wide text-foreground-subtlest uppercase">
          {intl.formatMessage({ id: "chat.toolCall.agent.output" })}
        </h4>
        {statusText ? (
          <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">{statusText}</span>
        ) : null}
      </div>
      {visibleRows.length === 0 ? (
        <div className="rounded-md bg-background-alt/40 px-3 py-2 text-ui-sm text-foreground-subtle">
          {visibleToolRows.length > 0 ? (
            <>
              <ul
                className="space-y-1"
                aria-label={intl.formatMessage({ id: "chat.toolCall.agent.output.activity" })}
                aria-live="polite"
              >
                {visibleToolRows.map((row) => (
                  <li
                    key={row.toolCallId}
                    className="flex min-w-0 items-center gap-2"
                    data-tool-status={row.status}
                  >
                    <span
                      aria-hidden="true"
                      className="size-1.5 shrink-0 rounded-full bg-foreground-subtle"
                    />
                    <span className="truncate font-mono">{row.toolName}</span>
                    <span className="shrink-0">
                      {intl.formatMessage({
                        id:
                          row.status === "inputStreaming"
                            ? "chat.toolCall.agent.output.toolPreparing"
                            : row.status === "pendingApproval"
                              ? "chat.toolCall.agent.output.waitingApproval"
                              : row.status === "error"
                                ? "chat.toolCall.agent.output.toolFailed"
                                : row.status === "success"
                                  ? "chat.toolCall.agent.output.toolDone"
                                  : row.status === "cancelled"
                                    ? "chat.toolCall.agent.output.toolCancelled"
                                    : "chat.toolCall.agent.output.toolRunning",
                      })}
                    </span>
                  </li>
                ))}
              </ul>
              {childTurnRunning &&
              !toolRows.some(
                (row) =>
                  row.status === "running" ||
                  row.status === "inputStreaming" ||
                  row.status === "pendingApproval",
              ) ? (
                <p className="mt-1" aria-live="polite">
                  {intl.formatMessage({ id: "chat.toolCall.agent.output.working" })}
                </p>
              ) : null}
            </>
          ) : childTurnRunning ? (
            intl.formatMessage({ id: "chat.toolCall.agent.output.working" })
          ) : null}
        </div>
      ) : (
        <div className="max-h-80 overflow-y-auto rounded-md bg-background-alt/40 py-1">
          {hiddenCount > 0 ? (
            <div className="px-3 py-1 text-center text-ui-sm text-foreground-subtle">
              {intl.formatMessage(
                { id: "chat.toolCall.agent.output.hiddenRows" },
                { count: String(hiddenCount) },
              )}
            </div>
          ) : null}
          {visibleRows.map((row) => (
            <ConversationRowView key={row.rowId} row={row} context={drilldownContext} />
          ))}
        </div>
      )}
    </section>
  );
});
