import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useSkillStore } from "@/store/skillStore.js";
import { useComposerPromptEnhance } from "./useComposerPromptEnhance.js";
import { EnhancePromptButton } from "./EnhancePromptButton.js";
import { useSuggestedSkillAutoInstall } from "./useSuggestedSkillAutoInstall.js";

/**
 * Мост между Lexical-редактором и сервисом улучшения промптов.
 *
 * Держит единственный `useComposerPromptEnhance` на композер и отдаёт наружу
 * императивный `trigger()` для `/enhance` и горячей клавиши, чтобы все входы
 * управляли одним запросом.
 */
export interface ComposerEnhancePromptHandle {
  /** Запустить/отменить улучшение текущего черновика. */
  trigger: () => void;
}

export interface ComposerEnhancePromptProps {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId?: string | null;
  draftText: string;
  disabled?: boolean;
  inputApiRef: React.MutableRefObject<LexicalChatInputHandle | null>;
  /** Синхронизировать текст владельца черновика (persist + onTextChange). */
  updateText: (text: string) => void;
  scheduleDraftPersist: () => void;
}

export const ComposerEnhancePrompt = forwardRef<
  ComposerEnhancePromptHandle,
  ComposerEnhancePromptProps
>(function ComposerEnhancePrompt(
  {
    workspacePath,
    workspaceIdentity,
    sessionId,
    draftText,
    disabled = false,
    inputApiRef,
    updateText,
    scheduleDraftPersist,
  },
  ref,
) {
  const services = useOptionalServices();
  const draftRef = useRef(draftText);
  draftRef.current = draftText;

  // Применение результата идёт через редактор: `setText` кладёт правку в историю Lexical,
  // поэтому `Ctrl+Z` возвращает исходный черновик, а не только нашу кнопку «Вернуть».
  const applyText = useCallback(
    (text: string) => {
      inputApiRef.current?.setText(text);
      updateText(text);
      scheduleDraftPersist();
      inputApiRef.current?.focus();
    },
    [inputApiRef, scheduleDraftPersist, updateText],
  );

  const enhance = useComposerPromptEnhance({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(sessionId ? { sessionId } : {}),
    onApply: applyText,
  });

  const trigger = useCallback(() => {
    if (enhance.isRunning) {
      void enhance.cancel();
      return;
    }
    void enhance.enhance(draftRef.current);
  }, [enhance]);

  const refreshSkills = useCallback(() => {
    const skillsService = services?.skillsService;
    if (!skillsService) return;
    // 安装/删除后技能列表必须立即可见：复用 skillStore 的 refresh 入口，
    // 不为建议面板另建缓存。
    void useSkillStore
      .getState()
      .refresh(skillsService, workspaceIdentity)
      .catch(() => {});
  }, [services, workspaceIdentity]);

  /**
   * 系统自动安装建议里的技能：增强结果一到达就由这个 effect 触发，
   * 不等用户点击，也没有第二次确认。幂等、重试和错误隔离都在 hook 内。
   * 安装走与设置面板相同的 skills service，技能→agent 供给与审计保持单一路径。
   */
  // Автоустановка запускается сразу по результату; отдельный предпросмотр не нужен.
  useSuggestedSkillAutoInstall({
    result: enhance.lastResult?.result ?? null,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    enabled: enhance.autoInstallSuggestedSkills,
    install: services?.skillsService ?? null,
    onSkillListChanged: refreshSkills,
  });

  useImperativeHandle(ref, () => ({ trigger }), [trigger]);

  // Горячая клавиша работает только из композера: вне поля ввода Cmd/Ctrl+Shift+E
  // принадлежит хост-приложению и не должна перехватываться.
  useEffect(() => {
    if (!enhance.available || disabled) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat) return;
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return;
      if (event.key.toLowerCase() !== "e") return;
      const active = document.activeElement;
      const editor = active?.closest?.('[data-testid="v4-composer-input"]');
      if (!editor) return;
      event.preventDefault();
      event.stopPropagation();
      trigger();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [disabled, enhance.available, trigger]);

  if (!enhance.available) return null;

  return (
    <EnhancePromptButton
      draftText={draftText}
      isRunning={enhance.isRunning}
      disabled={disabled || !enhance.enabledBySettings}
      canUndo={enhance.canUndo}
      onEnhance={(text) => void enhance.enhance(text)}
      onCancel={() => void enhance.cancel()}
      onUndo={enhance.undo}
    />
  );
});
