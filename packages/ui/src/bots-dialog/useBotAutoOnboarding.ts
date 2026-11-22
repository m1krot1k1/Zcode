/**
 * Bot 自动接入编排：没有凭据时自动出二维码，有凭据但未绑定时自动出 /bind。
 *
 * 自动流程只触发一次：去重键存在 ref 里，移除凭据时通过 forgetAutoOnboarding
 * 清掉，避免重复创建二维码或绑定码。
 */
import { useCallback, useEffect, useRef } from "react";
import type { BotConfig } from "@zcode/shared";
import { isFeishuBotProvider } from "@zcode/shared";
import type {
  BindCodeState,
  FeishuRegistrationState,
  WeixinRegistrationState,
} from "@/BotsDialog/shared.js";

export function useBotAutoOnboarding({
  open,
  creatingBot,
  selectedBot,
  bindCode,
  bindExpired,
  createBindCodeForBot,
  feishuRegistration,
  feishuRegistrationLoading,
  handleStartFeishuRegistration,
  weixinRegistration,
  weixinRegistrationLoading,
  handleStartWeixinRegistration,
}: {
  open: boolean;
  creatingBot: boolean;
  selectedBot: BotConfig | null;
  bindCode: BindCodeState | null;
  bindExpired: boolean;
  createBindCodeForBot: (bot: BotConfig) => Promise<void>;
  feishuRegistration: FeishuRegistrationState | null;
  feishuRegistrationLoading: boolean;
  handleStartFeishuRegistration: () => Promise<void>;
  weixinRegistration: WeixinRegistrationState | null;
  weixinRegistrationLoading: boolean;
  handleStartWeixinRegistration: () => Promise<void>;
}) {
  const autoQrStartedBotIdsRef = useRef(new Set<string>());
  const autoBindCreatingBotIdsRef = useRef(new Set<string>());

  const forgetAutoOnboarding = useCallback((botId: string) => {
    autoQrStartedBotIdsRef.current.delete(`${botId}:feishu-registration`);
    autoQrStartedBotIdsRef.current.delete(`${botId}:weixin-registration`);
    autoBindCreatingBotIdsRef.current.delete(botId);
  }, []);

  useEffect(() => {
    if (!open || creatingBot || !selectedBot) {
      return;
    }

    if (isFeishuBotProvider(selectedBot.provider)) {
      if (!selectedBot.credentialRef) {
        if (feishuRegistrationLoading) {
          return;
        }
        if (feishuRegistration?.botId === selectedBot.id) {
          return;
        }

        const autoKey = `${selectedBot.id}:feishu-registration`;
        if (autoQrStartedBotIdsRef.current.has(autoKey)) {
          return;
        }

        // Bugfix: 未配置 token 的飞书/Lark Bot 首次进入详情时只显示“扫码”按钮，
        // 用户会误以为还需要额外展开；自动启动一次二维码流程，让缺失凭据的默认状态直接可操作。
        autoQrStartedBotIdsRef.current.add(autoKey);
        void handleStartFeishuRegistration();
        return;
      }

      if (!selectedBot.providerUserId) {
        if (bindCode?.botId === selectedBot.id && !bindExpired) {
          return;
        }
        if (autoBindCreatingBotIdsRef.current.has(selectedBot.id)) {
          return;
        }

        // Bugfix: 飞书/Lark 的接入凭据和聊天绑定是两个阶段；已有凭据但未绑定时需要自动展示 /bind。
        // 绑定码现在只有 30 秒有效期，过期后如果还停在旧码会打断自动绑定流程；这里自动续一枚新码。
        autoBindCreatingBotIdsRef.current.add(selectedBot.id);
        void createBindCodeForBot(selectedBot).finally(() => {
          autoBindCreatingBotIdsRef.current.delete(selectedBot.id);
        });
      }
      return;
    }

    if (selectedBot.provider === "telegram") {
      if (!selectedBot.credentialRef || selectedBot.providerUserId) {
        return;
      }
      if (bindCode?.botId === selectedBot.id && !bindExpired) {
        return;
      }
      if (autoBindCreatingBotIdsRef.current.has(selectedBot.id)) {
        return;
      }

      // Bugfix: Telegram 和飞书/Lark 一样分成凭据接入与私聊绑定两步；
      // token 保存后自动展示 /bind；绑定码过期也自动续码，避免 30 秒有效期让用户卡在旧码上。
      autoBindCreatingBotIdsRef.current.add(selectedBot.id);
      void createBindCodeForBot(selectedBot).finally(() => {
        autoBindCreatingBotIdsRef.current.delete(selectedBot.id);
      });
      return;
    }

    if (selectedBot.provider !== "weixin") {
      return;
    }
    if (selectedBot.credentialRef || weixinRegistrationLoading) {
      return;
    }
    if (weixinRegistration?.botId === selectedBot.id) {
      return;
    }

    const autoKey = `${selectedBot.id}:weixin-registration`;
    if (autoQrStartedBotIdsRef.current.has(autoKey)) {
      return;
    }

    // Bugfix: 微信 Bot 没有 token/绑定状态时需要立即给出登录二维码，
    // 否则新建后右侧默认只露出按钮，和“扫码接入”的主流程不一致。
    autoQrStartedBotIdsRef.current.add(autoKey);
    void handleStartWeixinRegistration();
  }, [
    creatingBot,
    feishuRegistration,
    feishuRegistrationLoading,
    bindCode,
    bindExpired,
    createBindCodeForBot,
    handleStartFeishuRegistration,
    handleStartWeixinRegistration,
    open,
    selectedBot,
    weixinRegistration,
    weixinRegistrationLoading,
  ]);

  return { forgetAutoOnboarding };
}
