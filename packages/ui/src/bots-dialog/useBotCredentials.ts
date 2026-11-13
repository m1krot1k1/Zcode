/**
 * Bot 凭据编辑：App Secret/Token 输入、保存、解除绑定与移除凭据。
 *
 * 凭据明文只存在于输入框本地状态；保存走 saveBot 的 secret 通道，
 * 移除后同步清掉自动扫码/自动绑定去重键，让下次进入能重新走接入流程。
 */
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { BotConfig, BotsConfigFile } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { BindCodeState } from "@/BotsDialog/shared.js";
import type { BotsService, SaveBot } from "./types.js";

export function useBotCredentials({
  selectedBot,
  selectedBotId,
  botsService,
  credentialValue,
  setCredentialValue,
  saveBot,
  setConfig,
  setBindCode,
  refresh,
  forgetAutoOnboarding,
}: {
  selectedBot: BotConfig | null;
  selectedBotId: string | null;
  botsService: BotsService;
  credentialValue: string;
  setCredentialValue: Dispatch<SetStateAction<string>>;
  saveBot: SaveBot;
  setConfig: Dispatch<SetStateAction<BotsConfigFile>>;
  setBindCode: Dispatch<SetStateAction<BindCodeState | null>>;
  refresh: () => Promise<void>;
  forgetAutoOnboarding: (botId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const [secretSaving, setSecretSaving] = useState(false);

  useEffect(() => {
    setSecretSaving(false);
  }, [selectedBotId, selectedBot?.provider]);

  const handleSaveSecret = async () => {
    if (!selectedBot || secretSaving) return;
    setSecretSaving(true);
    try {
      await saveBot(selectedBot, { credentialValue });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] 保存 Bot secret 失败", message);
      toast(intl.formatMessage({ id: "bots.saveFailed" }, { error: message }));
    } finally {
      setSecretSaving(false);
    }
  };

  const handleUnbind = async () => {
    if (!selectedBot) return;
    await saveBot({
      ...selectedBot,
      providerUserId: undefined,
      displayName: undefined,
    });
    await botsService.resetBotState(selectedBot.id);
  };

  const handleRemoveSecret = async () => {
    if (!selectedBot) return;
    try {
      const saved = await botsService.removeBotSecret(selectedBot.id);
      forgetAutoOnboarding(selectedBot.id);
      setConfig((previous) => ({
        ...previous,
        bots: previous.bots.map((item) => (item.id === saved.id ? saved : item)),
      }));
      setCredentialValue("");
      setBindCode(null);
      void refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] 移除 Bot secret 失败", message);
      toast(intl.formatMessage({ id: "bots.removeSecretFailed" }, { error: message }));
    }
  };

  return {
    credentialValue,
    setCredentialValue,
    secretSaving,
    handleSaveSecret,
    handleUnbind,
    handleRemoveSecret,
  };
}
