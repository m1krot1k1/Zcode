import { memo, useMemo } from "react";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { WorkflowToolSummary } from "@/v4/WorkflowToolSummary.js";
import {
  readWorkflowName,
  readWorkflowRetuneCall,
} from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import { WorkflowRetuneRow } from "@/ToolCallBlocks/renderers/WorkflowRetuneRow.js";
import { workflowRunDefaultConcurrency } from "@/components/workflow-timeline/workflowRunSettings.js";
import { isAmendWorkflowToolCall, isFillWorkflowHoleToolCall } from "@/lib/workflowToolNames.js";
import {
  readWorkflowHoleTarget,
  workflowFillCounts,
} from "@/ToolCallBlocks/renderers/createWorkflowHoleInput.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { resolveWorkflowRunOpenToolCallId } from "@/v4/workflowRunCardJoin.js";
import { type ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import { RowShell } from "@/v4/conversation-row-view/RowShell.js";

export const ToolCallRowView = memo(function ToolCallRowView({
  row,
  context,
}: {
  row: ToolCallRow;
  context: ConversationRowRenderContext;
}) {
  // toolCall 行回接 ToolCallBlocks（execute/read/edit/... renderer 按
  // tool identity 分流）。适配 memo 按 row 引用：row.delta/upserted 换新对象才重建。
  const toolCallNode = useMemo(() => toolCallRowToLegacyNode(row), [row]);
  // workflow run 详情入口的门控：run 身份走 workflowRuns 投影（schema 里 toolCallId 就是
  // 「工具卡 → 详情页的关联键」），不从工具输出里读——v4 行的 output 只剩一句散文。
  // 命中的摘要同时决定卡片形态：有 run 就是紧凑可点卡，没有就是可展开卡。
  const workflowRun =
    context.workflowRunByToolCallId?.get(row.toolCallId) ??
    // ResumeWorkflowRun 行按 runId 联接：display 载荷带 runId（≡ backgroundTaskId），而投影
    // 的 run.toolCallId 跨 resume 沿用原始 CreateWorkflow 行——resume 行按 toolCallId 永远
    // 查不到。命中后 onOpenWorkflowRun 的收窄走同一条路径，tab 身份 runId 键、幂等。
    (row.display?.kind === "resume_workflow_run"
      ? context.workflowRunByRunId?.get(row.display.runId)
      : undefined);
  // 已接进 run 的补全行（docs/dynamic-workflow/presentation.md「The fill row」）：「留白已补全 · {name} ·
  // {k} 个阶段 · {m} 个子代理 ↗」。按入参的 `run_id` 联接投影（补全行的 toolCallId 不是发起行的），只认成功
  // 且编过的行——编不过的补全走下面的编译反馈行，什么都没接进 run。卡下方随之长出新的站（轮尾摘要
  // 取的是这一行的图）。
  // 名字来自 display 的 `fill` 块（行的入参没有名字——transcript 只存模型自己的入参）。
  const fillTarget = isFillWorkflowHoleToolCall(row)
    ? readWorkflowHoleTarget(
        row.input,
        row.display?.kind === "create_workflow" ? row.display.fill : undefined,
      )
    : undefined;
  const fillRun =
    fillTarget?.runId === undefined ? undefined : context.workflowRunByRunId?.get(fillTarget.runId);
  if (
    fillTarget !== undefined &&
    fillTarget.holeId !== undefined &&
    fillRun !== undefined &&
    row.status === "success" &&
    row.display?.kind === "create_workflow" &&
    row.display.ok
  ) {
    const sessionId = context.sessionId;
    const counts = workflowFillCounts(row.display.causalityGraph, fillTarget.holeId);
    return (
      <RowShell rowId={row.rowId} className="py-0">
        <WorkflowToolSummary
          toolCallId={row.toolCallId}
          summary={fillRun}
          fill={{
            name: fillTarget.name ?? fillTarget.holeId,
            ...counts,
          }}
          onOpen={
            context.onOpenWorkflowRun && sessionId
              ? () =>
                  context.onOpenWorkflowRun?.({
                    parentSessionId: sessionId,
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, fillRun),
                    runId: fillRun.runId,
                  })
              : undefined
          }
        />
      </RowShell>
    );
  }
  // 原因：已启动的工具卡与轮尾摘要重复画同一条实时进度；上方改为普通摘要入口。
  // 只替换成功关联的发起行，编译诊断及 Resume 等其他工具仍走原有渲染。
  if (
    workflowRun &&
    context.workflowRunByToolCallId?.has(row.toolCallId) &&
    row.status !== "error"
  ) {
    const workflowName = readWorkflowName(row.input);
    const sessionId = context.sessionId;
    return (
      <RowShell rowId={row.rowId} className="py-0">
        <WorkflowToolSummary
          toolCallId={row.toolCallId}
          summary={workflowRun}
          amend={isAmendWorkflowToolCall(row)}
          onOpen={
            context.onOpenWorkflowRun && sessionId
              ? () =>
                  context.onOpenWorkflowRun?.({
                    parentSessionId: sessionId,
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, workflowRun),
                    runId: workflowRun.runId,
                    ...(workflowName === undefined ? {} : { workflowName }),
                  })
              : undefined
          }
        />
      </RowShell>
    );
  }
  // 就地生效的修订（docs/dynamic-workflow/concurrency.md）：只改并发上限、run 又在飞时这次调用
  // 不编译、不铸新 run，结果只有一句话。判据全在已经上线的字段上——入参的形状、**没有** display、
  // 成功且非错误；工具的结构化输出不过 v4，而三处 create_workflow display schema 都是冻结字段集
  // 的 `.strict()`，多一个键会让旧端把整条工具结果丢掉，所以这条路不新增任何协议字段。
  // 退回真修订的那一条（run 已结算）两条判据都不成立：它有 display，也铸出一条按 toolCallId
  // 联接得上的 run，上面那个分支先接走它。
  const retune = isAmendWorkflowToolCall(row) ? readWorkflowRetuneCall(row.input) : undefined;
  if (
    retune !== undefined &&
    row.status === "success" &&
    (row.output?.display ?? row.display) === undefined &&
    !context.workflowRunByToolCallId?.has(row.toolCallId)
  ) {
    const sessionId = context.sessionId;
    // 被调整那条 run 的投影：只为两件事——默认并发（措辞据它把「等于默认」念成「恢复为默认」）与
    // 打开请求里那条 run 的发起行 id。它不进上面的 `workflowRun`：那个变量回答的是「这一行是不是
    // 某条 run 的发起行」，而这一行不是。
    const retuned = context.workflowRunByRunId?.get(retune.runId);
    const defaultConcurrency =
      retuned?.run === undefined ? undefined : workflowRunDefaultConcurrency(retuned.run);
    return (
      <RowShell rowId={row.rowId} className="py-0">
        <WorkflowRetuneRow
          requested={retune.requested}
          runId={retune.runId}
          {...(defaultConcurrency === undefined ? {} : { defaultConcurrency })}
          {...(context.onOpenWorkflowRun && sessionId
            ? {
                onOpen: () =>
                  context.onOpenWorkflowRun?.({
                    parentSessionId: sessionId,
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, retuned),
                    runId: retune.runId,
                  }),
              }
            : {})}
        />
      </RowShell>
    );
  }
  // 工具行去掉纵向内边距（对齐 z-code-2 无 per-tool padding）；连续工具间距由
  // ConversationAssistantWorkItems 的 gap-4 组容器统一给。
  return (
    <RowShell rowId={row.rowId} className="py-0">
      <div data-conversation-selectable="true">
        <ToolCallBlock
          toolCallNode={toolCallNode}
          workspacePath={context.workspacePath}
          theme={context.theme}
          codePreviewSettings={context.codePreviewSettings}
          showTodoToolCalls={context.messageStreamShowTodos === true}
          onOpenCodeViewer={context.onOpenCodeViewer}
          onOpenFileLink={context.onOpenFileLink}
          onOpenBrowserUrl={context.onOpenBrowserUrl}
          onOpenAutomationsMain={context.onOpenAutomationsMain}
          onOpenPlanDetail={
            context.onOpenPlanDetail && context.sessionId
              ? (request) =>
                  context.onOpenPlanDetail?.({
                    ...request,
                    parentSessionId: context.sessionId!,
                  })
              : undefined
          }
          onOpenWorkflowRun={
            context.onOpenWorkflowRun && context.sessionId && workflowRun
              ? (request) =>
                  context.onOpenWorkflowRun?.({
                    ...request,
                    parentSessionId: context.sessionId!,
                    // 打开请求的关联键是发起行（CreateWorkflow）id，不是点中行的 id——
                    // resume 行点开时两者不同，详情页拿它找 causalityGraph/脚本。
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, workflowRun),
                    runId: workflowRun.runId,
                  })
              : undefined
          }
          onOpenWorkflowActor={
            context.onOpenWorkflowActor && context.sessionId && workflowRun
              ? (request) =>
                  context.onOpenWorkflowActor?.({ ...request, parentSessionId: context.sessionId! })
              : undefined
          }
          // 脚本药丸 → 脚本 transcript：关联键同 onOpenWorkflowRun（发起行 id + runId）。
          onOpenWorkflowWorkspace={
            context.onOpenWorkflowWorkspace && context.sessionId && workflowRun
              ? (request) =>
                  context.onOpenWorkflowWorkspace?.({
                    ...request,
                    parentSessionId: context.sessionId!,
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, workflowRun),
                    runId: workflowRun.runId,
                  })
              : undefined
          }
          onResumeWorkflowRun={
            context.onResumeWorkflowRun && workflowRun?.resumable
              ? (request) => context.onResumeWorkflowRun?.(workflowRun.runId, request.workflowName)
              : undefined
          }
          // 产物药丸 → 产物 tab：与通知行的 chips 同一条打开路径（不带版本号，打开即最新版）。
          onOpenWorkflowArtifact={
            context.onOpenWorkflowArtifact && context.sessionId && workflowRun
              ? (artifactId) => {
                  // 活投影的产物摘要带最新版的 `contentType`（宿主据它把 html 产物直接开成
                  // 浏览器 tab）；`sourcePath` 那份摘要刻意不带，缺席时宿主自己查 journal。
                  const artifact = workflowRun.run?.artifacts?.find(
                    (candidate) => candidate.id === artifactId,
                  );
                  context.onOpenWorkflowArtifact?.({
                    parentSessionId: context.sessionId!,
                    runId: workflowRun.runId,
                    artifactId,
                    ...(artifact?.title === undefined ? {} : { title: artifact.title }),
                    ...(artifact?.contentType === undefined
                      ? {}
                      : { contentType: artifact.contentType }),
                  });
                }
              : undefined
          }
          workflowRun={workflowRun}
          workflowDraft={context.workflowDraftByToolCallId?.get(row.toolCallId)}
        />
      </div>
    </RowShell>
  );
});
