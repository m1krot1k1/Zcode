import { useEffect } from "react";
import type { IPlatformService } from "@zcode/shared";
import type { IServiceAccessor } from "./contract.ts";
import {
  useDynamicWorkflowAvailabilityLoader,
  useDynamicWorkflowUserModeSync,
} from "@/hooks/useDynamicWorkflowAvailability.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { setSessionOpenArmsReporter } from "@/lib/sessionOpenArmsTelemetry.js";
import { setSendFunnelArmsReporter } from "@/lib/sendFunnelArmsTelemetry.js";
import { setUiPerfArmsReporter } from "@/lib/uiPerfArmsTelemetry.js";
import { setRequestSecurityReporter } from "@/request-security-edition/index.js";
import { useSourceServerUpdateNotifications } from "@/root/sourceServerUpdateNotifications.js";
import { setMcpStorePlatform } from "@/store/mcpStore.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { disposeConversationTelemetrySupervisors } from "@/v4/telemetry/ConversationTelemetryAttachment.js";
import { installConversationTelemetryParityE2EBridge } from "@/v4/telemetry/conversationTelemetryParityE2E.js";
import { useWebRemoteControlAuthSync } from "@/web-remote-control/app/useWebRemoteControlAuthSync.js";

/**
 * Root 的应用级接线：平台 reporter、对话遥测、动态工作流灰度快照、账号/设置状态与 Web 远控鉴权。
 *
 * 声明顺序即历史执行顺序：reporter 注册 → 遥测桥接 → 工作流快照取数 → 设置与账号状态。
 */
export function useRootAppWiring({
  services,
  platform,
  isDesktop,
}: {
  services: IServiceAccessor;
  platform: IPlatformService;
  isDesktop?: boolean;
}) {
  useEffect(() => {
    setRequestSecurityReporter(platform);
    setMcpStorePlatform(platform);
    // 对话 UI perf 只属于 desktop-continuous；Web/mobile 即使能看到权威状态也不装 reporter。
    setUiPerfArmsReporter(isDesktop ? platform : null);
    setSessionOpenArmsReporter(isDesktop ? platform : null);
    // 发送漏斗同理：只在 Electron 桌面端上报，Web/mobile 的 reportArmsCustomEvent 是空实现。
    setSendFunnelArmsReporter(isDesktop ? platform : null);
    return () => {
      setRequestSecurityReporter(null);
      setMcpStorePlatform(null);
      setUiPerfArmsReporter(null);
      setSessionOpenArmsReporter(null);
      setSendFunnelArmsReporter(null);
    };
  }, [isDesktop, platform]);

  useEffect(
    () =>
      installConversationTelemetryParityE2EBridge({
        platform,
        isDesktop: isDesktop === true,
      }),
    [isDesktop, platform],
  );

  useEffect(
    () => () => {
      disposeConversationTelemetrySupervisors();
    },
    [],
  );

  // 动态工作流灰度快照的唯一取数点：
  // 放在 app 级 ServiceProvider 这一层取一次，自动化页与 run 面板只读。消费方可能位于
  // 工作区级 ServiceProvider 内（远程 Host 的 accessor），由它们取数会拿到另一台 Host 的答案。
  useDynamicWorkflowAvailabilityLoader(services.codingPlanSubscriptionService);

  const { intl, locale } = useZCodeIntl();
  const handleRemoteConnectionTargetChange = useSourceServerUpdateNotifications({
    enabled: isDesktop === true,
    management: services.sourceServerManagementService,
  });
  const theme = useZCodeStore((state) => state.theme);
  const user = useZCodeStore((state) => state.user);
  const isRestoringOAuthSession = useZCodeStore((state) => state.isRestoringOAuthSession);
  useWebRemoteControlAuthSync(platform, services.oauthService, user?.id, isRestoringOAuthSession);
  const setUser = useZCodeStore((state) => state.setUser);
  const setIsRestoringOAuthSession = useZCodeStore((state) => state.setIsRestoringOAuthSession);
  const setOAuthError = useZCodeStore((state) => state.setOAuthError);
  const oauthPollingActive = useZCodeStore((state) => state.oauthPollingActive);
  const setOAuthPollingActive = useZCodeStore((state) => state.setOAuthPollingActive);
  const markOAuthSuccess = useZCodeStore((state) => state.markOAuthSuccess);
  const {
    settings: appSettings,
    refresh: refreshAppSettings,
    update: updateAppSettings,
  } = useSettings();
  // docs/dynamic-workflow/launch.md「The user's choice」：设置里的动态工作流选择变化后，通知本窗口
  // 的 Host 重发 CLI 策略（并转发给远程 Host），再重读灰度快照。
  useDynamicWorkflowUserModeSync({
    settingsLoaded: Boolean(appSettings),
    userMode: appSettings?.dynamicWorkflowMode,
    zcodeAgentService: services.zcodeAgentService,
    codingPlanSubscriptionService: services.codingPlanSubscriptionService,
  });

  return {
    intl,
    locale,
    handleRemoteConnectionTargetChange,
    theme,
    user,
    isRestoringOAuthSession,
    setUser,
    setIsRestoringOAuthSession,
    setOAuthError,
    oauthPollingActive,
    setOAuthPollingActive,
    markOAuthSuccess,
    appSettings,
    refreshAppSettings,
    updateAppSettings,
  };
}
