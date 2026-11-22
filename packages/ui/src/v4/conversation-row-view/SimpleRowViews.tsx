import { memo } from "react";
import { FileIcon } from "lucide-react";
import type {
  ArtifactRow,
  ReasoningRow,
  SubagentRow,
  TurnHeaderRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning.js";
import { RowShell } from "@/v4/conversation-row-view/RowShell.js";

export const ArtifactRowView = memo(function ArtifactRowView({ row }: { row: ArtifactRow }) {
  return (
    <RowShell rowId={row.rowId} className="px-4 py-1">
      <div className="flex items-center gap-2 rounded-lg border border-card-border bg-card px-3 py-2">
        <FileIcon className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui-base text-foreground">{row.displayName}</p>
          <p className="text-ui-sm text-foreground-subtle">
            {row.artifactType.toUpperCase()} · {row.sizeBytes} bytes
          </p>
        </div>
      </div>
    </RowShell>
  );
});

export const ReasoningRowView = memo(function ReasoningRowView({
  row,
  contentVariant,
}: {
  row: ReasoningRow;
  contentVariant?: "default" | "nested";
}) {
  const streaming = row.state === "streaming";
  // 外观对齐旧 ThoughtBlock（旧版 chatMessageParts）：ai-elements Reasoning
  // 折叠组件。交互调整原因：流式 reasoning 默认展开会持续挤压工具和正文空间；
  // 现在 streaming/complete 都默认收起，只保留运行态文案，用户可手动展开。
  // autoCollapseKey 仍保证状态边界不会覆盖已经发生过的用户交互。
  const durationSeconds =
    row.durationMs !== undefined ? Math.max(1, Math.ceil(row.durationMs / 1000)) : undefined;
  // Bug 原因：流式 reasoning 的首个 chunk 可能只是空白（换行/缩进），只判断
  // length === 0 会把它当成有内容，渲染出没有正文的裸「Thinking」触发器。
  // 修复依据：该行没有任何可展示思考内容，与空字符串同等处理；可见性语义
  // 仍由 isConversationReasoningRowVisible 决定，不在此处扩展。
  if (streaming && row.text.trim().length === 0) {
    return null;
  }
  return (
    <RowShell rowId={row.rowId}>
      <Reasoning
        className="w-full"
        isStreaming={streaming}
        autoCollapseKey={streaming ? null : row.state}
        {...(durationSeconds !== undefined ? { duration: durationSeconds } : {})}
      >
        {/* Bug 原因：附件重构合并时误丢了 streamingText 接线，导致摘要组件仍在但永远收到空文本。 */}
        <ReasoningTrigger streamingText={row.text} />
        <div data-conversation-selectable="true">
          <ReasoningContent variant={contentVariant}>{row.text}</ReasoningContent>
        </div>
      </Reasoning>
    </RowShell>
  );
});

export const TurnHeaderRowView = memo(function TurnHeaderRowView({ row }: { row: TurnHeaderRow }) {
  return (
    <RowShell
      rowId={row.rowId}
      className="border-b border-[var(--color-border)] py-1 text-ui-sm text-[var(--color-foreground-subtle)]"
    >
      turn · {row.origin} · {row.state}
    </RowShell>
  );
});

export const SubagentRowView = memo(function SubagentRowView({ row }: { row: SubagentRow }) {
  // subagent 行已经和 Agent/Task 工具行配对渲染；裸行只保留异常兜底摘要，
  // 避免再生成一个“子会话”卡片或第二套下钻入口。
  const summary = (
    <>
      {row.subagentType} · {row.status}
      {row.summaryText ? ` — ${row.summaryText}` : ""}
    </>
  );
  return (
    <RowShell rowId={row.rowId}>
      <div className="text-ui-sm text-[var(--color-foreground-subtle)]">{summary}</div>
    </RowShell>
  );
});
