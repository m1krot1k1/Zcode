import { buildAssistantWorkRenderItems } from "@/v4/conversationAssistantWorkItems.js";
import type { AssistantWorkRow } from "@/v4/conversationTurnFlowItems.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type { Theme } from "@/useTheme.js";
import {
  GroupedToolPresentation,
  ToolCallPresentation,
} from "@/v4/share-readonly-timeline/ToolCallPresentation.js";
import { renderReadonlyRow } from "@/v4/share-readonly-timeline/ReadonlyRow.js";
import type { ReadonlyLabels } from "@/v4/share-readonly-timeline/types.js";
import { useMemo } from "react";

export function ReadonlyAssistantWorkItems({
  rows,
  stageTailIsRunning,
  theme,
  codePreviewSettings,
  artifactUrls,
  artifactNames,
  labels,
  onOpenExternalUrl,
}: {
  rows: readonly AssistantWorkRow[];
  stageTailIsRunning: boolean;
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  artifactUrls: ReadonlyMap<string, string>;
  artifactNames: ReadonlyMap<string, string>;
  labels: ReadonlyLabels;
  onOpenExternalUrl: (url: string) => void;
}) {
  const items = useMemo(
    () =>
      buildAssistantWorkRenderItems(
        rows,
        { messageStreamShowReasoning: true },
        {
          stageTailIsRunning,
          enableCuaGrouping: true,
          enableExploreGrouping: true,
          enableTerminalGrouping: true,
          enableChangesGrouping: false,
        },
      ),
    [rows, stageTailIsRunning],
  );
  return (
    <div className="flex flex-col gap-4" data-conversation-share-work-items>
      {items.map((item) => {
        if (item.kind === "row") {
          return renderReadonlyRow(
            item.row,
            theme,
            codePreviewSettings,
            artifactUrls,
            artifactNames,
            labels,
            onOpenExternalUrl,
          );
        }
        if (item.kind === "agentToolCall") {
          return (
            <ToolCallPresentation
              key={item.key}
              row={item.row}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              artifactNames={artifactNames}
              onOpenExternalUrl={onOpenExternalUrl}
            />
          );
        }
        return (
          <GroupedToolPresentation
            key={item.key}
            item={item}
            theme={theme}
            codePreviewSettings={codePreviewSettings}
            artifactUrls={artifactUrls}
            artifactNames={artifactNames}
            labels={labels}
            onOpenExternalUrl={onOpenExternalUrl}
          />
        );
      })}
    </div>
  );
}
