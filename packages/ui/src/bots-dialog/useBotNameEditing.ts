/**
 * Bot 名称重命名：本地草稿、IME 保护与 Dialog Escape 拦截。
 *
 * 输入过程中不落库，提交时才保存；名称是本地草稿，服务端回写只作为下一次
 * 编辑的起点，避免 trim 吃空格打断输入。
 */
import { useCallback, useRef, useState, type KeyboardEvent } from "react";
import type { BotConfig } from "@zcode/shared";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import { logger } from "@/logger.js";
import { formatBotDisplayName } from "@/BotsDialog/shared.js";
import type { SaveBot } from "./types.js";

export function useBotNameEditing({
  selectedBot,
  fallbackBotName,
  saveBot,
}: {
  selectedBot: BotConfig | null;
  fallbackBotName: string;
  saveBot: SaveBot;
}) {
  const [botNameDraft, setBotNameDraft] = useState<{
    botId: string;
    value: string;
  } | null>(null);
  const [renamingBotId, setRenamingBotId] = useState<string | null>(null);
  const botNameCompositionActiveRef = useRef(false);

  const selectedBotName =
    selectedBot && botNameDraft?.botId === selectedBot.id
      ? botNameDraft.value
      : (selectedBot?.name ?? "");
  const selectedBotDisplayName = formatBotDisplayName(selectedBotName, fallbackBotName);

  const startBotNameRename = useCallback(() => {
    if (!selectedBot) return;
    setRenamingBotId(selectedBot.id);
    setBotNameDraft({ botId: selectedBot.id, value: selectedBot.name });
  }, [selectedBot]);

  const commitBotNameDraft = useCallback(() => {
    if (!selectedBot) return;
    const nextName = selectedBotName.trim();
    setBotNameDraft(null);
    setRenamingBotId(null);
    if (nextName === selectedBot.name) return;
    // Bugfix: Bot 名称输入过程中如果立即保存，服务层 trim 后的回写会吃掉刚输入的尾部空格，
    // 导致用户无法继续输入包含空格的名称；改为提交时保存，保留输入过程中的本地草稿。
    // 同时空名称是合法的未命名状态，展示层统一用多语言 fallback 名称兜底。
    void saveBot({ ...selectedBot, name: nextName });
  }, [saveBot, selectedBot, selectedBotName]);

  const handleBotNameKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        if (
          isImeComposingKeyEvent({
            compositionActive: botNameCompositionActiveRef.current,
            nativeEvent: event.nativeEvent,
          })
        ) {
          // Bugfix: Bot 名称重命名时中文输入法 Enter 是候选词确认，不是提交重命名。
          // 这里避免触发 blur，否则 blur 会继续走 commitBotNameDraft。
          logger.debug("[BotsDialog] ignore bot name enter during IME", {
            botId: selectedBot?.id ?? null,
          });
          return;
        }
        event.currentTarget.blur();
        return;
      }
      if (event.key === "Escape") {
        // Bugfix: 重命名输入框里的 Escape 只应该取消编辑，不能继续冒泡触发 Dialog 的关闭快捷键。
        setBotNameDraft(null);
        setRenamingBotId(null);
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [selectedBot?.id],
  );

  const handleDialogEscapeKeyDown = useCallback(
    (event: Event) => {
      if (renamingBotId === null) return;
      // Bugfix: Radix Dialog 会在输入框 React onKeyDown 冒泡前处理 Escape 关闭。
      // 正在重命名时需要在 Dialog 的关闭入口拦截，Esc 只取消编辑，不关闭弹窗。
      event.preventDefault();
      setBotNameDraft(null);
      setRenamingBotId(null);
    },
    [renamingBotId],
  );

  return {
    botNameDraft,
    setBotNameDraft,
    renamingBotId,
    selectedBotName,
    selectedBotDisplayName,
    botNameCompositionActiveRef,
    startBotNameRename,
    commitBotNameDraft,
    handleBotNameKeyDown,
    handleDialogEscapeKeyDown,
  };
}
