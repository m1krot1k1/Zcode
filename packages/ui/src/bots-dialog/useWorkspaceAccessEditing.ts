/**
 * Bot 工作区访问范围编辑：乐观更新、失败回滚与“全部工作区”归一化。
 *
 * 允许列表为空时统一落成 ALL_BOT_WORKSPACES，避免服务端出现两种“无限制”表达。
 */
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { BotConfig, BotsConfigFile, BotWorkspaceRef } from "@zcode/shared";
import { ALL_BOT_WORKSPACES } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { isAllWorkspacesAllowed } from "@/BotsDialog/shared.js";
import type { SaveBot } from "./types.js";

export function useWorkspaceAccessEditing({
  selectedBot,
  selectedBotId,
  workspaceRefs,
  saveBot,
  setConfig,
}: {
  selectedBot: BotConfig | null;
  selectedBotId: string | null;
  workspaceRefs: BotWorkspaceRef[];
  saveBot: SaveBot;
  setConfig: Dispatch<SetStateAction<BotsConfigFile>>;
}) {
  const { intl } = useZCodeIntl();
  const [workspaceAccessSaving, setWorkspaceAccessSaving] = useState(false);

  useEffect(() => {
    setWorkspaceAccessSaving(false);
  }, [selectedBotId, selectedBot?.provider]);

  const patchAllowedWorkspaces = useCallback(
    async (allowedWorkspaces: string[]) => {
      if (!selectedBot) return;
      setWorkspaceAccessSaving(true);
      const normalizedAllowedWorkspaces =
        allowedWorkspaces.length > 0 ? allowedWorkspaces : [ALL_BOT_WORKSPACES];
      const previousBot = selectedBot;
      const optimisticBot = {
        ...selectedBot,
        allowedWorkspaces: normalizedAllowedWorkspaces,
      };
      setConfig((previous) => ({
        ...previous,
        bots: previous.bots.map((bot) => (bot.id === optimisticBot.id ? optimisticBot : bot)),
      }));
      try {
        await saveBot(optimisticBot);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[BotsDialog] 保存工作区访问范围失败", message);
        setConfig((previous) => ({
          ...previous,
          bots: previous.bots.map((bot) => (bot.id === previousBot.id ? previousBot : bot)),
        }));
        toast(intl.formatMessage({ id: "bots.saveFailed" }, { error: message }));
      } finally {
        setWorkspaceAccessSaving(false);
      }
    },
    [intl, saveBot, selectedBot, setConfig],
  );

  const toggleWorkspaceAccess = useCallback(
    async (workspaceId: string, checked: boolean) => {
      if (!selectedBot) return;
      const currentAllowed = isAllWorkspacesAllowed(selectedBot.allowedWorkspaces)
        ? workspaceRefs.map((workspace) => workspace.id)
        : selectedBot.allowedWorkspaces;
      const nextAllowed = checked
        ? [...new Set([...currentAllowed, workspaceId])]
        : currentAllowed.filter((id) => id !== workspaceId);
      await patchAllowedWorkspaces(nextAllowed);
    },
    [patchAllowedWorkspaces, selectedBot, workspaceRefs],
  );

  return {
    workspaceAccessSaving,
    patchAllowedWorkspaces,
    toggleWorkspaceAccess,
  };
}
