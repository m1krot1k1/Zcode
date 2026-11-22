import { LoaderCircle, RotateCcw, WandSparkles } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { COMPOSER_ENHANCE_TARGET, isEnhancePromptEnabled } from "./contract.js";

/**
 * Кнопка `Enhance Prompt` рядом с контролами отправки.
 *
 * Компонент презентационный: состояние запроса принадлежит
 * `useComposerPromptEnhance`, живущему в композере. Так `/enhance` и кнопка
 * управляют одним запросом и не могут рассинхронизироваться.
 */
export interface EnhancePromptButtonProps {
  draftText: string;
  isRunning: boolean;
  /** Настройка/сервис недоступны или композер заблокирован. */
  disabled?: boolean;
  canUndo?: boolean;
  onEnhance: (draftText: string) => void;
  onCancel: () => void;
  onUndo: () => void;
}

export function EnhancePromptButton({
  draftText,
  isRunning,
  disabled = false,
  canUndo = false,
  onEnhance,
  onCancel,
  onUndo,
}: EnhancePromptButtonProps) {
  const { intl } = useZCodeIntl();
  const enabled = !disabled && isEnhancePromptEnabled(draftText, COMPOSER_ENHANCE_TARGET);
  const label = intl.formatMessage({ id: "chat.composer.enhancePrompt" });

  return (
    <span className="flex items-center gap-1">
      <ControlHintTooltip
        title={
          isRunning
            ? intl.formatMessage({ id: "chat.composer.enhancePromptCancel" })
            : intl.formatMessage({ id: "chat.composer.enhancePromptHint" })
        }
        shortcut="Mod+Shift+E"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-testid="v4-composer-enhance-prompt"
          aria-label={label}
          aria-busy={isRunning}
          disabled={!enabled && !isRunning}
          onClick={() => (isRunning ? onCancel() : onEnhance(draftText))}
        >
          {isRunning ? (
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <WandSparkles className="size-4" aria-hidden="true" />
          )}
        </Button>
      </ControlHintTooltip>
      {canUndo && !isRunning ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="v4-composer-enhance-undo"
          onClick={onUndo}
          className="gap-1 text-ui-xs"
        >
          <RotateCcw className="size-3" aria-hidden="true" />
          {intl.formatMessage({ id: "chat.composer.enhancePromptUndo" })}
        </Button>
      ) : null}
    </span>
  );
}
