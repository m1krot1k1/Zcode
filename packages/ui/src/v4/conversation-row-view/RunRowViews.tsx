import { SubagentDrilldown } from "@/v4/SubagentDrilldown.js";
import { memo, useEffect, useState } from "react";
import { TID_V4_SUBAGENT_OPEN_SIDE_PANE, testId } from "@zcode/shared/test-ids";
import type { ExternalAgentRunRow, SwarmRunRow } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { type ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { RowShell } from "@/v4/conversation-row-view/RowShell.js";

const SWARM_STATUS_MESSAGE_IDS: Record<SwarmRunRow["status"], string> = {
  planning: "conversation.swarm.status.planning",
  running: "conversation.swarm.status.running",
  completed: "conversation.swarm.status.completed",
  failed: "conversation.swarm.status.failed",
  cancelled: "conversation.swarm.status.cancelled",
};

export const SwarmRunRowView = memo(function SwarmRunRowView({
  row,
  context,
}: {
  row: SwarmRunRow;
  context: ConversationRowRenderContext;
}) {
  const { intl } = useZCodeIntl();
  const parentSessionId = context.sessionId;
  const openChildSession = context.onOpenSubagentSession;
  const [collapsedChildSessionIds, setCollapsedChildSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  return (
    <RowShell rowId={row.rowId}>
      <section
        className="my-2 rounded-xl border border-border bg-muted/20 px-4 py-3"
        data-row-kind="swarmRun"
        data-swarm-run-id={row.swarmRunId}
        data-status={row.status}
        data-testid={`swarm-run-${row.swarmRunId}`}
        aria-label={intl.formatMessage({ id: "conversation.swarm.title" })}
      >
        <header className="flex items-center justify-between gap-3 text-sm">
          <strong>{intl.formatMessage({ id: "conversation.swarm.title" })}</strong>
          <span
            className="text-muted-foreground"
            data-testid={`swarm-run-status-${row.swarmRunId}`}
          >
            {intl.formatMessage({ id: SWARM_STATUS_MESSAGE_IDS[row.status] })}
          </span>
        </header>
        {row.taskCount !== undefined ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {intl.formatMessage({ id: "conversation.swarm.taskCount" }, { count: row.taskCount })}
          </p>
        ) : null}
        {row.status === "completed" || row.status === "failed" || row.status === "cancelled" ? (
          <p
            className="mt-1 text-xs text-muted-foreground"
            data-testid={`swarm-run-acceptance-${row.swarmRunId}`}
          >
            {intl.formatMessage({
              id: `conversation.swarm.acceptance.${row.outcomeAcceptance ?? "unknown"}`,
            })}
          </p>
        ) : null}
        {row.childSessionIds?.length ? (
          <ul
            className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-ui-xs text-foreground-subtle"
            aria-label={intl.formatMessage({ id: "conversation.swarm.children" })}
          >
            {row.childSessionIds.map((childSessionId, index) => {
              const outputCollapsed = collapsedChildSessionIds.has(childSessionId);
              const outputId = `swarm-child-output-${childSessionId}`;
              return (
                <li key={childSessionId}>
                  {parentSessionId && openChildSession ? (
                    <button
                      type="button"
                      className="cursor-pointer text-primary underline-offset-4 hover:underline"
                      aria-label={intl.formatMessage(
                        { id: "conversation.swarm.openChild" },
                        { index: index + 1, sessionId: childSessionId },
                      )}
                      data-testid={testId(TID_V4_SUBAGENT_OPEN_SIDE_PANE, childSessionId)}
                      onClick={() =>
                        openChildSession({
                          rootSessionId: context.rootSessionId ?? parentSessionId,
                          parentSessionId,
                          childSessionId,
                          subagentType: "swarm-task",
                          title: intl.formatMessage(
                            { id: "conversation.swarm.childTitle" },
                            { index: index + 1 },
                          ),
                        })
                      }
                    >
                      {childSessionId}
                    </button>
                  ) : (
                    <span>{childSessionId}</span>
                  )}
                  {row.childAgentTypes?.[childSessionId] ? (
                    <span
                      className="ml-2 text-ui-xs text-foreground-subtlest"
                      data-testid={`swarm-child-role-${childSessionId}`}
                    >
                      {intl.formatMessage(
                        { id: "conversation.swarm.childRole" },
                        { role: row.childAgentTypes[childSessionId] },
                      )}
                    </span>
                  ) : null}
                  <div className="mt-1">
                    <button
                      type="button"
                      className="cursor-pointer text-ui-xs text-foreground-subtle hover:text-foreground"
                      aria-expanded={!outputCollapsed}
                      aria-controls={outputId}
                      data-testid={`swarm-child-output-toggle-${childSessionId}`}
                      onClick={() =>
                        setCollapsedChildSessionIds((current) => {
                          const next = new Set(current);
                          if (next.has(childSessionId)) next.delete(childSessionId);
                          else next.add(childSessionId);
                          return next;
                        })
                      }
                    >
                      {intl.formatMessage({ id: "chat.toolCall.agent.output" })}
                    </button>
                    {!outputCollapsed ? (
                      <div id={outputId} className="mt-2 rounded-lg border border-border p-2">
                        <SubagentDrilldown childSessionId={childSessionId} context={context} />
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
        {row.summary ? (
          <p className="mt-2 whitespace-pre-wrap break-words text-sm">{row.summary}</p>
        ) : null}
      </section>
    </RowShell>
  );
});

export function ExternalAgentRunRowView({
  row,
  context,
}: {
  row: ExternalAgentRunRow;
  context: ConversationRowRenderContext;
}) {
  const { intl } = useZCodeIntl();
  const [respondingRequestIds, setRespondingRequestIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  useEffect(() => {
    const activeIds = new Set((row.pendingPermissions ?? []).map((request) => request.requestId));
    setRespondingRequestIds((current) => {
      const next = new Set([...current].filter((requestId) => activeIds.has(requestId)));
      return next.size === current.size ? current : next;
    });
  }, [row.pendingPermissions]);

  return (
    <section
      className="my-2 rounded-xl border border-border bg-muted/20 px-4 py-3"
      data-external-agent-run-id={row.runId}
    >
      <header className="flex items-center justify-between gap-3 text-sm">
        <strong>OpenCode CLI{row.modelId ? ` · ${row.modelId}` : ""}</strong>
        <span className="text-muted-foreground">{row.status}</span>
      </header>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm">{row.promptText}</p>
      {(row.pendingPermissions ?? []).map((request) => (
        <section
          key={request.requestId}
          className="mt-3 space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3"
          data-testid={`opencode-permission-${request.requestId}`}
        >
          <h3 className="text-sm font-semibold">
            {intl.formatMessage({ id: "conversation.openCode.permission.title" })}
          </h3>
          <p className="text-sm text-muted-foreground">{request.title}</p>
          {request.inputSummary ? (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">
              {request.inputSummary}
            </pre>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {request.options.map((option) => (
              <Button
                key={option.optionId}
                type="button"
                size="sm"
                variant="outline"
                disabled={
                  !context.onRespondOpenCodePermission ||
                  respondingRequestIds.has(request.requestId)
                }
                data-testid={`opencode-permission-option-${request.requestId}-${option.optionId}`}
                onClick={() => {
                  const respond = context.onRespondOpenCodePermission;
                  if (!respond || respondingRequestIds.has(request.requestId)) return;
                  setRespondingRequestIds((current) => new Set(current).add(request.requestId));
                  void respond({
                    commandId: row.commandId,
                    runId: row.runId,
                    opencodeSessionId: request.opencodeSessionId,
                    requestId: request.requestId,
                    optionId: option.optionId,
                  }).catch(() => {
                    setRespondingRequestIds((current) => {
                      const next = new Set(current);
                      next.delete(request.requestId);
                      return next;
                    });
                  });
                }}
              >
                {option.name || option.kind}
              </Button>
            ))}
          </div>
        </section>
      ))}
      {row.tools.length > 0 ? (
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          {row.tools.map((tool) => (
            <li key={tool.toolCallId}>
              {tool.title} · {tool.status}
            </li>
          ))}
        </ul>
      ) : null}
      {row.output.text ? (
        <div className="mt-3 whitespace-pre-wrap break-words text-sm">{row.output.text}</div>
      ) : null}
      {row.diagnosticCode ? (
        <p className="mt-2 text-xs text-destructive">{row.diagnosticCode}</p>
      ) : null}
    </section>
  );
}
