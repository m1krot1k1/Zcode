import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type { Theme } from "@/useTheme.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";
import type { ConversationTurnWorkSegment } from "@/v4/conversationTurnWorkSegments.js";
import { ReadonlyAssistantWorkItems } from "@/v4/share-readonly-timeline/ReadonlyAssistantWorkItems.js";
import { renderReadonlyRow } from "@/v4/share-readonly-timeline/ReadonlyRow.js";
import { ReadonlySegment } from "@/v4/share-readonly-timeline/ReadonlySegment.js";
import type { ReadonlyLabels } from "@/v4/share-readonly-timeline/types.js";
import type { Locale } from "@zcode/shared";

function fallbackWorkSegment(
  unit: ConversationTurnRenderUnit,
): ConversationTurnWorkSegment {
  return {
    key: unit.key,
    flowItems: unit.flowItems,
    assistantWorkRows: unit.assistantWorkRows,
    assistantHistoryRows: unit.assistantHistoryRows,
    assistantFollowingRows: unit.assistantFollowingRows,
    assistantHistoryDefaultOpen: unit.assistantHistoryDefaultOpen,
    ...(unit.workStatus ? { workStatus: unit.workStatus } : {}),
  };
}

export function ReadonlyTurn({
  unit,
  locale,
  theme,
  codePreviewSettings,
  artifactUrls,
  artifactNames,
  labels,
  onOpenExternalUrl,
}: {
  unit: ConversationTurnRenderUnit;
  locale: Locale;
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  artifactUrls: ReadonlyMap<string, string>;
  artifactNames: ReadonlyMap<string, string>;
  labels: ReadonlyLabels;
  onOpenExternalUrl: (url: string) => void;
}) {
  const segments = unit.workSegments?.length
    ? unit.workSegments
    : [fallbackWorkSegment(unit)];
  return (
    <section
      data-conversation-share-turn={unit.turnId}
      className="mx-auto flex w-full flex-col gap-5 px-4 pb-5 pt-14 @md/conversation:px-6 [content-visibility:auto] [contain-intrinsic-size:0_420px]"
    >
      {unit.leadingBoundaryRows.map((row) =>
        renderReadonlyRow(
          row,
          theme,
          codePreviewSettings,
          artifactUrls,
          artifactNames,
          labels,
          onOpenExternalUrl,
        ),
      )}
      <div className="group/assistant-turn flex w-full flex-col gap-5">
        {segments.map((segment) => (
          <ReadonlySegment
            key={segment.key}
            segment={segment}
            locale={locale}
            theme={theme}
            codePreviewSettings={codePreviewSettings}
            artifactUrls={artifactUrls}
            artifactNames={artifactNames}
            labels={labels}
            onOpenExternalUrl={onOpenExternalUrl}
          />
        ))}
        {unit.browserTurnEndRows.length > 0 ? (
          <ReadonlyAssistantWorkItems
            rows={unit.browserTurnEndRows}
            stageTailIsRunning={false}
            theme={theme}
            codePreviewSettings={codePreviewSettings}
            artifactUrls={artifactUrls}
            artifactNames={artifactNames}
            labels={labels}
            onOpenExternalUrl={onOpenExternalUrl}
          />
        ) : null}
        {unit.assistantTailRows.length > 0 ? (
          <ReadonlyAssistantWorkItems
            rows={unit.assistantTailRows}
            stageTailIsRunning={false}
            theme={theme}
            codePreviewSettings={codePreviewSettings}
            artifactUrls={artifactUrls}
            artifactNames={artifactNames}
            labels={labels}
            onOpenExternalUrl={onOpenExternalUrl}
          />
        ) : null}
      </div>
    </section>
  );
}
