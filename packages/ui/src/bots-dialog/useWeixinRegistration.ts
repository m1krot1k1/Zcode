/**
 * 微信 Bot 扫码登录与激活状态轮询。
 *
 * 扫码接口会长等待，轮询必须串行；扫码成功后清掉临时二维码状态，
 * 后续展示由凭据/绑定态决定。
 */
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import QRCode from "qrcode";
import type { BotConfig, BotState } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { WeixinRegistrationState } from "@/BotsDialog/shared.js";
import type { BotsService, SaveBot } from "./types.js";

const ACTIVATION_POLL_INTERVAL_MS = 2000;

export function useWeixinRegistration({
  open,
  botsService,
  selectedBot,
  selectedBotId,
  selectedBotState,
  setBotStates,
  saveBot,
}: {
  open: boolean;
  botsService: BotsService;
  selectedBot: BotConfig | null;
  selectedBotId: string | null;
  selectedBotState: BotState | null;
  setBotStates: Dispatch<SetStateAction<BotState[]>>;
  saveBot: SaveBot;
}) {
  const { intl } = useZCodeIntl();
  const [weixinRegistration, setWeixinRegistration] = useState<WeixinRegistrationState | null>(
    null,
  );
  const [weixinRegistrationLoading, setWeixinRegistrationLoading] = useState(false);

  useEffect(() => {
    setWeixinRegistration(null);
  }, [selectedBotId, selectedBot?.provider]);

  useEffect(() => {
    if (
      !open ||
      selectedBot?.provider !== "weixin" ||
      !selectedBot.credentialRef ||
      selectedBotState?.weixinActivatedAt
    ) {
      return undefined;
    }
    let cancelled = false;
    const pollActivationState = async () => {
      try {
        const nextBotStates = await botsService.getBotStates();
        if (!cancelled) {
          setBotStates(nextBotStates);
        }
      } catch (error) {
        logger.warn(
          "[BotsDialog] 轮询微信 Bot 激活状态失败",
          error instanceof Error ? error.message : String(error),
        );
      }
    };
    const timer = window.setInterval(() => {
      void pollActivationState();
    }, ACTIVATION_POLL_INTERVAL_MS);
    void pollActivationState();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    botsService,
    open,
    selectedBot?.credentialRef,
    selectedBot?.id,
    selectedBot?.provider,
    selectedBotState?.weixinActivatedAt,
    setBotStates,
  ]);

  useEffect(() => {
    const registration = weixinRegistration;
    if (!open || !selectedBot || selectedBot.provider !== "weixin" || !registration) {
      return undefined;
    }
    if (registration.status !== "pending" && registration.status !== "scanned") {
      return undefined;
    }

    let cancelled = false;
    let timer: number | undefined;
    const pollIntervalMs = Math.max(1, registration.interval) * 1000;

    const scheduleNextPoll = () => {
      if (cancelled) {
        return;
      }
      timer = window.setTimeout(() => {
        void runPoll();
      }, pollIntervalMs);
    };

    const pollRegistration = async () => {
      try {
        const result = await botsService.pollWeixinRegistration({
          qrCode: registration.qrCode,
        });
        if (cancelled) {
          return;
        }
        if (result.status === "pending" || result.status === "scanned") {
          setWeixinRegistration((current) => {
            if (current?.qrCode !== registration.qrCode) {
              return current;
            }
            if (current.interval === result.interval && current.status === result.status) {
              return current;
            }
            return {
              ...current,
              interval: result.interval,
              status: result.status,
            };
          });
          return;
        }
        if (result.status === "success") {
          await saveBot(
            {
              ...selectedBot,
              webhookUrl: undefined,
              providerUserId: result.botId ?? selectedBot.providerUserId,
              displayName: result.botId ?? selectedBot.displayName,
              name: selectedBot.name,
            },
            { credentialValue: result.botToken },
          );
          if (!cancelled) {
            // Bugfix: 微信扫码成功即完成连接，保留 QR registration 会让用户看到过期的扫码区域。
            // 清掉临时状态后，Bot token 行会切到已连通的 Unbind 操作。
            setWeixinRegistration(null);
            toast(intl.formatMessage({ id: "bots.weixinRegistrationSuccess" }));
          }
          cancelled = true;
          return;
        }
        setWeixinRegistration((current) =>
          current?.qrCode === registration.qrCode
            ? {
                ...current,
                status: result.status,
                message:
                  ("message" in result ? result.message : undefined) ??
                  intl.formatMessage({
                    id: `bots.weixinRegistration.${result.status}`,
                  }),
              }
            : current,
        );
        cancelled = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[BotsDialog] 微信扫码登录轮询失败", message);
      }
    };

    const runPoll = async () => {
      await pollRegistration();
      scheduleNextPoll();
    };

    // Bugfix: 微信扫码状态接口会长等待，如果用 setInterval 会在上一次请求未返回时继续堆叠 RPC。
    // 串行轮询可以避免连续 timeout，也避免多个结果互相覆盖 UI 状态。
    void runPoll();

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [botsService, intl, open, saveBot, selectedBot, weixinRegistration]);

  const handleStartWeixinRegistration = useCallback(async () => {
    if (!selectedBot || selectedBot.provider !== "weixin") return;
    setWeixinRegistrationLoading(true);
    try {
      const result = await botsService.beginWeixinRegistration();
      let qrDataUrl: string | null = null;
      try {
        qrDataUrl = await QRCode.toDataURL(result.qrUrl, {
          margin: 1,
          width: 220,
        });
      } catch (error) {
        logger.error(
          "[BotsDialog] 生成微信登录二维码失败",
          error instanceof Error ? error.message : String(error),
        );
      }
      setWeixinRegistration({
        botId: selectedBot.id,
        qrCode: result.qrCode,
        qrUrl: result.qrUrl,
        qrDataUrl,
        interval: result.interval,
        expiresAt: result.expiresAt,
        status: "pending",
      });
      toast(intl.formatMessage({ id: "bots.weixinRegistrationStarted" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] 启动微信扫码登录失败", message);
      toast(intl.formatMessage({ id: "bots.weixinRegistrationFailed" }, { error: message }));
    } finally {
      setWeixinRegistrationLoading(false);
    }
  }, [botsService, intl, selectedBot]);

  return {
    weixinRegistration,
    setWeixinRegistration,
    weixinRegistrationLoading,
    handleStartWeixinRegistration,
  };
}
