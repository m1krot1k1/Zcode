import { useToolPresentationCapabilities } from "@/ToolCallBlocks/presentationCapabilities.js";
import { ToolPresentation } from "@/ToolCallBlocks/ToolPresentation.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type { Theme } from "@/useTheme.js";
import type { ConversationAssistantWorkRenderItem } from "@/v4/conversationAssistantWorkItems.js";
import {
  ConversationShareWorkflow,
  hasConversationShareWorkflowDisplay,
} from "@/v4/ConversationShareWorkflow.js";
import { AssistantTextPresentation } from "@/v4/share-readonly-timeline/AssistantTextPresentation.js";
import { ReasoningPresentation } from "@/v4/share-readonly-timeline/ReasoningPresentation.js";
import type { ReadonlyLabels } from "@/v4/share-readonly-timeline/types.js";
import {
  ToolSnapshotContext,
  toolNodeWithSnapshot,
} from "@/v4/share-readonly-timeline/toolSnapshot.js";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { memo, useContext, useMemo } from "react";

// 说明：GroupedToolItem 与 buildAssistantWorkRenderItems 的输出必须保持同一家族，
// 这里从 ConversationAssistantWorkRenderItem 收窄，避免两处类型漂移。
type GroupedToolItem = Extract<
  ConversationAssistantWorkRenderItem,
  { kind: "cuaGroup" | "exploreGroup" | "executeGroup" | "changesGroup" }
>;

export const ToolCallPresentation = memo(function ToolCallPresentation({
  row,
  theme,
  codePreviewSettings,
  artifactNames: _artifactNames,
  onOpenExternalUrl,
}: {
  row: ToolCallRow;
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  artifactNames: ReadonlyMap<string, string>;
  onOpenExternalUrl: (url: string) => void;
}) {
  const snapshots = useContext(ToolSnapshotContext);
  const { resourceUrl } = useToolPresentationCapabilities();
  const snapshot = snapshots.get(row.rowId);
  const node = useMemo(
    () => toolNodeWithSnapshot(row, snapshot, resourceUrl ?? (() => undefined)),
    [row, snapshot, resourceUrl],
  );
  if (hasConversationShareWorkflowDisplay(row))
    return (
      <div
        data-conversation-share-row-kind="toolCall"
        data-conversation-selectable="true"
      >
        <ConversationShareWorkflow row={row} theme={theme} />
      </div>
    );
  return (
    <div
      data-conversation-share-row-kind="toolCall"
      data-conversation-selectable="true"
    >
      <ToolPresentation
        toolCallNode={node}
        theme={theme}
        codePreviewSettings={codePreviewSettings}
        onOpenBrowserUrl={onOpenExternalUrl}
        authoritativeAgentType={snapshot?.agent_type}
        showTodoToolCalls={false}
      />
    </div>
  );
});

export function GroupedToolPresentation({
  item,
  theme,
  codePreviewSettings,
  artifactUrls: _artifactUrls,
  artifactNames,
  labels: _labels,
  onOpenExternalUrl,
}: {
  item: GroupedToolItem;
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  artifactUrls: ReadonlyMap<string, string>;
  artifactNames: ReadonlyMap<string, string>;
  labels: ReadonlyLabels;
  onOpenExternalUrl: (url: string) => void;
}) {
  const snapshots = useContext(ToolSnapshotContext);
  const { resourceUrl } = useToolPresentationCapabilities();
  const node = {
    ...item.node,
    childToolCalls: item.rows.map((row) =>
      toolNodeWithSnapshot(
        row,
        snapshots.get(row.rowId),
        resourceUrl ?? (() => undefined),
      ),
    ),
  };
  return (
    <div
      data-conversation-share-work-group={item.kind}
      data-conversation-selectable="true"
    >
      <ToolPresentation
        toolCallNode={node}
        theme={theme}
        codePreviewSettings={codePreviewSettings}
        onOpenBrowserUrl={onOpenExternalUrl}
        cuaGroupEvents={
          item.kind === "cuaGroup"
            ? item.events.map((event) =>
                event.kind === "tool"
                  ? {
                      ...event,
                      node: toolNodeWithSnapshot(
                        event.row,
                        snapshots.get(event.row.rowId),
                        resourceUrl ?? (() => undefined),
                      ),
                    }
                  : event,
              )
            : undefined
        }
        renderCuaAssistantMessage={(event) => (
          <AssistantTextPresentation
            row={event.row}
            theme={theme}
            codePreviewSettings={codePreviewSettings}
            artifactNames={artifactNames}
            onOpenExternalUrl={onOpenExternalUrl}
          />
        )}
        renderCuaReasoning={(event) => (
          <ReasoningPresentation row={event.row} />
        )}
      />
    </div>
  );
}
