import { useEffect, useRef } from "react";
import { readRendererLaunchTimings, shouldReportLaunchToInput } from "@/lib/launchToInputReport.js";
import { reportUiLaunchToInput } from "@/lib/uiPerfArmsTelemetry.js";

/**
 * 启动到可输入的 UI perf 上报。
 *
 * 只在首屏门禁解除且没有登录页遮挡时上报一次；锚点缺失（非桌面/未注入 marks）整批跳过。
 */
export function useRootLaunchToInputReport({
  isStartupRenderBlocked,
  welcomeScreenOpen,
}: {
  isStartupRenderBlocked: boolean;
  welcomeScreenOpen: boolean;
}) {
  const launchReportedRef = useRef(false);

  useEffect(() => {
    if (
      !shouldReportLaunchToInput({
        isStartupRenderBlocked,
        welcomeScreenOpen,
        alreadyReported: launchReportedRef.current,
      })
    ) {
      return;
    }
    launchReportedRef.current = true;
    const timings = readRendererLaunchTimings();
    if (!timings || !timings.marks) {
      return; // 锚点缺失(非桌面/未注入 marks),整批跳过
    }
    reportUiLaunchToInput({
      marks: timings.marks,
      rendererStart: timings.rendererStart,
      reactCommit: timings.reactCommit,
      inputReady: Date.now(), // T6
      sessionId: `launch-${timings.marks.createdAt}`,
    });
  }, [isStartupRenderBlocked, welcomeScreenOpen]);
}
