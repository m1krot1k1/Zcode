/**
 * 飞书/Lark 扫码注册：开始扫码、轮询设备码状态并在成功后写入凭据。
 *
 * 扫码只是凭据接入；聊天绑定由绑定码流程负责，成功时只收起二维码，
 * 避免二维码和 /bind 面板在同一次状态更新里抢展示优先级。
 */
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import QRCode from "qrcode";
import type { BotConfig, BotsConfigFile } from "@zcode/shared";
import { isFeishuBotProvider } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { FeishuRegistrationState } from "@/BotsDialog/shared.js";
import type { BotsService, SaveBot } from "./types.js";

export function useFeishuRegistration({
  open,
  botsService,
  selectedBot,
  selectedBotId,
  saveBot,
  setConfig,
}: {
  open: boolean;
  botsService: BotsService;
  selectedBot: BotConfig | null;
  selectedBotId: string | null;
  saveBot: SaveBot;
  setConfig: Dispatch<SetStateAction<BotsConfigFile>>;
}) {
  const { intl } = useZCodeIntl();
  const [feishuRegistration, setFeishuRegistration] = useState<FeishuRegistrationState | null>(
    null,
  );
  const [feishuRegistrationLoading, setFeishuRegistrationLoading] = useState(false);

  useEffect(() => {
    setFeishuRegistration(null);
  }, [selectedBotId, selectedBot?.provider]);

  useEffect(() => {
    const registration = feishuRegistration;
    if (!open || !selectedBot || !isFeishuBotProvider(selectedBot.provider) || !registration) {
      return undefined;
    }
    if (registration.status !== "pending") {
      return undefined;
    }

    let cancelled = false;
    const pollIntervalMs = Math.max(1, registration.interval) * 1000;

    const pollRegistration = async () => {
      try {
        const result = await botsService.pollFeishuRegistration({
          deviceCode: registration.deviceCode,
          domain: registration.domain,
          pollDomain: registration.pollDomain,
        });
        if (cancelled) {
          return;
        }
        if (result.status === "pending") {
          setFeishuRegistration((current) => {
            if (current?.deviceCode !== registration.deviceCode) {
              return current;
            }
            if (
              current.interval === result.interval &&
              current.domain === result.domain &&
              current.pollDomain === result.pollDomain
            ) {
              return current;
            }
            // Bugfix: pending 轮询结果通常不变；如果每次都创建新对象，会触发 effect 依赖变化，
            // 进而立即重启轮询并造成毫秒级 RPC 风暴。
            return {
              ...current,
              interval: result.interval,
              domain: result.domain,
              pollDomain: result.pollDomain,
            };
          });
          return;
        }
        if (result.status === "success") {
          // Bugfix: 服务层一直支持飞书扫码注册，但 Bots 重构后的 UI 只保留了手填凭据。
          // 扫码成功后直接复用 saveBot 的 secret 写入路径，避免把 App Secret 留在明文配置文件里。
          const savedBot = await saveBot(
            {
              ...selectedBot,
              provider: selectedBot.provider,
              name: result.appName?.trim() || selectedBot.name,
              feishuAppId: result.appId,
            },
            { credentialValue: result.appSecret },
          );
          if (!cancelled) {
            // Bugfix: 飞书/Lark 扫码成功只完成应用凭据接入；绑定码由“有凭据但未绑定”的统一状态机生成。
            // 这里仅收起二维码，避免二维码和 /bind 面板在一次状态更新里互相抢展示优先级。
            setConfig((previous) => ({
              ...previous,
              bots: previous.bots.map((bot) => (bot.id === savedBot.id ? savedBot : bot)),
            }));
            setFeishuRegistration(null);
            toast(intl.formatMessage({ id: "bots.feishuRegistrationSuccess" }));
          }
          return;
        }
        setFeishuRegistration((current) =>
          current?.deviceCode === registration.deviceCode
            ? {
                ...current,
                status: result.status,
                message:
                  result.message ??
                  intl.formatMessage({
                    id: `bots.feishuRegistration.${result.status}`,
                  }),
              }
            : current,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[BotsDialog] 飞书扫码注册轮询失败", message);
        if (!cancelled) {
          setFeishuRegistration((current) =>
            current?.deviceCode === registration.deviceCode
              ? { ...current, status: "error", message }
              : current,
          );
        }
      }
    };

    const timer = window.setInterval(() => {
      void pollRegistration();
    }, pollIntervalMs);
    void pollRegistration();

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [botsService, feishuRegistration, intl, open, saveBot, selectedBot, setConfig]);

  const handleStartFeishuRegistration = useCallback(async () => {
    if (!selectedBot || !isFeishuBotProvider(selectedBot.provider)) return;
    setFeishuRegistrationLoading(true);
    try {
      const result = await botsService.beginFeishuRegistration({
        domain: selectedBot.provider,
      });
      let qrDataUrl: string | null = null;
      try {
        qrDataUrl = await QRCode.toDataURL(result.qrUrl, {
          margin: 1,
          width: 220,
        });
      } catch (error) {
        logger.error(
          "[BotsDialog] 生成飞书注册二维码失败",
          error instanceof Error ? error.message : String(error),
        );
      }
      setFeishuRegistration({
        botId: selectedBot.id,
        deviceCode: result.deviceCode,
        qrUrl: result.qrUrl,
        qrDataUrl,
        userCode: result.userCode,
        interval: result.interval,
        expiresAt: result.expiresAt,
        domain: result.domain,
        pollDomain: result.pollDomain,
        status: "pending",
      });
      toast(intl.formatMessage({ id: "bots.feishuRegistrationStarted" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] 启动飞书扫码注册失败", message);
      toast(intl.formatMessage({ id: "bots.feishuRegistrationFailed" }, { error: message }));
    } finally {
      setFeishuRegistrationLoading(false);
    }
  }, [botsService, intl, selectedBot]);

  return {
    feishuRegistration,
    setFeishuRegistration,
    feishuRegistrationLoading,
    handleStartFeishuRegistration,
  };
}
