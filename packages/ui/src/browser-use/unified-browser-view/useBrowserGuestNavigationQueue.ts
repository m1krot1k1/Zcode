import { useCallback, useEffect, useMemo, useRef } from "react";
import type {
  PendingGuestNavigationCompletion,
  ReportedBrowserGuest,
} from "@/browser-use/unified-browser-view/types.js";
import { DEFAULT_BROWSER_URL } from "@/embeddedBrowserHelpers.js";
import { logger } from "@/logger.js";

export type BrowserGuestTeardownProbe = {
  browserKey: string;
  generation: number;
  hasNavigated: boolean;
  hadWebview: boolean;
};

export type BrowserGuestNavigationRefs = {
  /** dom-ready 前排队的导航 URL；webview 就绪后统一 loadURL。 */
  pendingUrlRef: React.RefObject<string | null>;
  lastRequestedUrlRef: React.RefObject<string | null>;
  lastAppliedInitialUrlRef: React.RefObject<string | null>;
  lastHandledNavigationRequestIdRef: React.RefObject<string | null>;
  lastRestorableUrlRef: React.RefObject<string | null>;
  guestRecoveryInProgressRef: React.RefObject<boolean>;
  pendingGuestNavigationCompletionRef: React.RefObject<PendingGuestNavigationCompletion | null>;
  lastReportedGuestRef: React.RefObject<ReportedBrowserGuest | null>;
  wasResponsiveModeRef: React.RefObject<boolean>;
  webviewTeardownProbeRef: React.RefObject<BrowserGuestTeardownProbe>;
};

type BrowserGuestNavigationQueueParams = {
  browserKey: string;
  initialUrl?: string | null;
  webviewGeneration: number;
  hasInitialNavigation: boolean;
  hasNavigated: boolean;
  onPageMetadataChange?: (metadata: {
    title?: string;
    faviconUrl?: string | null;
  }) => void;
  onUrlChange?: (url: string) => void;
};

export type BrowserGuestNavigationQueue = {
  refs: BrowserGuestNavigationRefs;
  lastReportedGuestRef: React.RefObject<ReportedBrowserGuest | null>;
  onPageMetadataChangeRef: React.RefObject<
    | ((metadata: { title?: string; faviconUrl?: string | null }) => void)
    | undefined
  >;
  onUrlChangeRef: React.RefObject<((url: string) => void) | undefined>;
  logWebviewTeardown: (trigger: string) => void;
  completePendingGuestNavigation: (
    completion?: PendingGuestNavigationCompletion | null,
  ) => void;
  waitForGuestNavigationTakeover: (url: string) => Promise<void>;
};

/**
 * guest 导航排队与销毁归因：排队 URL、外部导航回执和被替换 guest 的拆除探针。
 */
