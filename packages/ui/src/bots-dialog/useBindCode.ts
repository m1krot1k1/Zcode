/**
 * /bind 绑定码：30 秒 TTL 的倒计时、绑定结果轮询和复制命令。
 *
 * 绑定码是 UI 临时事实，只在这里持有；绑定成功后配置里的 providerUserId
 * 才是服务端事实，因此轮询到回写后立即收起绑定码。
 */
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { BotConfig, BotsConfigFile } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { BIND_CODE_TTL_MS, type BindCodeState } from "@/BotsDialog/shared.js";
import type { BotsService } from "./types.js";

const BIND_POLL_INTERVAL_MS = 2000;
const BIND_TICK_INTERVAL_MS = 250;

export function useBindCode({
  open,
  botsService,
  selectedBot,
  setConfig,
}: {
  open: boolean;
  botsService: BotsService;
  selectedBot: BotConfig | null;
  setConfig: Dispatch<SetStateAction<BotsConfigFile>>;
}) {
  const { intl } = useZCodeIntl();
  const [bindCode, setBindCode] = useState<BindCodeState | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const bindRemainingMs = bindCode ? Math.max(0, bindCode.expiresAt - nowMs) : 0;
  const bindExpired = Boolean(bindCode && bindRemainingMs <= 0);
  const bindCountdownProgress = bindCode
    ? Math.max(0, Math.min(100, (bindRemainingMs / bindCode.ttlMs) * 100))
    : 0;

  useEffect(() => {
    if (!open || !bindCode) return undefined;
    setNowMs(Date.now());
    // Bugfix: 绑定码缩短到 30 秒后，1 秒刷新会让进度条明显跳格。
    // 这里用更细的节奏驱动动画，文字仍由 formatBindCountdown 按秒展示。
    const timer = window.setInterval(() => setNowMs(Date.now()), BIND_TICK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [bindCode, open]);

  useEffect(() => {
    if (!open || !bindCode || bindExpired) return undefined;
    let cancelled = false;

    const pollBindResult = async () => {
      try {
        const nextConfig = await botsService.getConfig();
        if (cancelled) return;
        setConfig(nextConfig);
        const targetBot = nextConfig.bots.find((bot) => bot.id === bindCode.botId);
        if (targetBot?.providerUserId) {
          // Bugfix: /bind 是从第三方聊天回写配置，UI 没有直接事件。
          // 绑定码展开期间低频刷新配置，绑定成功后立即收起绑定区域。
          setBindCode(null);
        }
      } catch (error) {
        logger.warn(
          "[BotsDialog] 轮询 Bot 绑定结果失败",
          error instanceof Error ? error.message : String(error),
        );
      }
    };

    void pollBindResult();
    const timer = window.setInterval(() => {
      void pollBindResult();
    }, BIND_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [bindCode, bindExpired, botsService, open, setConfig]);

  useEffect(() => {
    if (!bindCode || bindCode.botId !== selectedBot?.id || !selectedBot.providerUserId) {
      return;
    }
    // Bugfix: /bind 成功是服务层异步回写配置；即使轮询刚好被切换/刷新打断，
    // 只要当前 Bot 已经带 providerUserId，就应该立即收起旧绑定码。
    setBindCode(null);
  }, [bindCode, selectedBot?.id, selectedBot?.providerUserId]);

  const createBindCodeForBot = useCallback(
    async (bot: BotConfig) => {
      const createdAt = Date.now();
      const result = await botsService.createBindCode({
        botId: bot.id,
        ttlMs: BIND_CODE_TTL_MS,
        allowedWorkspaces: bot.allowedWorkspaces,
      });
      setNowMs(createdAt);
      setBindCode({
        botId: bot.id,
        code: result.code,
        createdAt,
        expiresAt: result.expiresAt,
        ttlMs: Math.max(1, result.expiresAt - createdAt),
      });
    },
    [botsService],
  );

  const copyBindCommand = useCallback(async () => {
    if (!bindCode || bindExpired) return;
    const command = `/bind ${bindCode.code}`;
    await navigator.clipboard?.writeText(command).catch((error: unknown) => {
      logger.warn(
        "[BotsDialog] 复制绑定命令失败",
        error instanceof Error ? error.message : String(error),
      );
    });
    toast(intl.formatMessage({ id: "bots.bindCommandCopied" }));
  }, [bindCode, bindExpired, intl]);

  return {
    bindCode,
    setBindCode,
    bindRemainingMs,
    bindExpired,
    bindCountdownProgress,
    createBindCodeForBot,
    copyBindCommand,
  };
}
