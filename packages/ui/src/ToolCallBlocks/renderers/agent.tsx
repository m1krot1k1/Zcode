import { useToolPresentationCapabilities } from "@/ToolCallBlocks/presentationCapabilities.js";
import { BotIcon, WaypointsIcon } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { AgentColor, Locale } from "@zcode/shared";
import { formatBackgroundTaskElapsedLabel } from "@/BackgroundTaskElapsedLabel.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { cn } from "@/components/lib/utils.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveSubagentColorFromName, SUBAGENT_TEXT_COLOR_CLASS } from "@/lib/subagentColors.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { getLatestExploreChildSummaryFromChildren } from "./explore.js";
import { AgentPromptSection } from "./agentPromptSection.js";
import {
  formatAgentMessage,
  getAgentColor,
  getAgentGraphType,
  getAgentKindLabel,
  getAgentActivityContent,
  getAgentPrimaryText,
  getAgentPrompt,
  readBackgroundAgentInfo,
} from "./agentHelpers.js";

const AGENT_TOOL_ICON = <BotIcon className="size-4 shrink-0 text-foreground-subtle" />;

function formatCompactUnitAmount(amount: number, locale: Locale): string {
  // 单位换算后固定一位小数。关闭分组，避免 999 999 999 在 M 档渲染成
  // “1 000,0”（NBSP）或 “1,000.0”；spec 要求 1000,0M 不带分组分隔符。
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    useGrouping: false,
  }).format(amount);
}

function formatCompactTokenCount(value: number, locale: Locale): string {
  if (value < 1_000) return String(value);
  // 阈值按原始值判断，先选单位再四舍五入：999 999 999 仍是 M 档的 1000,0M，
  // 而 1 000 000 000 已进入 B 档。T 是最高单位，1e15 渲染为 1000,0T。
  if (value >= 1_000_000_000_000) {
    return `${formatCompactUnitAmount(value / 1_000_000_000_000, locale)}T`;
  }
  if (value >= 1_000_000_000) {
    return `${formatCompactUnitAmount(value / 1_000_000_000, locale)}B`;
  }
  if (value >= 1_000_000) {
    // 旧实现对所有 >=1000 的值都用 k 和固定小数点，3 100 000 因此渲染成 3100k。
    // 百万级以上改用 locale-aware 的一位小数 M 缩写（ru-RU 得到 3,1M）。
    return `${formatCompactUnitAmount(value / 1_000_000, locale)}M`;
  }
  const thousands = value / 1_000;
  return `${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1)}k`;
}

type AgentGraphToolNode = ToolCallBlockRenderContext["toolCallNode"];
const AGENT_TOOL_NAMES = new Set(["Agent", "Task", "agent", "subagent"]);

