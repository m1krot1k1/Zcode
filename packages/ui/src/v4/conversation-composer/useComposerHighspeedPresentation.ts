import { useCallback, useEffect, useState } from "react";
import { useHighspeedComposerEntrance } from "@/highspeed/useHighspeedComposerEntrance.js";
import type { HighspeedCardSnapshot } from "@zcode/shared";

/**
 * Highspeed 卡片的入场 / 扫光呈现状态。
 *
 * 只有在 draw 新命中的激活交接后才播放扫光；恢复入场（切回 Task、快照恢复、
 * 重挂载）直接呈现模型与倒计时，不重播动效。
 */
export interface ComposerHighspeedPresentationInput {
  highspeedCard: HighspeedCardSnapshot | null;
  highspeedActivationCardId: string | null;
  onHighspeedActivationApplied: ((cardId: string) => void) | undefined;
}

export function useComposerHighspeedPresentation({
  highspeedCard,
  highspeedActivationCardId,
  onHighspeedActivationApplied,
}: ComposerHighspeedPresentationInput) {
  const [presentedHighspeedCardId, setPresentedHighspeedCardId] = useState<string | null>(null);
  const [highspeedSweepActive, setHighspeedSweepActive] = useState(false);
  const highspeedCardId = highspeedCard?.cardId ?? null;
  const highspeedEntrance = useHighspeedComposerEntrance({
    cardId: highspeedCardId,
    activationCardId: highspeedActivationCardId,
    onActivationApplied: onHighspeedActivationApplied,
  });
  const highspeedEntranceAnimated = highspeedEntrance === "activation";
  // 恢复入场（切回 Task、快照恢复、重挂载）不经扩散交接，卡片出现即呈现模型与倒计时。
  const highspeedPresented =
    highspeedCardId !== null &&
    (!highspeedEntranceAnimated || presentedHighspeedCardId === highspeedCardId);
  const handleHighspeedModelTransitionStart = useCallback(() => {
    // 只记录已完成视觉交接的卡片身份，不改变卡片有效性或发送状态。
    setPresentedHighspeedCardId(highspeedCardId);
  }, [highspeedCardId]);
  useEffect(() => {
    // 扫光属于激活动效，只在 draw 新命中的交接后播放一次。
    if (!highspeedPresented || !highspeedEntranceAnimated) {
      setHighspeedSweepActive(false);
      return;
    }
    const timer = window.setTimeout(() => setHighspeedSweepActive(true), 1_900);
    return () => window.clearTimeout(timer);
  }, [highspeedEntranceAnimated, highspeedPresented]);

  return {
    handleHighspeedModelTransitionStart,
    highspeedEntrance,
    highspeedEntranceAnimated,
    highspeedPresented,
    highspeedSweepActive,
  };
}
