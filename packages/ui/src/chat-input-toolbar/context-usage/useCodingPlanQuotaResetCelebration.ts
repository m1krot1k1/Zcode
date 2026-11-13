import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import type { CodingPlanResetType } from "@zcode/shared";
import {
  type ChatCodingPlanUsageRemainingConfig,
  type CodingPlanQuotaResetAutoConfettiArms,
} from "@/chat-input-toolbar/CodingPlanContextUsage.js";
import { resolveChatCodingPlanResetOpportunityBadge } from "@/chat-input-toolbar/codingPlanResetOpportunityBadge.js";
import { coordinateCodingPlanQuotaResetAutoPlay } from "@/chat-input-toolbar/codingPlanQuotaResetAutoPlay.js";
import {
  CONTEXT_QUOTA_RESET_URGENT_SECONDS,
  contextQuotaResetOpportunityDismissalStore,
  resolveContextQuotaResetOpportunityReminder,
  resolveContextQuotaResetOpportunityTriggerTone,
  resolveContextTriggerTooltipKind,
  shouldDismissContextQuotaResetOpportunityReminder,
} from "@/chat-input-toolbar/contextQuotaResetOpportunityReminder.js";
import { useCodingPlanQuotaResetUi } from "@/hooks/useCodingPlanQuotaResetUi.js";
import {
  CODING_PLAN_QUOTA_RESET_AUTOMATIC_PROCESSING_MS,
  CODING_PLAN_QUOTA_RESET_TYPES,
  advanceCodingPlanQuotaResetCelebration,
  pruneCodingPlanQuotaResetConfettiArms,
  resolveCodingPlanQuotaResetAutomaticPhase,
  type CodingPlanQuotaResetAutomaticPhase,
  type CodingPlanQuotaResetCelebrationState,
  type CodingPlanQuotaResetUiEntry,
} from "@/lib/codingPlanQuotaResetUi.js";
import { resolveCodingPlanUsageRemainingState } from "@/CodingPlanUsageRemainingPanel.js";

export interface UseCodingPlanQuotaResetCelebrationOptions {
  codingPlanUsageRemaining: ChatCodingPlanUsageRemainingConfig | undefined;
  contextOpen: boolean;
  contextUsageTriggerRef: RefObject<HTMLElement | null>;
  isWorkspaceVisible: boolean;
}

export interface UseCodingPlanQuotaResetCelebrationResult {
  activeResetType: CodingPlanResetType | null;
  armedAutoConfetti: CodingPlanQuotaResetAutoConfettiArms;
  dismissOpportunityReminder: () => void;
  handleAutoResetCelebrated: (completedAt: number) => void;
  opportunityReminder: ReturnType<typeof resolveContextQuotaResetOpportunityReminder>;
  opportunityTriggerTone: ReturnType<typeof resolveContextQuotaResetOpportunityTriggerTone>;
  resetStatusTooltipOpen: boolean;
  resetTooltipPhase: CodingPlanQuotaResetAutomaticPhase | null;
  triggerTooltipKind: ReturnType<typeof resolveContextTriggerTooltipKind>;
}

// 自动/运营完成（startedAt 为空）当前生效的 used_at；手动完成不进入触发器交互。
function resolveAutomaticCompletedAt(entry: CodingPlanQuotaResetUiEntry | null): number | null {
  return entry?.status === "completed" && entry.startedAt === null && entry.observedAt !== null
    ? entry.completedAt
    : null;
}

