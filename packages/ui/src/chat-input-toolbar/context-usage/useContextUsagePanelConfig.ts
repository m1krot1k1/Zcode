import { useCallback, useMemo, useRef, useState } from "react";
import {
  hasChatCodingPlanUsageRemaining,
  type ChatCodingPlanUsageRemainingConfig,
} from "@/chat-input-toolbar/CodingPlanContextUsage.js";
import {
  hasChatStartPlanBalance,
  type ChatStartPlanBalanceConfig,
} from "@/chat-input-toolbar/StartPlanContextBalance.js";
import { runContextPanelActionWithClose } from "@/chat-input-toolbar/contextPanelAction.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isSettingsTab } from "@/store/tabStore.js";
import { getRenderableTaskUsage, type ContextUsageTaskUsage } from "./usageFormatting.js";

export interface UseContextUsagePanelConfigOptions {
  codingPlanUsageRemaining?: ChatCodingPlanUsageRemainingConfig;
  startPlanBalance?: ChatStartPlanBalanceConfig;
  taskUsage: ContextUsageTaskUsage | null;
}

/** 面板外壳状态：hover/touch 开关、静默 access 刷新、重置弹框存活期与两段配置的关闭包装。 */
export function useContextUsagePanelConfig({
  codingPlanUsageRemaining,
  startPlanBalance,
  taskUsage,
}: UseContextUsagePanelConfigOptions) {
  const isWorkspaceVisible = useOptionalTabStore(
    (state) => !state.tabs.some((tab) => tab.id === state.activeTabId && isSettingsTab(tab)),
  );
  const [contextOpen, setContextOpen] = useState(false);
  const [contextAccessRefreshing, setContextAccessRefreshing] = useState(false);
  const [quotaResetDialogOpen, setQuotaResetDialogOpen] = useState(false);
  const quotaResetDialogOpenRef = useRef(false);
  const contextUsageTriggerRef = useRef<HTMLElement | null>(null);
  const contextAccessRefreshSeqRef = useRef(0);
  const handleContextOpenChange = useCallback(
    (open: boolean) => {
      // Dialog 打开后会把焦点移出 HoverCard，Radix 随即请求关闭 HoverCard；
      // 若此时卸载内容，Portal 中的重置弹框也会一起消失，因此弹框存活期间必须拒绝关闭。
      if (!open && quotaResetDialogOpenRef.current) {
        return;
      }
      setContextOpen(open);
      // hover 刷新入口不能只认 Coding Plan 的 onAccess：Start Plan（今日余额）与
      // Coding Plan 连接方式互斥，start plan 用户 hover 时整条刷新链路都不触发，余额只能被动等
      // 设置页/侧栏刷新。改为两段配置任一提供 onAccess 即发起本次静默 access 刷新（互斥下实际只有一个存在）。
      const accessRefresh = codingPlanUsageRemaining?.onAccess ?? startPlanBalance?.onAccess;
      if (!open || !accessRefresh) {
        return;
      }
      // silent access refresh 有缓存快照时不会把 entitlement.loading 置 true。
      // header 的刷新图标必须跟随本次 hover 触发的远端 promise，而不是只看快照 loading。
      const refreshSeq = contextAccessRefreshSeqRef.current + 1;
      contextAccessRefreshSeqRef.current = refreshSeq;
      setContextAccessRefreshing(true);
      Promise.resolve(accessRefresh()).finally(() => {
        if (contextAccessRefreshSeqRef.current === refreshSeq) {
          setContextAccessRefreshing(false);
        }
      });
    },
    [codingPlanUsageRemaining?.onAccess, startPlanBalance?.onAccess],
  );
  const handleQuotaResetDialogOpenChange = useCallback((open: boolean) => {
    quotaResetDialogOpenRef.current = open;
    setQuotaResetDialogOpen(open);
    if (!open) {
      setContextOpen(false);
    }
  }, []);
  const renderableTaskUsage = getRenderableTaskUsage(taskUsage);
  const codingPlanUsageRemainingWithClose = useMemo<
    ChatCodingPlanUsageRemainingConfig | undefined
  >(() => {
    if (!codingPlanUsageRemaining) {
      return undefined;
    }
    const base = {
      ...codingPlanUsageRemaining,
      refreshing: contextAccessRefreshing || codingPlanUsageRemaining.refreshing === true,
    };
    if (!codingPlanUsageRemaining.onUsageClick) {
      return base;
    }

    return {
      ...base,
      onUsageClick: () =>
        runContextPanelActionWithClose({
          action: codingPlanUsageRemaining.onUsageClick,
          close: () => setContextOpen(false),
        }),
    };
  }, [codingPlanUsageRemaining, contextAccessRefreshing]);
  const startPlanBalanceWithClose = useMemo<ChatStartPlanBalanceConfig | undefined>(() => {
    if (!startPlanBalance) {
      return undefined;
    }
    const base: ChatStartPlanBalanceConfig = {
      ...startPlanBalance,
      // 静默 access 刷新不置 entitlement.loading，今日余额标题旁 spinner 需要跟随
      // 本次 hover 触发的 promise（contextAccessRefreshing），语义对齐 Coding Plan 段的 refreshing。
      refreshing: contextAccessRefreshing || startPlanBalance.refreshing === true,
    };
    if (!startPlanBalance.onUpgradeClick) {
      return base;
    }

    return {
      ...base,
      onUpgradeClick: () => {
        // HoverCard 内按钮点击不会像外部 hover leave 一样自动关闭面板。
        // 升级入口会切到设置页，必须先收起 context 面板，避免旧浮层残留在新页面上。
        setContextOpen(false);
        startPlanBalance.onUpgradeClick?.();
      },
    };
  }, [startPlanBalance, contextAccessRefreshing]);
  const hasCodingPlanUsageRemaining = codingPlanUsageRemainingWithClose
    ? hasChatCodingPlanUsageRemaining(codingPlanUsageRemainingWithClose)
    : false;
  const hasStartPlanBalance = hasChatStartPlanBalance(startPlanBalanceWithClose);

  return {
    codingPlanUsageRemainingWithClose,
    contextOpen,
    contextUsageTriggerRef,
    handleContextOpenChange,
    handleQuotaResetDialogOpenChange,
    hasCodingPlanUsageRemaining,
    hasStartPlanBalance,
    isWorkspaceVisible,
    quotaResetDialogOpen,
    renderableTaskUsage,
    startPlanBalanceWithClose,
  };
}