export function useBrowserGuestNavigationQueue({
  browserKey,
  initialUrl,
  webviewGeneration,
  hasInitialNavigation,
  hasNavigated,
  onPageMetadataChange,
  onUrlChange,
}: BrowserGuestNavigationQueueParams): BrowserGuestNavigationQueue {
  // dom-ready 前排队的导航 URL；webview 就绪后统一 loadURL（<webview> 的 src 只在首挂生效）。
  const pendingUrlRef = useRef<string | null>(null);
  const lastRequestedUrlRef = useRef<string | null>(null);
  // 已消费的 initialUrl / navigationRequest，避免重复导航。
  const lastAppliedInitialUrlRef = useRef<string | null>(null);
  const lastHandledNavigationRequestIdRef = useRef<string | null>(null);
  const lastRestorableUrlRef = useRef<string | null>(
    initialUrl && initialUrl !== DEFAULT_BROWSER_URL ? initialUrl : null,
  );
  const guestRecoveryInProgressRef = useRef(false);
  // 失败 guest 接到外部导航时，回执必须等替代 guest 实际接管 loadURL 后再完成。
  const pendingGuestNavigationCompletionRef =
    useRef<PendingGuestNavigationCompletion | null>(null);
  // guestId 上报去重：did-attach 与 dom-ready 会连续触发；只有 guest 或 active 状态变化才重报。
  const lastReportedGuestRef = useRef<ReportedBrowserGuest | null>(null);
  const wasResponsiveModeRef = useRef(false);
  // guest 销毁归因打点：线上主进程 UAF（EXC_BAD_ACCESS at
  // 0x10，DevToolsSession 在途通知访问已析构 client）发生前，main 日志只能看到
  // 「cdp still attached on destroyed guest」，无法区分 webview 节点是被谁卸载的：
  // residency 挂起换壳 / 父级整树卸载 / shouldMountWebview 条件翻转 / generation 换代。
  // ref(null) 是 React 卸载 <webview> 节点的第一现场；配合组件卸载打点与挂起壳 ack 日志，
  // 可把销毁者与时序钉死。仅在 webview 实际存在过后才打，量级与 tab 生命周期一致。
  const webviewTeardownProbeRef = useRef<BrowserGuestTeardownProbe>({
    browserKey: "",
    generation: 0,
    hasNavigated: hasInitialNavigation,
    hadWebview: false,
  });
  webviewTeardownProbeRef.current.browserKey = browserKey;
  webviewTeardownProbeRef.current.generation = webviewGeneration;
  webviewTeardownProbeRef.current.hasNavigated = hasNavigated;
  const logWebviewTeardown = useCallback((trigger: string) => {
    const probe = webviewTeardownProbeRef.current;
    logger.info("[browser-use] webview 节点离开 DOM（guest 将被销毁）", {
      browserKey: probe.browserKey,
      generation: probe.generation,
      guestReported: lastReportedGuestRef.current,
      hasNavigated: probe.hasNavigated,
      trigger,
    });
  }, []);
  const onPageMetadataChangeRef = useRef(onPageMetadataChange);
  onPageMetadataChangeRef.current = onPageMetadataChange;
  const onUrlChangeRef = useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;

  const completePendingGuestNavigation = useCallback(
    (completion?: PendingGuestNavigationCompletion | null) => {
      const pendingCompletion =
        completion === undefined
          ? pendingGuestNavigationCompletionRef.current
          : completion;
      if (
        !pendingCompletion ||
        pendingGuestNavigationCompletionRef.current !== pendingCompletion
      ) {
        return;
      }
      pendingGuestNavigationCompletionRef.current = null;
      pendingCompletion.resolve();
    },
    [],
  );

  const waitForGuestNavigationTakeover = useCallback((url: string) => {
    // 同一个 view 同时只保留一个外部导航意图；若未来入口允许并发，新请求明确取代旧请求，
    // 先结束旧回执，避免被覆盖的 Promise 永久悬空。
    const replacedCompletion = pendingGuestNavigationCompletionRef.current;
    pendingGuestNavigationCompletionRef.current = null;
    replacedCompletion?.resolve();
    return new Promise<void>((resolve) => {
      pendingGuestNavigationCompletionRef.current = { resolve, url };
    });
  }, []);

  useEffect(
    () => () => {
      // view 被关闭时属于明确取消，不能让上层 navigationRequest 永久等待。
      completePendingGuestNavigation();
    },
    [completePendingGuestNavigation],
  );

  useEffect(
    () => () => {
      // 组件卸载意味着 <webview> 必然离开 DOM：residency 挂起换壳 / 父级面板关闭 /
      // 会话切换整树重挂。与 ref-null 打点的时间差可用于区分「换代重建」与「真卸载」。
      if (
        webviewTeardownProbeRef.current.hadWebview ||
        lastReportedGuestRef.current
      ) {
        webviewTeardownProbeRef.current.hadWebview = false;
        logWebviewTeardown("component-unmount");
      }
    },
    [logWebviewTeardown],
  );

  const refs = useMemo<BrowserGuestNavigationRefs>(
    () => ({
      pendingUrlRef,
      lastRequestedUrlRef,
      lastAppliedInitialUrlRef,
      lastHandledNavigationRequestIdRef,
      lastRestorableUrlRef,
      guestRecoveryInProgressRef,
      pendingGuestNavigationCompletionRef,
      lastReportedGuestRef,
      wasResponsiveModeRef,
      webviewTeardownProbeRef,
    }),
    // 所有成员都是 useRef 的稳定句柄，只在挂载时组装一次。
    [],
  );

  return {
    refs,
    lastReportedGuestRef,
    onPageMetadataChangeRef,
    onUrlChangeRef,
    logWebviewTeardown,
    completePendingGuestNavigation,
    waitForGuestNavigationTakeover,
  };
}
