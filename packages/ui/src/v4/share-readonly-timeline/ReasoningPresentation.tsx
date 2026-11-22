import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning.js";
import type { ReasoningRow } from "@zcode/shared/zcode-protocol-v4";
import { memo } from "react";

export const ReasoningPresentation = memo(function ReasoningPresentation({
  row,
}: {
  row: ReasoningRow;
}) {
  const durationSeconds =
    row.durationMs === undefined
      ? undefined
      : Math.max(1, Math.ceil(row.durationMs / 1000));
  return (
    <div data-conversation-share-row-kind="reasoning">
      <Reasoning
        className="w-full"
        isStreaming={false}
        autoCollapseKey={row.state}
        {...(durationSeconds === undefined
          ? {}
          : { duration: durationSeconds })}
      >
        <ReasoningTrigger streamingText={row.text} />
        <div data-conversation-selectable="true">
          <ReasoningContent>{row.text}</ReasoningContent>
        </div>
      </Reasoning>
    </div>
  );
});
