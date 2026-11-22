/**
 * BotsDialog 的数据装载与保存：配置、运行状态、工作区引用和 Bot 状态。
 *
 * 绑定码、扫码注册、凭据编辑等 hook 都通过这里拿到的 config/setConfig 和
 * saveBot 写入服务端事实，避免出现第二套配置状态。
 */
import { useCallback, useEffect, useState } from "react";
import type { BotServiceStatus, BotState, BotWorkspaceRef, BotsConfigFile } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { createEmptyConfig } from "./createBot.js";
import type { BotsDialogData } from "./types.js";

const STATUS_POLL_INTERVAL_MS = 2000;

export function useBotsConfig({ open }: { open: boolean }) {
  const { intl } = useZCodeIntl();
  const { botsService } = useServices();
  const [config, setConfig] = useState<BotsConfigFile>(() => createEmptyConfig());
  const [workspaceRefs, setWorkspaceRefs] = useState<BotWorkspaceRef[]>([]);
  const [status, setStatus] = useState<BotServiceStatus | null>(null);
  const [botStates, setBotStates] = useState<BotState[]>([]);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [creatingBot, setCreatingBot] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [creatingProvider, setCreatingProvider] =
    useState<BotsDialogData["creatingProvider"]>(null);
  // 凭据草稿由 saveBot 在保存成功后统一清空，避免“保存了配置但输入框还留着旧密钥”。
  const [credentialValue, setCredentialValue] = useState("");

  const selectedBot = config.bots.find((bot) => bot.id === selectedBotId) ?? null;
  const selectedBotState = botStates.find((state) => state.botId === selectedBotId) ?? null;
  const fallbackBotName = intl.formatMessage({
    id: "bots.newBot.fallbackName",
  });

  const refresh = useCallback(async () => {
    try {
      const [nextConfig, nextStatus, nextWorkspaces, nextBotStates] = await Promise.all([
        botsService.getConfig(),
        botsService.getStatus(),
        botsService.listWorkspaceRefs(),
        botsService.getBotStates(),
      ]);
      setConfig(nextConfig);
      setStatus(nextStatus);
      setWorkspaceRefs(nextWorkspaces);
      setBotStates(nextBotStates);
      setConfigLoaded(true);
      setSelectedBotId((current) =>
        creatingBot ? current : (current ?? nextConfig.bots[0]?.id ?? null),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] 加载 Bots 配置失败", message);
      toast(intl.formatMessage({ id: "bots.loadFailed" }, { error: message }));
    }
  }, [botsService, creatingBot, intl]);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pollStatus = async () => {
      try {
        const nextStatus = await botsService.getStatus();
        if (!cancelled) setStatus(nextStatus);
      } catch (error) {
        logger.debug("[BotsDialog] 刷新 Bot 运行状态失败", error);
      } finally {
        // 投递在后台完成；只在弹窗可见时串行刷新，避免慢 RPC 堆积或关闭后回写。
        if (!cancelled) timer = setTimeout(() => void pollStatus(), STATUS_POLL_INTERVAL_MS);
      }
    };
    void pollStatus();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [botsService, open]);

  useEffect(() => {
    setCredentialValue("");
  }, [selectedBotId, selectedBot?.provider]);

  useEffect(() => {
    if (open) {
      setConfigLoaded(false);
      void refresh();
    }
  }, [open, refresh]);

  const saveBot = useCallback<BotsDialogData["saveBot"]>(
    async (bot, secrets) => {
      const saved = await botsService.saveBot({
        bot,
        credentialValue: secrets?.credentialValue,
      });
      setConfig((previous) => ({
        ...previous,
        bots: [...previous.bots.filter((item) => item.id !== saved.id), saved],
      }));
      setSelectedBotId(saved.id);
      setCreatingBot(false);
      setCredentialValue("");
      void refresh();
      return saved;
    },
    [botsService, refresh],
  );

  return {
    intl,
    botsService,
    config,
    setConfig,
    workspaceRefs,
    status,
    botStates,
    setBotStates,
    selectedBotId,
    setSelectedBotId,
    selectedBot,
    selectedBotState,
    creatingBot,
    setCreatingBot,
    configLoaded,
    creatingProvider,
    setCreatingProvider,
    credentialValue,
    setCredentialValue,
    fallbackBotName,
    refresh,
    saveBot,
  };
}