interface AgentGraphNode {
  id: string;
  label: string;
  agentType: string;
  status: string;
  usage?: string;
  children: AgentGraphNode[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textField(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function readAgentGraphUsage(output: unknown, locale: Locale): string | undefined {
  const text =
    typeof output === "string"
      ? output
      : typeof asRecord(output).content === "string"
        ? (asRecord(output).content as string)
        : "";
  const tokens = text.match(/subagent_tokens:\s*(\d+)/u)?.[1];
  const duration = text.match(/duration_ms:\s*(\d+)/u)?.[1];
  const parts = [
    ...(tokens ? [`${formatCompactTokenCount(Number(tokens), locale)} tok`] : []),
    ...(duration ? [`${Math.round(Number(duration) / 1_000)}s`] : []),
  ];
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function buildAgentGraphNode(
  node: AgentGraphToolNode,
  locale: Locale,
  fallbackLabel: string,
  authoritativeAgentType?: string,
): AgentGraphNode | undefined {
  const name = node.toolCall.toolName ?? node.toolCall.kind;
  if (!AGENT_TOOL_NAMES.has(name)) return undefined;
  const input = asRecord(node.toolCall.input);
  const output = node.toolCall.output;
  const children = node.childToolCalls
    .map((child) => buildAgentGraphNode(child, locale, fallbackLabel))
    .filter((child): child is AgentGraphNode => child !== undefined);
  return {
    id: node.toolCall.toolId,
    label: textField(input, "description") ?? node.toolCall.title ?? name,
    agentType: getAgentGraphType(node.toolCall, fallbackLabel, authoritativeAgentType),
    status: node.toolCall.status,
    ...(readAgentGraphUsage(output, locale) ? { usage: readAgentGraphUsage(output, locale) } : {}),
    children,
  };
}

function AgentGraphNodeView({ node, depth }: { node: AgentGraphNode; depth: number }) {
  const statusClass =
    node.status === "completed" || node.status === "success"
      ? "bg-emerald-500"
      : node.status === "failed" || node.status === "error"
        ? "bg-red-500"
        : "bg-amber-500";
  return (
    <li className="min-w-0">
      <div
        className="flex min-w-0 items-start gap-2 rounded-md py-1"
        style={{ paddingLeft: depth === 0 ? 0 : depth * 16 }}
      >
        <span aria-hidden className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", statusClass)} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="truncate font-medium text-foreground">{node.label}</span>
            <span className="shrink-0 rounded border border-border bg-surface px-1 py-0.5 font-mono text-ui-xs text-foreground-subtle">
              {node.agentType}
            </span>
            {node.usage ? (
              <span className="shrink-0 text-ui-xs tabular-nums text-foreground-subtle">
                {node.usage}
              </span>
            ) : null}
          </div>
          {node.children.length > 0 ? (
            <ul className="mt-1 space-y-0.5 border-border border-l pl-3">
              {node.children.map((child) => (
                <AgentGraphNodeView key={child.id} node={child} depth={depth + 1} />
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function AgentChildToolList({
  nestedToolRenderer,
  childToolCalls,
  workspacePath,
  theme,
  codePreviewSettings,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
  onOpenAutomationsMain,
  onLoadFullToolCallFields,
}: {
  nestedToolRenderer: ToolCallBlockRenderContext["nestedToolRenderer"];
  childToolCalls: ToolCallBlockRenderContext["toolCallNode"]["childToolCalls"];
  workspacePath: string;
  theme?: ToolCallBlockRenderContext["theme"];
  codePreviewSettings?: ToolCallBlockRenderContext["codePreviewSettings"];
  onOpenCodeViewer?: ToolCallBlockRenderContext["onOpenCodeViewer"];
  onOpenFileLink?: ToolCallBlockRenderContext["onOpenFileLink"];
  onOpenBrowserUrl?: ToolCallBlockRenderContext["onOpenBrowserUrl"];
  onOpenAutomationsMain?: ToolCallBlockRenderContext["onOpenAutomationsMain"];
  onLoadFullToolCallFields?: ToolCallBlockRenderContext["onLoadFullToolCallFields"];
}) {
  if (childToolCalls.length === 0) {
    return null;
  }

  const ToolCallBlock = nestedToolRenderer;
  return (
    <div className="space-y-2">
      {childToolCalls.map((childToolCallNode) => (
        <ToolCallBlock
          key={childToolCallNode.toolCall.toolId}
          toolCallNode={childToolCallNode}
          depth={1}
          workspacePath={workspacePath}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          showIcon={false}
          onOpenCodeViewer={onOpenCodeViewer}
          onOpenFileLink={onOpenFileLink}
          onOpenBrowserUrl={onOpenBrowserUrl}
          onOpenAutomationsMain={onOpenAutomationsMain}
          onLoadFullToolCallFields={onLoadFullToolCallFields}
          suppressSourceLabel
        />
      ))}
    </div>
  );
}

function AgentActivitySection({
  label,
  content,
  workspacePath,
  theme,
  codePreviewSettings,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
}: {
  label: string;
  content: string;
  workspacePath: string;
  theme?: ToolCallBlockRenderContext["theme"];
  codePreviewSettings?: ToolCallBlockRenderContext["codePreviewSettings"];
  onOpenCodeViewer?: ToolCallBlockRenderContext["onOpenCodeViewer"];
  onOpenFileLink?: ToolCallBlockRenderContext["onOpenFileLink"];
  onOpenBrowserUrl?: ToolCallBlockRenderContext["onOpenBrowserUrl"];
}) {
  return (
    <section className="space-y-2">
      <div className="rounded-lg border border-border bg-background-alt/40 flex flex-col">
        <h4 className="p-3 text-ui-base font-medium tracking-wide text-foreground-subtlest uppercase">
          {label}
        </h4>
        <div className="overflow-auto max-h-64" data-markdown-table-sticky-scrollbar="disabled">
          {/* Agent 活动内容同样可能包含长代码/路径，允许横向滚动避免窄屏截断。*/}
          <MessageResponse
            className="px-3 py-2 min-w-0 break-words text-ui-base [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            workspacePath={workspacePath}
            theme={theme}
            codePreviewSettings={codePreviewSettings}
            onOpenCodeViewer={onOpenCodeViewer}
            onOpenFileLink={onOpenFileLink}
            onOpenExternalUrl={onOpenBrowserUrl}
          >
            {content}
          </MessageResponse>
        </div>
      </div>
    </section>
  );
}

function BackgroundAgentProcessRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-2">
      <div className="text-foreground-subtlest">{label}</div>
      <div className="min-w-0 text-foreground-subtle">{children}</div>
    </div>
  );
}

function AgentNameText({ color, name }: { color: AgentColor; name: string }) {
  return (
    <span
      className={cn(
        // 子智能体名在 tool summary 行内不能依赖字体基线对齐。
        // inline-flex 负责垂直居中，1.5 倍行高保持和周围摘要文字一致的阅读节奏。
        "inline-flex max-w-36 items-center truncate font-mono text-ui-base font-medium leading-[1.5]",
        SUBAGENT_TEXT_COLOR_CLASS[color],
      )}
      title={name}
    >
      {name}
    </span>
  );
}

function BackgroundAgentProcessSection({
  outputFile,
  hasActivity,
  isRunning,
  status,
}: {
  outputFile?: string;
  hasActivity: boolean;
  isRunning: boolean;
  status: string | undefined;
}) {
  const { intl } = useZCodeIntl();
  const msg = (id: string, fallback: string) => formatAgentMessage(intl, id, fallback);
  const launchStatus =
    status === "failed"
      ? msg("chat.toolCall.agent.backgroundLaunchFailed", "启动失败")
      : status === "pending"
        ? msg("chat.toolCall.agent.backgroundLaunching", "启动中")
        : msg("chat.toolCall.agent.backgroundLaunched", "已启动");
  const launchStatusKind =
    status === "failed" ? "failed" : status === "pending" ? "pending" : "launched";
  const activityStatus = isRunning
    ? hasActivity
      ? msg("chat.toolCall.agent.backgroundActivityStreaming", "后台运行中，正在同步输出")
      : msg("chat.toolCall.agent.backgroundActivityRunningWaiting", "后台运行中，等待输出")
    : hasActivity
      ? msg("chat.toolCall.agent.backgroundActivityReceived", "已收到子智能体回传")
      : msg("chat.toolCall.agent.backgroundActivityWaiting", "等待子智能体回传");
  const activityStatusKind = isRunning
    ? hasActivity
      ? "streaming"
      : "running_waiting"
    : hasActivity
      ? "received"
      : "waiting";

  return (
    <section
      data-background-agent-activity-status={activityStatusKind}
      data-background-agent-launch-status={launchStatusKind}
      className="rounded-lg border border-border bg-background-alt/40 p-3 text-ui-base"
    >
      <div className="font-medium text-foreground-subtle">
        {msg("chat.toolCall.agent.backgroundProcess", "后台 Agent 过程")}
      </div>
      <div className="mt-2 space-y-2">
        <BackgroundAgentProcessRow label={msg("chat.toolCall.agent.backgroundLaunch", "启动")}>
          {launchStatus}
        </BackgroundAgentProcessRow>
        <BackgroundAgentProcessRow label={msg("chat.toolCall.agent.backgroundActivity", "活动")}>
          {activityStatus}
        </BackgroundAgentProcessRow>
        {outputFile ? (
          <BackgroundAgentProcessRow label={msg("chat.toolCall.agent.outputFile", "输出文件")}>
            <span className="block break-all rounded-md bg-background px-2 py-1 font-mono text-foreground-subtle">
              {outputFile}
            </span>
          </BackgroundAgentProcessRow>
        ) : null}
      </div>
    </section>
  );
}

export function AgentToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl, locale } = useZCodeIntl();
  const { toolCall, childToolCalls } = context.toolCallNode;
  const [graphOpen, setGraphOpen] = useState(false);
  const fallbackLabel = formatAgentMessage(intl, "chat.toolCall.agent.fallback", "SubAgent");
  const graphRoot = useMemo(
    () =>
      buildAgentGraphNode(
        context.toolCallNode,
        locale,
        fallbackLabel,
        context.authoritativeAgentType,
      ),
    [context.authoritativeAgentType, context.toolCallNode, fallbackLabel, locale],
  );
  const hasGraph = graphRoot !== undefined && graphRoot.children.length > 0;
  const prompt = getAgentPrompt(toolCall);
  const primaryText = getAgentPrimaryText(toolCall, fallbackLabel);
  const agentName = getAgentKindLabel(toolCall, fallbackLabel, context.authoritativeAgentType);
  const configuredAgentColor = useToolPresentationCapabilities().agentColor?.(agentName);
  const agentColor = agentName
    ? (configuredAgentColor ?? getAgentColor(toolCall) ?? resolveSubagentColorFromName(agentName))
    : null;
  const agentNameText =
    agentName && agentColor ? <AgentNameText color={agentColor} name={agentName} /> : null;
  const reasoningLevel = context.authoritativeReasoningLevel?.trim();
  const subagentUsage = context.authoritativeSubagentUsage;
  // own / subtree: второй компонент появляется только когда потомки реально добавили расход.
  const formatOwnVsSubtree = (
    own: number | undefined,
    subtree: number | undefined,
    format: (value: number) => string,
  ): string | undefined => {
    if (own === undefined && subtree === undefined) return undefined;
    if (own !== undefined && subtree !== undefined && subtree !== own) {
      return `${format(own)} / ${format(subtree)}`;
    }
    return format(own ?? subtree!);
  };
  const tokenUsage = formatOwnVsSubtree(
    subagentUsage?.totalTokens,
    subagentUsage?.subtreeTotalTokens,
    (value) => `${formatCompactTokenCount(value, locale)} tok`,
  );
  const durationUsage = formatOwnVsSubtree(
    subagentUsage?.totalDurationMs,
    subagentUsage?.subtreeTotalDurationMs,
    (value) => formatBackgroundTaskElapsedLabel(Math.max(0, value), intl.formatMessage),
  );
  // Breakdown относится к той же сумме, что и tokenUsage: если показан subtree,
  // вход/выход/кэш тоже берём по всему поддереву, а не только own.
  const subtreeBreakdown =
    subagentUsage?.subtreeTotalTokens !== undefined &&
    subagentUsage.subtreeTotalTokens !== subagentUsage.totalTokens;
  const breakdownInput = subtreeBreakdown
    ? (subagentUsage?.subtreeInputTokens ?? subagentUsage?.inputTokens)
    : subagentUsage?.inputTokens;
  const breakdownOutput = subtreeBreakdown
    ? (subagentUsage?.subtreeOutputTokens ?? subagentUsage?.outputTokens)
    : subagentUsage?.outputTokens;
  const breakdownCacheRead = subtreeBreakdown
    ? (subagentUsage?.subtreeCacheReadTokens ?? subagentUsage?.cacheReadTokens)
    : subagentUsage?.cacheReadTokens;
  const usageBreakdown = [
    breakdownInput === undefined
      ? undefined
      : intl.formatMessage(
          { id: "chat.toolCall.agent.usage.input" },
          { count: formatCompactTokenCount(breakdownInput, locale) },
        ),
    breakdownOutput === undefined
      ? undefined
      : intl.formatMessage(
          { id: "chat.toolCall.agent.usage.output" },
          { count: formatCompactTokenCount(breakdownOutput, locale) },
        ),
    breakdownCacheRead === undefined
      ? undefined
      : intl.formatMessage(
          { id: "chat.toolCall.agent.usage.cache" },
          { count: formatCompactTokenCount(breakdownCacheRead, locale) },
        ),
  ]
    .filter(Boolean)
    .join(" · ");
  const usageText = [tokenUsage, durationUsage, usageBreakdown].filter(Boolean).join(" · ");
  const agentNameDetail =
    agentNameText || reasoningLevel || usageText || hasGraph ? (
      <span className="inline-flex min-w-0 items-center gap-1">
        {agentNameText}
        {reasoningLevel ? (
          <span className="shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-ui-xs text-[var(--color-foreground-subtle)]">
            {reasoningLevel}
          </span>
        ) : null}
        {usageText ? (
          <span className="shrink-0 text-ui-xs tabular-nums text-[var(--color-foreground-subtle)]">
            {usageText}
          </span>
        ) : null}
        {hasGraph ? (
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1 rounded border border-border bg-surface px-1.5 py-0.5 text-ui-xs text-foreground-subtle transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
            onClick={(event) => {
              event.stopPropagation();
              setGraphOpen(true);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setGraphOpen(true);
              }
            }}
          >
            <WaypointsIcon aria-hidden className="size-3" />
            {formatAgentMessage(intl, "chat.toolCall.agent.graph", "Graph")}
          </button>
        ) : null}
      </span>
    ) : null;
  // Agent 父块的完成/进行中边界只由父 Agent tool 决定。
  // 子 tool 是展开区明细，不能反向续住父块运行态，否则父 Agent completed 后
  // 仍会显示渐变和子工具摘要，和协议里的父工具生命周期不一致。
  const isAgentVisuallyRunning = context.isRunning;
  const collapsedChildSummary = isAgentVisuallyRunning
    ? getLatestExploreChildSummaryFromChildren(intl, childToolCalls, context, {
        includeChildActionKindLabel: true,
      })
    : null;
  const backgroundAgentInfo = readBackgroundAgentInfo(toolCall);
  const activityContent = getAgentActivityContent(toolCall);
  const activityThought = toolCall.thought?.trim();
  // Agent 块和它内部的子工具都已经通过层级表达了来源，
  // 继续显示子智能体来源 badge 会制造重复噪音。
  const sourceLabel = undefined;
  const collapsedPrimaryText = useMemo(
    () => <span className="truncate">{primaryText}</span>,
    [primaryText],
  );
  const expandedPrimaryText = useMemo(
    () => <span className="truncate">{primaryText}</span>,
    [primaryText],
  );
  const summaryAction = useMemo(
    () =>
      context.agentSummaryAction
        ? {
            ...context.agentSummaryAction,
            ariaLabel: formatAgentMessage(
              intl,
              "chat.toolCall.agent.openInSidePane",
              "Open on the right",
            ),
          }
        : undefined,
    [context.agentSummaryAction, intl],
  );
  const renderContent = useCallback(
    () => (
      <div className="ml-2 space-y-3 border-border border-l pl-3.5">
        {backgroundAgentInfo ? (
          <BackgroundAgentProcessSection
            outputFile={backgroundAgentInfo.outputFile}
            hasActivity={Boolean(activityContent || activityThought)}
            isRunning={isAgentVisuallyRunning}
            status={toolCall.status}
          />
        ) : null}
        {prompt ? (
          <AgentPromptSection
            prompt={prompt}
            workspacePath={context.workspacePath}
            theme={context.theme}
            codePreviewSettings={context.codePreviewSettings}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
          />
        ) : null}
        {activityThought ? (
          <AgentActivitySection
            label={formatAgentMessage(intl, "chat.toolCall.agent.thought", "Agent thought")}
            content={activityThought}
            workspacePath={context.workspacePath}
            theme={context.theme}
            codePreviewSettings={context.codePreviewSettings}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
          />
        ) : null}
        {activityContent ? (
          <AgentActivitySection
            label={formatAgentMessage(intl, "chat.toolCall.agent.output", "Agent output")}
            content={activityContent}
            workspacePath={context.workspacePath}
            theme={context.theme}
            codePreviewSettings={context.codePreviewSettings}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
          />
        ) : null}
        <AgentChildToolList
          nestedToolRenderer={context.nestedToolRenderer}
          childToolCalls={childToolCalls}
          workspacePath={context.workspacePath}
          theme={context.theme}
          codePreviewSettings={context.codePreviewSettings}
          onOpenCodeViewer={context.onOpenCodeViewer}
          onOpenFileLink={context.onOpenFileLink}
          onOpenBrowserUrl={context.onOpenBrowserUrl}
          onOpenAutomationsMain={context.onOpenAutomationsMain}
          onLoadFullToolCallFields={context.onLoadFullToolCallFields}
        />
      </div>
    ),
    [
      activityContent,
      activityThought,
      backgroundAgentInfo,
      childToolCalls,
      context.codePreviewSettings,
      context.onLoadFullToolCallFields,
      context.onOpenBrowserUrl,
      context.onOpenCodeViewer,
      context.onOpenFileLink,
      context.theme,
      context.workspacePath,
      intl,
      isAgentVisuallyRunning,
      prompt,
      toolCall.status,
    ],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={AGENT_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={false}
        forceOpen={false}
        summaryAction={summaryAction}
        // 产品边界：Agent/Task 在父对话中只保留单行摘要；完整 child timeline 统一从
        // 右侧 tab / 手机抽屉查看，因此这里既不自动展开，也不提供手动展开入口。
        kindLabel={fallbackLabel}
        expandedKindLabel={fallbackLabel}
        kindDetail={agentNameDetail}
        expandedKindDetail={agentNameDetail}
        sourceLabel={sourceLabel}
        autoCollapseOnComplete
        primaryText={
          collapsedChildSummary ? collapsedChildSummary.primaryText : collapsedPrimaryText
        }
        expandedPrimaryText={expandedPrimaryText}
        secondaryText={collapsedChildSummary?.secondaryText}
        expandedSecondaryText={null}
        summaryContentSeparator="·"
        animateSummaryContent
        disableSummaryContentAnimation={context.disableSummaryContentAnimation}
        summaryContentKey={
          collapsedChildSummary?.animationKey ?? `agent:${toolCall.toolId}:${primaryText}`
        }
        statusLabel={context.statusLabel}
        statusTooltip={toolCall.status === "failed" ? context.errorText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={isAgentVisuallyRunning}
        title={collapsedChildSummary?.title ?? primaryText}
        expandedTitle={primaryText}
        renderContent={renderContent}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
      {graphRoot && hasGraph ? (
        <Dialog open={graphOpen} onOpenChange={setGraphOpen}>
          <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {formatAgentMessage(intl, "chat.toolCall.agent.graphTitle", "Agent graph")}
              </DialogTitle>
              <DialogDescription>
                {formatAgentMessage(
                  intl,
                  "chat.toolCall.agent.graphDescription",
                  "Who spawned whom, with status and token/time where runtime reported it.",
                )}
              </DialogDescription>
            </DialogHeader>
            <ul className="space-y-1">
              <AgentGraphNodeView node={graphRoot} depth={0} />
            </ul>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
