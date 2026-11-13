import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type { Theme } from "@/useTheme.js";
import { ArtifactPresentation } from "@/v4/share-readonly-timeline/ArtifactPresentation.js";
import { AssistantTextPresentation } from "@/v4/share-readonly-timeline/AssistantTextPresentation.js";
import { ReasoningPresentation } from "@/v4/share-readonly-timeline/ReasoningPresentation.js";
import { ToolCallPresentation } from "@/v4/share-readonly-timeline/ToolCallPresentation.js";
import type { ReadonlyLabels } from "@/v4/share-readonly-timeline/types.js";
import { UserInputPresentation } from "@/v4/share-readonly-timeline/UserInputPresentation.js";
import type {
  ConversationRow,
  TimelineMarkerRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { ReactNode } from "react";

/**
 * 只读时间线里 marker 的文案。
 *
 * 这里刻意不复刻实时时间线的全部状态细分（compact 的 started/failed/interrupted、
 * modelChange 的 from→to、goalVerify 的迭代序号）：发布会拦掉运行中的 marker，
 * 而 from→to 需要 model-provider store 才能解析显示名，只读历史里价值很低。
 * 识别不了的类型返回 null，由调用方整行不渲染 —— 绝不回退成打印枚举名。
 */
function resolveReadonlyMarkerLabel(
  marker: TimelineMarkerRow["marker"],
  labels: ReadonlyLabels,
): string | null {
  switch (marker.type) {
    case "compact":
      return marker.status === "success" ? labels.markerCompact : null;
    case "modelChange":
      return labels.markerModelChange;
    default:
      return null;
  }
}

export function renderReadonlyRow(
  row: ConversationRow,
  theme: Theme,
  codePreviewSettings: CodePreviewSettings,
  artifactUrls: ReadonlyMap<string, string>,
  artifactNames: ReadonlyMap<string, string>,
  labels: ReadonlyLabels,
  onOpenExternalUrl: (url: string) => void,
): ReactNode {
  switch (row.kind) {
    case "userInput":
      return (
        <UserInputPresentation
          key={row.rowId}
          row={row}
          artifactUrls={artifactUrls}
        />
      );
    case "assistantText":
      return (
        <AssistantTextPresentation
          key={row.rowId}
          row={row}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          artifactNames={artifactNames}
          onOpenExternalUrl={onOpenExternalUrl}
        />
      );
    case "reasoning":
      return <ReasoningPresentation key={row.rowId} row={row} />;
    case "toolCall":
      return (
        <ToolCallPresentation
          key={row.rowId}
          row={row}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          artifactNames={artifactNames}
          onOpenExternalUrl={onOpenExternalUrl}
        />
      );
    case "artifact":
      return (
        <ArtifactPresentation
          key={row.rowId}
          row={row}
          url={artifactUrls.get(row.artifactVersionId)}
          previewLabel={labels.artifactPreview}
        />
      );
    case "externalAgentRun":
      return (
        <section
          key={row.rowId}
          className="my-2 rounded-xl border border-border px-4 py-3"
          data-conversation-share-row-kind="externalAgentRun"
        >
          <strong>OpenCode CLI{row.modelId ? ` · ${row.modelId}` : ""}</strong>
          <span className="ml-2 text-foreground-subtle">{row.status}</span>
          <p className="mt-2 whitespace-pre-wrap break-words">
            {row.promptText}
          </p>
          {row.tools.map((tool) => (
            <p
              key={tool.toolCallId}
              className="mt-1 text-sm text-foreground-subtle"
            >
              {tool.title} · {tool.status}
            </p>
          ))}
          {row.output.text ? (
            <div className="mt-3 whitespace-pre-wrap break-words">
              {row.output.text}
            </div>
          ) : null}
        </section>
      );
    case "timelineMarker": {
      // 这里原本直接把 row.marker.type 当文案渲染，于是分享页会出现一条写着
      // 字面量 compact / modelChange / goalVerify 的分割线（发布只剥掉 fork/checkpoint 类）。
      // 改为取本地化文案；识别不了的类型不渲染，不再泄漏枚举名。
      const markerLabel = resolveReadonlyMarkerLabel(row.marker, labels);
      if (!markerLabel) return null;
      return (
        <div
          key={row.rowId}
          data-conversation-share-row-kind="timelineMarker"
          data-marker-type={row.marker.type}
          className="flex w-full items-center gap-3 px-4 py-2 text-ui-base text-foreground-subtle"
        >
          <div
            aria-hidden="true"
            className="h-px min-w-8 flex-1 bg-border/50"
          />
          <span className="min-w-0 break-words text-center leading-5">
            {markerLabel}
          </span>
          <div
            aria-hidden="true"
            className="h-px min-w-8 flex-1 bg-border/50"
          />
        </div>
      );
    }
    case "subagent":
    case "hookInvocation":
    case "turnHeader":
      return null;
  }
}
