import {
  Collapsible,
  CollapsibleContent,
} from "@/components/ui/collapsible.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type { Theme } from "@/useTheme.js";
import type { ConversationCuaGroupRenderItem } from "@/v4/conversationCuaGroups.js";
import type { ConversationTurnFlowItem } from "@/v4/conversationTurnFlowItems.js";
import type { ConversationTurnWorkSegment } from "@/v4/conversationTurnWorkSegments.js";
import { AssistantTextPresentation } from "@/v4/share-readonly-timeline/AssistantTextPresentation.js";
import { ReadonlyAssistantWorkItems } from "@/v4/share-readonly-timeline/ReadonlyAssistantWorkItems.js";
import { ReadonlyHistoryStatus } from "@/v4/share-readonly-timeline/ReadonlyHistoryStatus.js";
import { GroupedToolPresentation } from "@/v4/share-readonly-timeline/ToolCallPresentation.js";
import type { ReadonlyLabels } from "@/v4/share-readonly-timeline/types.js";
import { UserInputPresentation } from "@/v4/share-readonly-timeline/UserInputPresentation.js";
import type { Locale } from "@zcode/shared";
import { Fragment, useEffect, useState, type ReactNode } from "react";

function ReadonlyCuaGroup({
  item,
  theme,
  codePreviewSettings,
  artifactUrls,
  artifactNames,
  labels,
  onOpenExternalUrl,
}: {
  item: ConversationCuaGroupRenderItem;
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  artifactUrls: ReadonlyMap<string, string>;
  artifactNames: ReadonlyMap<string, string>;
  labels: ReadonlyLabels;
  onOpenExternalUrl: (url: string) => void;
}) {
  return (
    <GroupedToolPresentation
      item={item}
      theme={theme}
      codePreviewSettings={codePreviewSettings}
      artifactUrls={artifactUrls}
      artifactNames={artifactNames}
      labels={labels}
      onOpenExternalUrl={onOpenExternalUrl}
    />
  );
}

export function ReadonlySegment({
  segment,
  locale,
  theme,
  codePreviewSettings,
  artifactUrls,
  artifactNames,
  labels,
  onOpenExternalUrl,
}: {
  segment: ConversationTurnWorkSegment;
  locale: Locale;
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  artifactUrls: ReadonlyMap<string, string>;
  artifactNames: ReadonlyMap<string, string>;
  labels: ReadonlyLabels;
  onOpenExternalUrl: (url: string) => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(
    segment.assistantHistoryDefaultOpen,
  );
  useEffect(() => {
    setHistoryOpen(segment.assistantHistoryDefaultOpen);
  }, [segment.assistantHistoryDefaultOpen, segment.key]);
  const hasHistory = segment.flowItems.some(
    (item) =>
      item.kind === "assistantHistory" ||
      (item.kind === "cuaGroup" && item.flowKind === "assistantHistory"),
  );
  const open = segment.assistantHistoryDefaultOpen || historyOpen;
  const firstAssistantFlowItemIndex = segment.flowItems.findIndex(
    (flowItem) => flowItem.kind !== "userInput",
  );
  return (
    <Collapsible
      open={open}
      onOpenChange={
        segment.assistantHistoryDefaultOpen ? undefined : setHistoryOpen
      }
      className="history-message flex flex-col [&>*+*:not([data-slot='collapsible-content'])]:mt-5"
    >
      {segment.flowItems.map((item: ConversationTurnFlowItem, index) => {
        let content: ReactNode;
        if (item.kind === "userInput") {
          content = (
            <UserInputPresentation row={item.row} artifactUrls={artifactUrls} />
          );
        } else if (item.kind === "assistantText") {
          content = (
            <AssistantTextPresentation
              row={item.row}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              artifactNames={artifactNames}
              onOpenExternalUrl={onOpenExternalUrl}
            />
          );
        } else if (item.kind === "cuaGroup") {
          const group = (
            <ReadonlyCuaGroup
              item={item}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              artifactUrls={artifactUrls}
              artifactNames={artifactNames}
              labels={labels}
              onOpenExternalUrl={onOpenExternalUrl}
            />
          );
          content =
            item.flowKind === "assistantHistory" ? (
              <CollapsibleContent data-history-open={String(open)}>
                <div className="pt-5">{group}</div>
              </CollapsibleContent>
            ) : (
              <div>{group}</div>
            );
        } else if (item.kind === "assistantHistory") {
          content = (
            <CollapsibleContent data-history-open={String(open)}>
              <div className="pt-5">
                <ReadonlyAssistantWorkItems
                  rows={item.rows}
                  stageTailIsRunning={false}
                  theme={theme}
                  codePreviewSettings={codePreviewSettings}
                  artifactUrls={artifactUrls}
                  artifactNames={artifactNames}
                  labels={labels}
                  onOpenExternalUrl={onOpenExternalUrl}
                />
              </div>
            </CollapsibleContent>
          );
        } else {
          content = (
            <ReadonlyAssistantWorkItems
              rows={item.rows}
              stageTailIsRunning={
                segment.workStatus?.state === "running" &&
                index === segment.flowItems.length - 1
              }
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              artifactUrls={artifactUrls}
              artifactNames={artifactNames}
              labels={labels}
              onOpenExternalUrl={onOpenExternalUrl}
            />
          );
        }
        const showHistoryStatus =
          hasHistory && index === firstAssistantFlowItemIndex;
        return (
          <Fragment key={`${segment.key}:${item.kind}:${index}`}>
            {showHistoryStatus ? (
              <ReadonlyHistoryStatus
                segment={segment}
                open={open}
                labels={labels}
                locale={locale}
              />
            ) : null}
            {content}
          </Fragment>
        );
      })}
      {hasHistory && segment.flowItems.length === 0 ? (
        <ReadonlyHistoryStatus
          segment={segment}
          open={open}
          labels={labels}
          locale={locale}
        />
      ) : null}
    </Collapsible>
  );
}
