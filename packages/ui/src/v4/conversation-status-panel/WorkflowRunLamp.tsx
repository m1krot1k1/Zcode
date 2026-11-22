import { cn } from "@/components/lib/utils.js";
import { RUN_STATUS_DOT } from "@/components/workflow-graph/run-status-presentation.js";

/** 单盏状态灯（pending 空心、running 脉冲），与卡片、侧栏同一套 `STATUS_DOT`。 */
export function WorkflowRunLamp({ status }: { status: "pending" | "running" }) {
  return (
    <span
      aria-hidden="true"
      data-workflow-run-lamp={status}
      className={cn("size-1.5 shrink-0 rounded-full", RUN_STATUS_DOT[status])}
    />
  );
}
