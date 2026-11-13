/**
 * BotsDialog：Bot 渠道接入与绑定弹窗。
 *
 * 数据、绑定码、扫码注册、名称编辑、凭据和工作区权限分别由 bots-dialog/* 下的
 * hook 持有；本文件只做组合、入口快捷创建和删除确认。公开 API（open/onOpenChange/
 * entryProvider）与渲染结构保持不变。
 */
import { useCallback } from "react";
import type { BotConfig, BotProvider } from "@zcode/shared";
import { isFeishuBotProvider } from "@zcode/shared";
import { Bot, Plus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import {
  BotDangerCard,
  BotReplyGranularityCard,
  BotSummaryCard,
} from "@/BotsDialog/BotSummaryCard.js";
import { ProviderSettingsCard } from "@/BotsDialog/ProviderSettingsCard.js";
import { BoundGroupsCard } from "@/BotsDialog/BoundGroupsCard.js";
import { WorkspaceAccessCard } from "@/BotsDialog/WorkspaceAccessCard.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import { TELEGRAM_BOTFATHER_URL, formatBotDisplayName } from "@/BotsDialog/shared.js";
import { logger } from "@/logger.js";
import { BotsSidebar } from "./bots-dialog/BotsSidebar.js";
import { NewBotPicker } from "./bots-dialog/NewBotPicker.js";
import { createDraftBot } from "./bots-dialog/createBot.js";
import { useBindCode } from "./bots-dialog/useBindCode.js";
import { useBotAutoOnboarding } from "./bots-dialog/useBotAutoOnboarding.js";
import { useBotCredentials } from "./bots-dialog/useBotCredentials.js";
import { useBotNameEditing } from "./bots-dialog/useBotNameEditing.js";
import { useBotsConfig } from "./bots-dialog/useBotsConfig.js";
import { useBotsEntryProvider } from "./bots-dialog/useBotsEntryProvider.js";
import { useFeishuRegistration } from "./bots-dialog/useFeishuRegistration.js";
import { useWeixinRegistration } from "./bots-dialog/useWeixinRegistration.js";
import { useWorkspaceAccessEditing } from "./bots-dialog/useWorkspaceAccessEditing.js";

export function BotsDialog({
  open,
  onOpenChange,
  entryProvider,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entryProvider?: BotProvider | null;
}) {
  const platform = usePlatform();
  const confirmDialog = useConfirmDialog();
  const data = useBotsConfig({ open });
  const {
    intl,
    botsService,
    config,
    setConfig,
    workspaceRefs,
    status,
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
  } = data;

  const bind = useBindCode({ open, botsService, selectedBot, setConfig });
  const feishu = useFeishuRegistration({
    open,
    botsService,
    selectedBot,
    selectedBotId,
    saveBot,
    setConfig,
  });
  const weixin = useWeixinRegistration({
    open,
    botsService,
    selectedBot,
    selectedBotId,
    selectedBotState,
    setBotStates,
    saveBot,
  });
  const name = useBotNameEditing({ selectedBot, fallbackBotName, saveBot });
  const autoOnboarding = useBotAutoOnboarding({
    open,
    creatingBot,
    selectedBot,
    bindCode: bind.bindCode,
    bindExpired: bind.bindExpired,
    createBindCodeForBot: bind.createBindCodeForBot,
    feishuRegistration: feishu.feishuRegistration,
    feishuRegistrationLoading: feishu.feishuRegistrationLoading,
    handleStartFeishuRegistration: feishu.handleStartFeishuRegistration,
    weixinRegistration: weixin.weixinRegistration,
    weixinRegistrationLoading: weixin.weixinRegistrationLoading,
    handleStartWeixinRegistration: weixin.handleStartWeixinRegistration,
  });
  const credentials = useBotCredentials({
    selectedBot,
    selectedBotId,
    botsService,
    credentialValue,
    setCredentialValue,
    saveBot,
    setConfig,
    setBindCode: bind.setBindCode,
    refresh,
    forgetAutoOnboarding: autoOnboarding.forgetAutoOnboarding,
  });
  const workspaceAccess = useWorkspaceAccessEditing({
    selectedBot,
    selectedBotId,
    workspaceRefs,
    saveBot,
    setConfig,
  });

  const patchSelectedBot = useCallback(
    (patch: Partial<BotConfig>) => {
      if (!selectedBot) return;
      void saveBot({ ...selectedBot, ...patch });
    },
    [saveBot, selectedBot],
  );

  const handleBeginAddBot = () => {
    setCreatingBot(true);
    setCreatingProvider(null);
    setSelectedBotId(null);
    setCredentialValue("");
    feishu.setFeishuRegistration(null);
    weixin.setWeixinRegistration(null);
  };

  const handleSelectBot = useCallback(
    (botId: string) => {
      setCreatingBot(false);
      setSelectedBotId(botId);
    },
    [setCreatingBot, setSelectedBotId],
  );

  const handleAddBot = useCallback(
    async (provider: BotProvider) => {
      if (creatingProvider) return;
      setCreatingProvider(provider);
      const bot = createDraftBot({
        provider,
      });
      try {
        await saveBot({
          ...bot,
          name: "",
          ...(provider === "webhook" ? { webhookAuthHeaderName: "x-zcode-bot-secret" } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[BotsDialog] 创建 Bot 失败", message);
        toast(intl.formatMessage({ id: "bots.saveFailed" }, { error: message }));
      } finally {
        setCreatingProvider(null);
      }
    },
    [creatingProvider, intl, saveBot, setCreatingProvider],
  );

  useBotsEntryProvider({
    open,
    entryProvider,
    config,
    configLoaded,
    handleAddBot,
    setCredentialValue,
    setFeishuRegistration: feishu.setFeishuRegistration,
    setWeixinRegistration: weixin.setWeixinRegistration,
    setCreatingBot,
    setCreatingProvider,
    setSelectedBotId,
  });

  const handleCreateBindCode = async () => {
    if (!selectedBot) return;
    await bind.createBindCodeForBot(selectedBot);
  };

  const handleOpenTelegramBotFather = () => {
    platform.openExternal(TELEGRAM_BOTFATHER_URL);
  };

  const handleDelete = async () => {
    if (!selectedBot) return;
    // Bugfix: 删除机器人之前没有二次确认，误触会直接移除凭据和绑定入口。
    // 这里复用项目统一 ConfirmDialog，让破坏性操作和其它设置页保持一致。
    const confirmed = await confirmDialog({
      confirmVariant: "destructive",
      title: intl.formatMessage(
        { id: "bots.deleteConfirmTitle" },
        { name: formatBotDisplayName(selectedBot.name, fallbackBotName) },
      ),
      description: intl.formatMessage({ id: "bots.deleteConfirmDescription" }),
      confirmLabel: intl.formatMessage({ id: "bots.delete" }),
    });
    if (!confirmed) return;

    try {
      await botsService.deleteBot(selectedBot.id);
      setSelectedBotId(null);
      void refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] 删除 Bot 失败", message);
      toast(intl.formatMessage({ id: "bots.deleteFailed" }, { error: message }));
    }
  };

  const selectedRuntime = selectedBot
    ? status?.botRuntime.find((item) => item.botId === selectedBot.id)
    : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[calc(100vh-6rem)] max-h-168 max-w-4xl flex-col overflow-hidden rounded-2xl"
        onEscapeKeyDown={name.handleDialogEscapeKeyDown}
      >
        <DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Bot className="size-5 text-foreground" />
            <DialogTitle className="text-ui-lg font-medium text-foreground">
              {intl.formatMessage({ id: "bots.title" })}
            </DialogTitle>
            <DialogDescription className="ml-3">
              {intl.formatMessage({ id: "bots.description" })}
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
          <BotsSidebar
            bots={config.bots}
            botRuntime={status?.botRuntime}
            selectedBotId={selectedBotId}
            creatingBot={creatingBot}
            fallbackBotName={fallbackBotName}
            onBeginAddBot={handleBeginAddBot}
            onSelectBot={handleSelectBot}
          />

          <section className="min-w-0 flex-1 overflow-y-auto rounded-xl border border-border bg-background p-4">
            {creatingBot ? (
              <NewBotPicker
                creatingProvider={creatingProvider}
                onAddBot={(provider) => void handleAddBot(provider)}
              />
            ) : !selectedBot ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-ui-base text-foreground-subtle">
                <Bot className="size-8" />
                <div>{intl.formatMessage({ id: "bots.empty" })}</div>
                <Button variant="outline" size="lg" onClick={handleBeginAddBot}>
                  <Plus className="size-4" />
                  {intl.formatMessage({ id: "bots.addBot" })}
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                <BotSummaryCard
                  bot={selectedBot}
                  runtime={selectedRuntime}
                  selectedBotDisplayName={name.selectedBotDisplayName}
                  selectedBotName={name.selectedBotName}
                  fallbackBotName={fallbackBotName}
                  renaming={name.renamingBotId === selectedBot.id}
                  onStartRename={name.startBotNameRename}
                  onCommitNameDraft={name.commitBotNameDraft}
                  onNameDraftChange={(value) =>
                    name.setBotNameDraft({ botId: selectedBot.id, value })
                  }
                  onNameCompositionEnd={() => {
                    name.botNameCompositionActiveRef.current = false;
                  }}
                  onNameCompositionStart={() => {
                    name.botNameCompositionActiveRef.current = true;
                  }}
                  onNameInputKeyDown={name.handleBotNameKeyDown}
                  onPatchBot={patchSelectedBot}
                />

                <ProviderSettingsCard
                  bot={selectedBot}
                  runtime={selectedRuntime}
                  credentialValue={credentialValue}
                  bindCode={bind.bindCode}
                  bindExpired={bind.bindExpired}
                  bindRemainingMs={bind.bindRemainingMs}
                  bindCountdownProgress={bind.bindCountdownProgress}
                  feishuRegistration={feishu.feishuRegistration}
                  feishuRegistrationLoading={feishu.feishuRegistrationLoading}
                  weixinRegistration={weixin.weixinRegistration}
                  weixinRegistrationLoading={weixin.weixinRegistrationLoading}
                  weixinActivated={Boolean(selectedBotState?.weixinActivatedAt)}
                  secretSaving={credentials.secretSaving}
                  onCredentialValueChange={setCredentialValue}
                  onSaveSecret={() => void credentials.handleSaveSecret()}
                  onRemoveSecret={() => void credentials.handleRemoveSecret()}
                  onOpenTelegramBotFather={handleOpenTelegramBotFather}
                  onStartWeixinRegistration={() => void weixin.handleStartWeixinRegistration()}
                  onStartFeishuRegistration={() => void feishu.handleStartFeishuRegistration()}
                  onCreateBindCode={() => void handleCreateBindCode()}
                  onUnbind={() => void credentials.handleUnbind()}
                  onCopyBindCommand={() => void bind.copyBindCommand()}
                />

                <SettingsGroupCard>
                  <BotReplyGranularityCard bot={selectedBot} onPatchBot={patchSelectedBot} />

                  {/*
                    暂不暴露命令权限编辑入口，避免用户在 bot 可用前把关键命令关掉。
                    如果要恢复 UI，重新渲染 selectedBot.allowedCommands 的列表并用 patchSelectedBot 保存。
                  */}

                  <WorkspaceAccessCard
                    bot={selectedBot}
                    workspaceRefs={workspaceRefs}
                    loading={workspaceAccess.workspaceAccessSaving}
                    onPatchAllowedWorkspaces={workspaceAccess.patchAllowedWorkspaces}
                    onToggleWorkspaceAccess={workspaceAccess.toggleWorkspaceAccess}
                  />
                </SettingsGroupCard>

                {isFeishuBotProvider(selectedBot.provider) && (
                  <BoundGroupsCard
                    key={selectedBot.id + ":" + selectedBot.providerUserId}
                    bot={selectedBot}
                  />
                )}

                <BotDangerCard onDelete={() => void handleDelete()} />
              </div>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
