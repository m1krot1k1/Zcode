import { useEffect } from "react";
import {
  APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL,
  appRuntimePreferencesChangedBroadcastPayloadSchema,
  type AppSettings,
} from "@zcode/shared";
import type { IServiceAccessor } from "./contract.ts";
import {
  CODE_COMMENT_PREVIEW_RESTORE_BROADCAST_CHANNEL,
  CODE_COMMENT_REMOVE_BROADCAST_CHANNEL,
  isCodeCommentPayload,
  isCodeCommentRemovePayload,
  markCodeCommentRemoved,
} from "@/lib/codeCommentContext.js";
import { logger } from "@/logger.js";
import { useCodeCommentPreviewStore } from "@/store/codeCommentPreviewStore.js";
/**
 * 运行时偏好的跨窗口同步。
 *
 * 两个订阅点必须保持在同一生命周期：广播处理负责跨窗口回放，初始化 effect 负责把
 * 本窗口已落盘的设置推给 CLI Host，避免新开窗口的 Host 停留在旧默认值。
 */
export function useRootRuntimePreferencesSync({
  services,
  refreshAppSettings,
  appSettings,
}: {
  services: IServiceAccessor;
  refreshAppSettings: () => Promise<void>;
  appSettings: AppSettings | null;
}) {
  useEffect(() => {
    const disposable = services.broadcastService.onMessage((message) => {
      if (message.channel === APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL) {
        const parsed = appRuntimePreferencesChangedBroadcastPayloadSchema.safeParse(
          message.payload,
        );
        if (!parsed.success) {
          logger.warn("[settings] 丢弃无效的运行时偏好广播", {
            issues: parsed.error.issues,
          });
          return;
        }
        void refreshAppSettings();
        void services.zcodeAgentService.syncAppRuntimePreferences(parsed.data).catch((error) => {
          logger.warn("[settings] 同步跨窗口运行时偏好失败", error);
        });
        void services.botsService.syncAppRuntimePreferences(parsed.data).catch((error) => {
          logger.warn("[settings] 同步跨窗口 Bot 运行时偏好失败", error);
        });
        return;
      }

      if (message.channel === CODE_COMMENT_PREVIEW_RESTORE_BROADCAST_CHANNEL) {
        if (!isCodeCommentPayload(message.payload) || !message.payload.id) {
          return;
        }
        useCodeCommentPreviewStore.getState().restoreCommentFromAttachment({
          ...message.payload,
          id: message.payload.id,
        });
        return;
      }

      if (message.channel !== CODE_COMMENT_REMOVE_BROADCAST_CHANNEL) {
        return;
      }

      if (!isCodeCommentRemovePayload(message.payload)) {
        return;
      }

      // 关闭文件 tab 后 PreviewPane 会卸载，不能再依赖 PreviewPane 自己监听跨窗口清理事件。
      // 这里在 Root 生命周期内同步清理 renderer 级 preview store，避免发送后重新打开文件又恢复旧 comment。
      markCodeCommentRemoved(message.payload);
      useCodeCommentPreviewStore.getState().removeCommentBySource(message.payload);
    });

    return () => {
      disposable.dispose();
    };
  }, [
    refreshAppSettings,
    services.botsService,
    services.broadcastService,
    services.zcodeAgentService,
  ]);

  useEffect(() => {
    if (!appSettings) {
      return;
    }
    void services.zcodeAgentService
      .syncAppRuntimePreferences({
        askUserQuestionAutoResolutionEnabled:
          appSettings.askUserQuestionAutoResolutionEnabled !== false,
        modelIoFullRetentionEnabled: appSettings.modelIoFullRetentionEnabled === true,
      })
      .catch((error) => {
        logger.warn("[settings] 初始化运行时偏好失败", error);
      });
    void services.botsService
      .syncAppRuntimePreferences({
        askUserQuestionAutoResolutionEnabled:
          appSettings.askUserQuestionAutoResolutionEnabled !== false,
        modelIoFullRetentionEnabled: appSettings.modelIoFullRetentionEnabled === true,
      })
      .catch((error) => {
        logger.warn("[settings] 初始化 Bot 运行时偏好失败", error);
      });
  }, [
    appSettings?.askUserQuestionAutoResolutionEnabled,
    appSettings?.modelIoFullRetentionEnabled,
    services.botsService,
    services.zcodeAgentService,
  ]);
}