/** Coding Plan 额度重置的自动播放 claim、触发器提醒与撒花状态；与面板配置解耦，只消费已关闭包装的额度配置。 */
export function useCodingPlanQuotaResetCelebration({
  codingPlanUsageRemaining,
  contextOpen,
  contextUsageTriggerRef,
  isWorkspaceVisible,
}: UseCodingPlanQuotaResetCelebrationOptions): UseCodingPlanQuotaResetCelebrationResult {
  // 自动重置：触发器和面板复用同一完整 Personal/Team scope；共享 in-flight 避免重复请求。
  const resetCodingPlanState = useMemo(
    () =>
      codingPlanUsageRemaining
        ? resolveCodingPlanUsageRemainingState(codingPlanUsageRemaining)
        : null,
    [codingPlanUsageRemaining],
  );
  const resetSourceKey = resetCodingPlanState?.displayedProviderId ?? null;
  const resetUi = useCodingPlanQuotaResetUi({
    sourceKey: resetSourceKey,
    preferredProviderId: resetCodingPlanState?.displayedEntitlement?.providerId,
    accountAccess: resetCodingPlanState?.displayedEntitlement?.accountAccess,
    onEntitlementRefresh: codingPlanUsageRemaining?.onEntitlementRefresh,
  });
  const opportunityBadge = resolveChatCodingPlanResetOpportunityBadge(
    resetCodingPlanState,
    resetUi,
  );
  const [opportunityNow, setOpportunityNow] = useState(() => Date.now());
  const opportunityDismissal = useSyncExternalStore(
    contextQuotaResetOpportunityDismissalStore.subscribe,
    contextQuotaResetOpportunityDismissalStore.getSnapshot,
    contextQuotaResetOpportunityDismissalStore.getSnapshot,
  );
  useEffect(() => {
    const now = Date.now();
    if (
      !opportunityBadge.visible ||
      opportunityBadge.expiresAt === null ||
      opportunityBadge.expiresAt <= now
    ) {
      return;
    }
    setOpportunityNow(now);
    let countdownTimer: number | undefined;
    let urgentThresholdTimer: number | undefined;
    const startUrgentCountdown = () => {
      const update = () => {
        const currentNow = Date.now();
        setOpportunityNow(currentNow);
        const expired = (opportunityBadge.expiresAt ?? 0) <= currentNow;
        if (expired && countdownTimer !== undefined) {
          window.clearInterval(countdownTimer);
          countdownTimer = undefined;
        }
        return expired;
      };
      if (!update()) {
        countdownTimer = window.setInterval(update, 1_000);
      }
    };
    const untilUrgent =
      opportunityBadge.expiresAt - now - CONTEXT_QUOTA_RESET_URGENT_SECONDS * 1_000;
    if (untilUrgent <= 0) {
      startUrgentCountdown();
    } else {
      urgentThresholdTimer = window.setTimeout(startUrgentCountdown, untilUrgent);
    }
    return () => {
      if (countdownTimer !== undefined) window.clearInterval(countdownTimer);
      if (urgentThresholdTimer !== undefined) window.clearTimeout(urgentThresholdTimer);
    };
  }, [opportunityBadge.expiresAt, opportunityBadge.visible, resetSourceKey]);
  const opportunityReminder = resolveContextQuotaResetOpportunityReminder({
    dismissal: opportunityDismissal,
    now: opportunityNow,
    opportunity: { ...opportunityBadge, sourceKey: resetSourceKey },
  });
  const opportunityTriggerTone = resolveContextQuotaResetOpportunityTriggerTone({
    now: opportunityNow,
    opportunity: { ...opportunityBadge, sourceKey: resetSourceKey },
  });
  const dismissOpportunityReminder = useCallback(() => {
    if (!opportunityReminder) return;
    contextQuotaResetOpportunityDismissalStore.dismiss(opportunityReminder);
  }, [opportunityReminder?.opportunityKey, opportunityReminder?.phase]);
  useEffect(() => {
    // 设置覆盖层保留工作区挂载；后台监听不能把设置页点击算作提醒已读。
    if (!isWorkspaceVisible || !opportunityReminder || contextOpen) return;
    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (
        shouldDismissContextQuotaResetOpportunityReminder(
          event.target,
          contextUsageTriggerRef.current,
        )
      ) {
        dismissOpportunityReminder();
      }
    };
    document.addEventListener("pointerdown", handleOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", handleOutsidePointerDown, true);
  }, [
    isWorkspaceVisible,
    contextOpen,
    dismissOpportunityReminder,
    opportunityReminder?.opportunityKey,
    opportunityReminder?.phase,
  ]);
  // 五小时与周额度各自维护撒花轨迹，避免一类完成压制另一类的触发器动效。
  const resetCelebrationStateByTypeRef = useRef<
    Record<CodingPlanResetType, CodingPlanQuotaResetCelebrationState | null>
  >({ FIVE_HOUR: null, WEEK: null });
  const fiveHourEntry = resetUi.entry;
  const weekEntry = resetUi.week.entry;
  // 自动/运营完成（startedAt 为空）只是播放候选；status 入口不能直接驱动 Tooltip/撒花。
  const automaticCompletionCandidateByType = useMemo<Record<CodingPlanResetType, number | null>>(
    () => ({
      FIVE_HOUR: resolveAutomaticCompletedAt(fiveHourEntry),
      WEEK: resolveAutomaticCompletedAt(weekEntry),
    }),
    [fiveHourEntry, weekEntry],
  );
  const [claimedAutomaticCompletion, setClaimedAutomaticCompletion] = useState<{
    sourceKey: string | null;
    completedAtByType: CodingPlanQuotaResetAutoConfettiArms;
  }>({
    sourceKey: null,
    completedAtByType: { FIVE_HOUR: null, WEEK: null },
  });
  const claimedAutomaticCompletionRef = useRef(claimedAutomaticCompletion);
  claimedAutomaticCompletionRef.current = claimedAutomaticCompletion;
  const latestAutomaticCompletionCandidateRef = useRef({
    sourceKey: resetSourceKey,
    completedAtByType: automaticCompletionCandidateByType,
  });
  latestAutomaticCompletionCandidateRef.current = {
    sourceKey: resetSourceKey,
    completedAtByType: automaticCompletionCandidateByType,
  };
  const [autoPlayReservationRetryTick, setAutoPlayReservationRetryTick] = useState(0);

  // Main 返回 claim winner 前 Composer 可能已经卸载或切换 source。现在先获取带 token
  // 的临时 reservation，只有组件与候选仍有效且即将展示时才 commit played；失效 winner release，
  // busy loser 保留 observedAt，等待真实 played 广播或 reservation 释放后重试。
  useEffect(() => {
    let active = true;
    const retryTimers: Array<ReturnType<typeof setTimeout>> = [];
    const previous = claimedAutomaticCompletionRef.current;
    const sameSource = previous.sourceKey === resetSourceKey;
    const synchronized = {
      sourceKey: resetSourceKey,
      completedAtByType: {
        FIVE_HOUR:
          sameSource &&
          previous.completedAtByType.FIVE_HOUR === automaticCompletionCandidateByType.FIVE_HOUR
            ? previous.completedAtByType.FIVE_HOUR
            : null,
        WEEK:
          sameSource && previous.completedAtByType.WEEK === automaticCompletionCandidateByType.WEEK
            ? previous.completedAtByType.WEEK
            : null,
      },
    };
    if (
      previous.sourceKey !== synchronized.sourceKey ||
      previous.completedAtByType.FIVE_HOUR !== synchronized.completedAtByType.FIVE_HOUR ||
      previous.completedAtByType.WEEK !== synchronized.completedAtByType.WEEK
    ) {
      claimedAutomaticCompletionRef.current = synchronized;
      setClaimedAutomaticCompletion(synchronized);
    }

    for (const resetType of CODING_PLAN_QUOTA_RESET_TYPES) {
      const completedAt = automaticCompletionCandidateByType[resetType];
      if (completedAt === null || synchronized.completedAtByType[resetType] === completedAt) {
        continue;
      }
      void coordinateCodingPlanQuotaResetAutoPlay({
        reserve: () => resetUi.reserveAutomaticCompletion(resetType, completedAt),
        isCurrent: () => {
          const latest = latestAutomaticCompletionCandidateRef.current;
          return (
            active &&
            latest.sourceKey === resetSourceKey &&
            latest.completedAtByType[resetType] === completedAt
          );
        },
        commit: resetUi.commitAutomaticCompletion,
        release: resetUi.releaseAutomaticCompletion,
        onCommitted: () => {
          const current = claimedAutomaticCompletionRef.current;
          const completedAtByType =
            current.sourceKey === resetSourceKey
              ? current.completedAtByType
              : { FIVE_HOUR: null, WEEK: null };
          if (completedAtByType[resetType] === completedAt) {
            return;
          }
          const next = {
            sourceKey: resetSourceKey,
            completedAtByType: {
              ...completedAtByType,
              [resetType]: completedAt,
            },
          };
          claimedAutomaticCompletionRef.current = next;
          setClaimedAutomaticCompletion(next);
        },
      }).then((result) => {
        if (result.status !== "retry" || !active) {
          return;
        }
        const latest = latestAutomaticCompletionCandidateRef.current;
        if (
          latest.sourceKey !== resetSourceKey ||
          latest.completedAtByType[resetType] !== completedAt
        ) {
          return;
        }
        retryTimers.push(
          setTimeout(() => {
            if (active) {
              setAutoPlayReservationRetryTick((tick) => tick + 1);
            }
          }, result.retryAfterMs),
        );
      });
    }

    return () => {
      active = false;
      for (const timer of retryTimers) {
        clearTimeout(timer);
      }
    };
  }, [
    automaticCompletionCandidateByType.FIVE_HOUR,
    automaticCompletionCandidateByType.WEEK,
    autoPlayReservationRetryTick,
    resetSourceKey,
    resetUi.commitAutomaticCompletion,
    resetUi.releaseAutomaticCompletion,
    resetUi.reserveAutomaticCompletion,
  ]);

  // Tooltip/撒花只消费本窗口已经 claim 成功且仍对应当前候选的 used_at。
  const automaticCompletedAtByType = useMemo<Record<CodingPlanResetType, number | null>>(() => {
    if (claimedAutomaticCompletion.sourceKey !== resetSourceKey) {
      return { FIVE_HOUR: null, WEEK: null };
    }
    return {
      FIVE_HOUR:
        claimedAutomaticCompletion.completedAtByType.FIVE_HOUR ===
        automaticCompletionCandidateByType.FIVE_HOUR
          ? claimedAutomaticCompletion.completedAtByType.FIVE_HOUR
          : null,
      WEEK:
        claimedAutomaticCompletion.completedAtByType.WEEK ===
        automaticCompletionCandidateByType.WEEK
          ? claimedAutomaticCompletion.completedAtByType.WEEK
          : null,
    };
  }, [
    automaticCompletionCandidateByType.FIVE_HOUR,
    automaticCompletionCandidateByType.WEEK,
    claimedAutomaticCompletion,
    resetSourceKey,
  ]);
  const [resetTooltipNow, setResetTooltipNow] = useState(() => Date.now());
  // 已被 hover 收起的自动完成 used_at(按类型记录)；新的自动完成 used_at 不同会自动重新展示,
  // 因此某一类型完成时无需清空另一类型的收起状态。
  const [resetTooltipDismissed, setResetTooltipDismissed] =
    useState<CodingPlanQuotaResetAutoConfettiArms>({
      FIVE_HOUR: null,
      WEEK: null,
    });
  // 待补播撒花的自动完成 used_at(按类型记录)；hover 展开面板后由对应额度条「已重置」位置各迸发一次。
  const [armedAutoConfetti, setArmedAutoConfetti] = useState<CodingPlanQuotaResetAutoConfettiArms>({
    FIVE_HOUR: null,
    WEEK: null,
  });
  const isTypeDismissed = useCallback(
    (resetType: CodingPlanResetType): boolean => {
      const completedAt = automaticCompletedAtByType[resetType];
      return completedAt !== null && resetTooltipDismissed[resetType] === completedAt;
    },
    [automaticCompletedAtByType, resetTooltipDismissed],
  );
  const phaseByType = useMemo<
    Record<CodingPlanResetType, CodingPlanQuotaResetAutomaticPhase | null>
  >(
    () => ({
      FIVE_HOUR:
        automaticCompletedAtByType.FIVE_HOUR === null
          ? null
          : resolveCodingPlanQuotaResetAutomaticPhase(
              fiveHourEntry,
              resetTooltipNow,
              isTypeDismissed("FIVE_HOUR"),
            ),
      WEEK:
        automaticCompletedAtByType.WEEK === null
          ? null
          : resolveCodingPlanQuotaResetAutomaticPhase(
              weekEntry,
              resetTooltipNow,
              isTypeDismissed("WEEK"),
            ),
    }),
    [
      automaticCompletedAtByType.FIVE_HOUR,
      automaticCompletedAtByType.WEEK,
      fiveHourEntry,
      weekEntry,
      resetTooltipNow,
      isTypeDismissed,
    ],
  );
  // 两类同时处于自动提示阶段时，优先展示更晚被观察到的那一类（更贴近“刚刚发生”）。
  const activeResetType = useMemo<CodingPlanResetType | null>(() => {
    const candidates = CODING_PLAN_QUOTA_RESET_TYPES.filter(
      (resetType) => phaseByType[resetType] !== null,
    );
    if (candidates.length === 0) {
      return null;
    }
    return candidates.reduce((chosen, resetType) => {
      const chosenObserved = (chosen === "WEEK" ? weekEntry : fiveHourEntry)?.observedAt ?? 0;
      const currentObserved = (resetType === "WEEK" ? weekEntry : fiveHourEntry)?.observedAt ?? 0;
      return currentObserved > chosenObserved ? resetType : chosen;
    });
  }, [phaseByType, fiveHourEntry, weekEntry]);
  const resetTooltipPhase = activeResetType ? phaseByType[activeResetType] : null;
  const activeEntry =
    activeResetType === "WEEK" ? weekEntry : activeResetType === "FIVE_HOUR" ? fiveHourEntry : null;
  const triggerTooltipKind = resolveContextTriggerTooltipKind(
    resetTooltipPhase,
    opportunityReminder?.phase ?? null,
  );
  // Tooltip Portal 位于 body，工作区的 opacity/inert 隐藏不了它；必须跟随 Root 的设置标签可见性。
  const resetStatusTooltipOpen = isWorkspaceVisible && triggerTooltipKind !== null && !contextOpen;

  // 发现新的自动/运营完成：按类型重新计时合成“正在重置”,并 arm 对应额度条补播撒花。
  // 每类各自记录,一类完成不影响另一类；dismissed 按 used_at 记录,新 used_at 会自动重新展示。
  useEffect(() => {
    const armedByType: Partial<Record<CodingPlanResetType, number>> = {};
    for (const resetType of CODING_PLAN_QUOTA_RESET_TYPES) {
      const entry = resetType === "WEEK" ? weekEntry : fiveHourEntry;
      const automaticCompletedAt = automaticCompletedAtByType[resetType];
      const result = advanceCodingPlanQuotaResetCelebration(
        resetCelebrationStateByTypeRef.current[resetType],
        {
          sourceKey: resetSourceKey,
          completedAt: entry?.completedAt ?? null,
          automaticCompletion: automaticCompletedAt !== null,
        },
      );
      resetCelebrationStateByTypeRef.current[resetType] = result.state;
      if (result.shouldCelebrate && automaticCompletedAt !== null) {
        armedByType[resetType] = automaticCompletedAt;
      }
    }
    if (Object.keys(armedByType).length > 0) {
      setResetTooltipNow(Date.now());
      setArmedAutoConfetti((prev) => ({ ...prev, ...armedByType }));
    }
  }, [automaticCompletedAtByType, fiveHourEntry, weekEntry, resetSourceKey]);

  // 跨窗口"已播"广播会把正在展示的自动完成 observedAt 置空；此时已 arm 的
  // 补播撒花必须同步清除，否则本窗口 hover 面板时仍会撒花，违背“多窗口只播一次”。
  useEffect(() => {
    setArmedAutoConfetti((prev) =>
      pruneCodingPlanQuotaResetConfettiArms(prev, automaticCompletedAtByType),
    );
  }, [automaticCompletedAtByType]);

  // 合成“正在重置”阶段到期后切换为“已重置”（随后一直保留直到 hover 收起）。
  useEffect(() => {
    const observedAt = activeEntry?.observedAt ?? null;
    if (resetTooltipPhase !== "processing" || observedAt === null) {
      return;
    }
    const remaining = observedAt + CODING_PLAN_QUOTA_RESET_AUTOMATIC_PROCESSING_MS - Date.now();
    const timer = window.setTimeout(() => setResetTooltipNow(Date.now()), Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [resetTooltipPhase, activeEntry?.observedAt]);

  // 用户 hover 触发器展开额度面板：把当前处于自动提示阶段的**每一类**都标记收起,
  // 交由面板内对应重置项从同一位置补播撒花(两类可能同时处于提示阶段)。
  useEffect(() => {
    if (!contextOpen) {
      return;
    }
    if (opportunityReminder) {
      dismissOpportunityReminder();
    }
    setResetTooltipDismissed((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const resetType of CODING_PLAN_QUOTA_RESET_TYPES) {
        const completedAt = automaticCompletedAtByType[resetType];
        if (
          phaseByType[resetType] !== null &&
          completedAt !== null &&
          next[resetType] !== completedAt
        ) {
          next[resetType] = completedAt;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [
    contextOpen,
    phaseByType,
    automaticCompletedAtByType,
    opportunityReminder?.opportunityKey,
    opportunityReminder?.phase,
    dismissOpportunityReminder,
  ]);

  const handleAutoResetCelebrated = useCallback((completedAt: number) => {
    setArmedAutoConfetti((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const resetType of CODING_PLAN_QUOTA_RESET_TYPES) {
        if (next[resetType] === completedAt) {
          next[resetType] = null;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  return {
    activeResetType,
    armedAutoConfetti,
    dismissOpportunityReminder,
    handleAutoResetCelebrated,
    opportunityReminder,
    opportunityTriggerTone,
    resetStatusTooltipOpen,
    resetTooltipPhase,
    triggerTooltipKind,
  };
}
