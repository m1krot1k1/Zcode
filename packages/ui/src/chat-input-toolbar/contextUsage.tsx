import { useMemo } from "react";
import type { ZCodeProvider } from "@zcode/shared";
import { TID_CHAT_CONTEXT_USAGE_TRIGGER } from "@zcode/shared/test-ids";
import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextTrigger,
} from "@/components/ai-elements/context.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { CodingPlanQuotaResetStatusContent } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetStatus.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ChatCodingPlanUsageRemainingConfig } from "@/chat-input-toolbar/CodingPlanContextUsage.js";
import type { ChatStartPlanBalanceConfig } from "@/chat-input-toolbar/StartPlanContextBalance.js";
import { ContextQuotaResetOpportunityReminderContent } from "@/chat-input-toolbar/contextQuotaResetOpportunityReminder.js";
import { ContextUsageBody } from "./context-usage/ContextUsageBody.js";
import { useCodingPlanQuotaResetCelebration } from "./context-usage/useCodingPlanQuotaResetCelebration.js";
import { useContextUsagePanelConfig } from "./context-usage/useContextUsagePanelConfig.js";
import {
  buildContextUsageBreakdownSegments,
  buildContextUsageProgressSegments,
  formatContextCacheHitRateLabel,
  formatContextUsageSummary,
  type ContextUsageTaskUsage,
} from "./context-usage/usageFormatting.js";

export {
  buildContextUsageBreakdownSegments,
  formatContextCacheHitRateLabel,
  formatContextUsageSummary,
  formatContextUsageTokenCount,
} from "./context-usage/usageFormatting.js";

export function refreshContextUsageOnOpen(
  open: boolean,
  onAccess: (() => Promise<void> | void) | undefined,
): void {
  if (open) {
    void onAccess?.();
  }
}

