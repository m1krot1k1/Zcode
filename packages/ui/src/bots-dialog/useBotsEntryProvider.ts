/**
 * 远程控制入口直达：按 entryProvider 选中已有 Bot，或配置加载完成后新建。
 *
 * 入口只处理一次；配置刷新前不能判断是否已有对应渠道，必须等 configLoaded。
 */
import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { BotProvider, BotsConfigFile } from "@zcode/shared";
import { resolveBotProviderEntry } from "@/botsUi.js";
import type { FeishuRegistrationState, WeixinRegistrationState } from "@/BotsDialog/shared.js";

export function useBotsEntryProvider({
  open,
  entryProvider,
  config,
  configLoaded,
  handleAddBot,
  setCredentialValue,
  setFeishuRegistration,
  setWeixinRegistration,
  setCreatingBot,
  setCreatingProvider,
  setSelectedBotId,
}: {
  open: boolean;
  entryProvider?: BotProvider | null;
  config: BotsConfigFile;
  configLoaded: boolean;
  handleAddBot: (provider: BotProvider) => Promise<void>;
  setCredentialValue: Dispatch<SetStateAction<string>>;
  setFeishuRegistration: Dispatch<SetStateAction<FeishuRegistrationState | null>>;
  setWeixinRegistration: Dispatch<SetStateAction<WeixinRegistrationState | null>>;
  setCreatingBot: Dispatch<SetStateAction<boolean>>;
  setCreatingProvider: Dispatch<SetStateAction<BotProvider | null>>;
  setSelectedBotId: Dispatch<SetStateAction<string | null>>;
}) {
  const handledEntryProviderRef = useRef<BotProvider | null>(null);

  useEffect(() => {
    handledEntryProviderRef.current = null;
  }, [entryProvider, open]);

  useEffect(() => {
    if (!open || !entryProvider || !configLoaded) {
      return;
    }
    if (handledEntryProviderRef.current === entryProvider) {
      return;
    }

    const entry = resolveBotProviderEntry(config.bots, entryProvider);
    handledEntryProviderRef.current = entryProvider;
    setCredentialValue("");
    setFeishuRegistration(null);
    setWeixinRegistration(null);

    if (entry.mode === "select") {
      setCreatingBot(false);
      setCreatingProvider(null);
      setSelectedBotId(entry.botId);
      return;
    }

    // Bugfix: 远程控制弹窗新增 Bot Channel 快捷入口后，进入 BotsDialog 不能停在空白选择页。
    // 这里在配置加载完成后再判断并创建，避免异步刷新尚未拿到已有 bot 时重复新建。
    setCreatingBot(true);
    setSelectedBotId(null);
    void handleAddBot(entry.provider);
  }, [
    config.bots,
    configLoaded,
    entryProvider,
    handleAddBot,
    open,
    setCreatingBot,
    setCreatingProvider,
    setCredentialValue,
    setFeishuRegistration,
    setSelectedBotId,
    setWeixinRegistration,
  ]);
}
