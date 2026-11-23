import { useCallback } from "react";
import { LoaderCircle, WandSparkles } from "lucide-react";
import type { IServiceAccessor } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { usePromptEnhancer } from "@/hooks/usePromptEnhancer.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SYSTEM_PROMPT_ENHANCE_TARGET, isEnhancePromptEnabled } from "./contract.js";

/**
 * Действие «Улучшить системный промпт» для редакторов кастомных инструкций.
 *
 * Отличие от кнопки композера: результат сразу применяется в целевое поле редактора,
 * без промежуточного диалога «было/стало». Это черновик формы — конфигурация режима
 * меняется только явным сохранением, а сброс формы отбрасывает улучшение.
 */
export interface SystemPromptEnhanceActionProps {
  workspacePath: string;
  workspaceIdentity?: string;
  draftText: string;
  disabled?: boolean;
  onApply: (enhancedText: string) => void;
  /**
   * Target-scoped accessor (local or SSH/remote). Settings pages can be rendered under
   * the local host even when the edited agent belongs to a remote workspace; the
   * ambient provider must not win in that case.
   */
  services?: IServiceAccessor | null;
}

export function SystemPromptEnhanceAction({
  workspacePath,
  workspaceIdentity,
  draftText,
  disabled = false,
  onApply,
  services,
}: SystemPromptEnhanceActionProps) {
  const { intl } = useZCodeIntl();
  const ambientServices = useOptionalServices();
  const service = services?.promptEnhancerService ?? ambientServices?.promptEnhancerService;
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
      return;
    }
    onApply(result.enhancedText);
    enhancer.reset();
  }, [draftText, enhancer, onApply]);

  if (!service) return null;

  const enabled = !disabled && isEnhancePromptEnabled(draftText, SYSTEM_PROMPT_ENHANCE_TARGET);

  return (
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
  );
}
