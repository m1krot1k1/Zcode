import { useCallback, useEffect } from "react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { ZCODE_PRODUCT_DOCS_URL } from "@/lib/productDocs.js";

/**
 * Внешние прикладные входы App: feedback host, community, документация продукта.
 * IPC-события feedback остаются совместимы с обоими старыми панелями.
 */
export function useAppRootFeedback({ isLoggedIn }: { isLoggedIn: boolean }) {
  const platform = usePlatform();
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const openFeedbackTickets = useFeedbackStore((state) => state.openTickets);

  useEffect(() => {
    // 内置反馈中心合并了"提交反馈 / 我的反馈"两个 Tab，
    // 老的 OpenTicketsPanel IPC 仍然兼容（直接打开列表），未来如果还需要单独入口可以复用。
    const disposeFeedbackDialog = platform.onOpenFeedbackDialog?.(() => {
      openFeedbackSubmit();
    });
    const disposeTicketsPanel = platform.onOpenTicketsPanel?.(() => {
      openFeedbackTickets();
    });
    return () => {
      disposeFeedbackDialog?.();
      disposeTicketsPanel?.();
    };
  }, [openFeedbackSubmit, openFeedbackTickets, platform]);

  const handleOpenFeedback = useCallback(() => {
    void platform.openFeedback();
  }, [platform]);
  const handleOpenCommunity = useCallback(() => platform.openCommunity(), [platform]);
  const handleOpenProductDocs = useCallback(() => {
    platform.openExternal(ZCODE_PRODUCT_DOCS_URL);
  }, [platform]);

  return {
    isLoggedIn,
    handleOpenFeedback,
    handleOpenCommunity,
    handleOpenProductDocs,
  };
}
