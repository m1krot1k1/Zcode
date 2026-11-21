import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { PromptEnhanceCapabilitySuggestion } from "@zcode/shared";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { Button } from "@/components/ui/button.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useComposerPromptEnhance } from "./useComposerPromptEnhance.js";
import { EnhancePromptButton } from "./EnhancePromptButton.js";
import { EnhancePromptDetails } from "./EnhancePromptDetails.js";

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
  const { intl } = useZCodeIntl();
  const services = useOptionalServices();
  const [installingSkill, setInstallingSkill] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
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
    setInstallError(null);
    void enhance.enhance(draftRef.current);
  }, [enhance]);

  /**
   * Two-step consent lives in `EnhancePromptDetails`: this callback only runs after the
   * user confirms. Installation still goes through the same skills service as Settings,
   * so skill→agent provisioning and audit logging stay in one place.
   */
  const installSkill = useCallback(
    async (suggestion: PromptEnhanceCapabilitySuggestion) => {
      const skillsService = services?.skillsService;
      if (!skillsService) {
        setInstallError(intl.formatMessage({ id: "chat.composer.enhanceCapabilityUnavailable" }));
        return;
      }
      setInstallingSkill(suggestion.name);
      setInstallError(null);
      try {
        const result = await skillsService.installMarketplaceSkill({
          name: suggestion.name,
          scope: "workspace",
          workspacePath,
        });
        logger.info("Capability suggestion installed with consent", {
          kind: suggestion.kind,
          name: result.name,
          agentName: result.agentName,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("Capability suggestion install failed", {
          kind: suggestion.kind,
          name: suggestion.name,
          error: message,
        });
        setInstallError(message);
      } finally {
        setInstallingSkill(null);
      }
    },
    [intl, services, workspacePath],
  );

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
    <>
      <EnhancePromptButton
        draftText={draftText}
        isRunning={enhance.isRunning}
        disabled={disabled || !enhance.enabledBySettings}
        canUndo={enhance.canUndo}
        onEnhance={(text) => void enhance.enhance(text)}
        onCancel={() => void enhance.cancel()}
        onUndo={enhance.undo}
      />
      <Dialog
        open={enhance.preview !== null}
        onOpenChange={(open) => {
          if (!open) enhance.discardPreview();
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {intl.formatMessage({ id: "chat.composer.enhancePreviewTitle" })}
            </DialogTitle>
            <DialogDescription>
              {intl.formatMessage({ id: "chat.composer.enhancePreviewDescription" })}
            </DialogDescription>
          </DialogHeader>
          {enhance.preview ? (
            <>
              <div className="grid gap-3 md:grid-cols-2">
                <section className="min-w-0">
                  <h3 className="mb-1 text-ui-base font-semibold text-foreground">
                    {intl.formatMessage({ id: "settings.systemPromptEnhanceBefore" })}
                  </h3>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card p-3 text-ui-sm text-foreground-subtle">
                    {enhance.preview.before}
                  </pre>
                </section>
                <section className="min-w-0">
                  <h3 className="mb-1 text-ui-base font-semibold text-foreground">
                    {intl.formatMessage({ id: "settings.systemPromptEnhanceAfter" })}
                  </h3>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card p-3 text-ui-sm text-foreground">
                    {enhance.preview.after}
                  </pre>
                </section>
              </div>
              <EnhancePromptDetails
                result={enhance.preview.result}
                onInstallSkill={services?.skillsService ? installSkill : undefined}
                installingSkill={installingSkill}
                installError={installError}
              />
            </>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={enhance.discardPreview}>
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button type="button" onClick={enhance.acceptPreview}>
              {intl.formatMessage({ id: "chat.composer.enhanceApply" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
});