export function ChatContextUsage({
  codingPlanUsageRemaining,
  startPlanBalance,
  taskUsage,
  selectedProvider: _selectedProvider,
  intl,
  locale,
}: {
  codingPlanUsageRemaining?: ChatCodingPlanUsageRemainingConfig;
  startPlanBalance?: ChatStartPlanBalanceConfig;
  taskUsage: ContextUsageTaskUsage | null;
  selectedProvider: ZCodeProvider;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  locale: string;
  onSendCompressionCommand?: (command: string) => void;
  compressionDisabled?: boolean;
}) {
  const panel = useContextUsagePanelConfig({
    codingPlanUsageRemaining,
    startPlanBalance,
    taskUsage,
  });
  const celebration = useCodingPlanQuotaResetCelebration({
    codingPlanUsageRemaining: panel.codingPlanUsageRemainingWithClose,
    contextOpen: panel.contextOpen,
    contextUsageTriggerRef: panel.contextUsageTriggerRef,
    isWorkspaceVisible: panel.isWorkspaceVisible,
  });
  // MCP 与不足三张的主额度同排；主额度占满三列时才在下一行贯穿，浮层始终保持统一宽度。
  const contextPanelWidthClass = "!w-80";
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const contextUsageLabel = useMemo(() => {
    if (!panel.renderableTaskUsage) {
      return null;
    }

    return intl.formatMessage(
      { id: "chat.contextUsage" },
      {
        used: numberFormatter.format(panel.renderableTaskUsage.used),
        total: numberFormatter.format(panel.renderableTaskUsage.size),
      },
    );
  }, [intl, numberFormatter, panel.renderableTaskUsage]);
  const cacheHitRateLabel = useMemo(() => {
    return formatContextCacheHitRateLabel(panel.renderableTaskUsage?.cache?.hitRate, locale, {
      showBelowThreshold: import.meta.env.DEV,
    });
  }, [locale, panel.renderableTaskUsage]);
  const breakdownSegments = useMemo(
    () => buildContextUsageBreakdownSegments(panel.renderableTaskUsage?.breakdown),
    [panel.renderableTaskUsage?.breakdown],
  );
  const progressSegments = useMemo(
    () => buildContextUsageProgressSegments(breakdownSegments),
    [breakdownSegments],
  );
  const percentageFormatter = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        maximumFractionDigits: 1,
        style: "percent",
      }),
    [locale],
  );

  if (
    (!panel.renderableTaskUsage || !contextUsageLabel) &&
    !panel.hasCodingPlanUsageRemaining &&
    !panel.hasStartPlanBalance
  ) {
    return null;
  }

  const usagePercent = panel.renderableTaskUsage
    ? Math.min(Math.max(panel.renderableTaskUsage.used / panel.renderableTaskUsage.size, 0), 1)
    : 0;
  const compactTokenUsageLabel = panel.renderableTaskUsage
    ? formatContextUsageSummary({
        locale,
        percent: usagePercent,
        size: panel.renderableTaskUsage.size,
        used: panel.renderableTaskUsage.used,
      })
    : null;
  const triggerLabel =
    contextUsageLabel ??
    (panel.hasCodingPlanUsageRemaining
      ? intl.formatMessage({ id: "sidebar.usage.plan.title" })
      : intl.formatMessage({
          id: "settings.modelProvider.startPlan.balance.title",
        }));
  const contextUsedTokens = panel.renderableTaskUsage?.used ?? 0;
  const contextMaxTokens = panel.renderableTaskUsage?.size ?? 1;

  return (
    <Context
      usedTokens={contextUsedTokens}
      maxTokens={contextMaxTokens}
      open={panel.contextOpen}
      onOpenChange={panel.handleContextOpenChange}
    >
      <ControlHintTooltip
        className={
          celebration.triggerTooltipKind === "reset-status"
            ? undefined
            : "bg-background py-0.5 pr-0.5"
        }
        open={celebration.resetStatusTooltipOpen}
        side="top"
        standalone
        triggerRef={panel.contextUsageTriggerRef}
        title={
          celebration.triggerTooltipKind === "reset-status" && celebration.resetTooltipPhase ? (
            <CodingPlanQuotaResetStatusContent
              status={celebration.resetTooltipPhase}
              resetType={celebration.activeResetType ?? "FIVE_HOUR"}
            />
          ) : celebration.opportunityReminder ? (
            <ContextQuotaResetOpportunityReminderContent
              count={celebration.opportunityReminder.count}
              intl={intl}
              onDismiss={celebration.dismissOpportunityReminder}
              phase={celebration.opportunityReminder.phase}
              remainingSeconds={celebration.opportunityReminder.remainingSeconds}
            />
          ) : null
        }
      >
        {/* Bugfix：span 承载 ControlHintTooltip 的 asChild 锚点，内部 ContextTrigger 仍作为
            HoverCard 触发器，避免两个 Radix 浮层在同一 DOM 上叠加 ref。手动核销的
            processing 由弹层内「重置」按钮自身展示，触发器不转圈。 */}
        <span className="inline-flex shrink-0">
          <ContextTrigger
            aria-label={triggerLabel}
            className={cn(
              "text-foreground-subtle",
              celebration.opportunityTriggerTone === "available" && "text-success",
              celebration.opportunityTriggerTone === "urgent" && "bg-warning/10 text-warning",
            )}
            data-chat-toolbar-popover-trigger="true"
            data-testid={TID_CHAT_CONTEXT_USAGE_TRIGGER}
            onPointerDown={(event) => {
              // Radix HoverCard 会在 touchstart 中阻止后续 click，手机端无法打开面板；
              // 在触摸 pointerdown 阶段先打开，桌面端继续保持原有 hover/focus 语义。
              if (
                !event.defaultPrevented &&
                event.pointerType === "touch" &&
                typeof window !== "undefined" &&
                window.matchMedia?.("(hover: none)").matches
              ) {
                // 统一走受控 open handler，确保触摸打开也会触发额度 access 刷新和刷新态反馈。
                if (!panel.contextOpen) {
                  panel.handleContextOpenChange(true);
                }
              }
            }}
          />
        </span>
      </ControlHintTooltip>
      <ContextContent
        className={cn(contextPanelWidthClass, "!rounded-xl !shadow-md")}
        side="top"
        sideOffset={2}
      >
        <ContextContentBody className="space-y-3">
          <ContextUsageBody
            armedAutoConfetti={celebration.armedAutoConfetti}
            breakdownSegments={breakdownSegments}
            cacheHitRateLabel={cacheHitRateLabel}
            codingPlanUsageRemaining={panel.codingPlanUsageRemainingWithClose}
            compactTokenUsageLabel={compactTokenUsageLabel}
            hasCodingPlanUsageRemaining={panel.hasCodingPlanUsageRemaining}
            hasStartPlanBalance={panel.hasStartPlanBalance}
            intl={intl}
            locale={locale}
            onAutoResetCelebrated={celebration.handleAutoResetCelebrated}
            onQuotaResetDialogOpenChange={panel.handleQuotaResetDialogOpenChange}
            percentageFormatter={percentageFormatter}
            progressSegments={progressSegments}
            quotaResetDialogOpen={panel.quotaResetDialogOpen}
            renderableTaskUsage={panel.renderableTaskUsage}
            startPlanBalance={panel.startPlanBalanceWithClose}
            usagePercent={usagePercent}
          />
        </ContextContentBody>
      </ContextContent>
    </Context>
  );
}
