import { useCallback, useState } from "react";
import { LoaderCircle, WandSparkles } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import type { PromptEnhanceResult } from "@zcode/shared";
import { usePromptEnhancer } from "@/hooks/usePromptEnhancer.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SYSTEM_PROMPT_ENHANCE_TARGET, isEnhancePromptEnabled } from "./contract.js";
import { EnhancePromptDetails } from "./EnhancePromptDetails.js";

/**
 * Действие «Улучшить системный промпт» для редакторов кастомных инструкций.
 *
 * Отличие от кнопки композера: результат показывается в диалоге «было/стало» и
 * применяется только после явного подтверждения — молчаливая перезапись
 * конфигурации режима недопустима.
 */
export interface SystemPromptEnhanceActionProps {
  workspacePath: string;
  workspaceIdentity?: string;
  draftText: string;
  disabled?: boolean;
  onApply: (enhancedText: string) => void;
}

export function SystemPromptEnhanceAction({
  workspacePath,
  workspaceIdentity,
  draftText,
  disabled = false,
  onApply,
}: SystemPromptEnhanceActionProps) {
  const { intl } = useZCodeIntl();
  const services = useOptionalServices();
  const service = services?.promptEnhancerService;
  const [preview, setPreview] = useState<{
    before: string;
    after: string;
    result: PromptEnhanceResult;
  } | null>(null);
  const enhancer = usePromptEnhancer({
    promptEnhancerService: service ?? {
      enhance: () => Promise.reject(new Error("prompt enhancer is unavailable")),
      cancel: () => Promise.resolve(),
      onStreamDelta: () => () => {},
    },
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    target: SYSTEM_PROMPT_ENHANCE_TARGET.target,
    style: SYSTEM_PROMPT_ENHANCE_TARGET.style,
  });

  const handleEnhance = useCallback(async () => {
    const result = await enhancer.enhance(draftText);
    if (!result) {
      logger.warn("System prompt enhancement returned no result", {
        code: enhancer.error?.code ?? "unknown",
      });
      return;
    }
    setPreview({ before: draftText, after: result.enhancedText, result });
  }, [draftText, enhancer]);

  if (!service) return null;

  const enabled = !disabled && isEnhancePromptEnabled(draftText, SYSTEM_PROMPT_ENHANCE_TARGET);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="system-prompt-enhance"
        disabled={!enabled || enhancer.isRunning}
        onClick={() => void handleEnhance()}
        className="gap-1"
      >
        {enhancer.isRunning ? (
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <WandSparkles className="size-4" aria-hidden="true" />
        )}
        {intl.formatMessage({ id: "settings.systemPromptEnhance" })}
      </Button>
      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {intl.formatMessage({ id: "settings.systemPromptEnhanceTitle" })}
            </DialogTitle>
            <DialogDescription>
              {intl.formatMessage({ id: "settings.systemPromptEnhanceDescription" })}
            </DialogDescription>
          </DialogHeader>
          {preview ? (
            <div className="grid gap-3 md:grid-cols-2">
              <section className="min-w-0">
                <h3 className="mb-1 text-ui-base font-semibold text-foreground">
                  {intl.formatMessage({ id: "settings.systemPromptEnhanceBefore" })}
                </h3>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card p-3 text-ui-sm text-foreground-subtle">
                  {preview.before}
                </pre>
              </section>
              <section className="min-w-0">
                <h3 className="mb-1 text-ui-base font-semibold text-foreground">
                  {intl.formatMessage({ id: "settings.systemPromptEnhanceAfter" })}
                </h3>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card p-3 text-ui-sm text-foreground">
                  {preview.after}
                </pre>
              </section>
            </div>
          ) : null}
          {preview ? <EnhancePromptDetails result={preview.result} /> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPreview(null)}>
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (!preview) return;
                onApply(preview.after);
                setPreview(null);
                enhancer.reset();
              }}
            >
              {intl.formatMessage({ id: "settings.systemPromptEnhanceApply" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
