import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface UncensoredModelChatPanelProps {
  text: string;
  busy: boolean;
  result: { ok: boolean; text: string } | null;
  onTextChange: (value: string) => void;
  onSend: () => void;
  onCancel: () => void;
}

/** Inline composer under one uncensored model row. Host owns the request and the key. */
export function UncensoredModelChatPanel({
  text,
  busy,
  result,
  onTextChange,
  onSend,
  onCancel,
}: UncensoredModelChatPanelProps) {
  const { intl } = useZCodeIntl();
  const copy = (id: string) => intl.formatMessage({ id });

  return (
    <div className="mt-2 space-y-2" data-testid="uncensored-model-chat-panel">
      <textarea
        className="min-h-16 w-full resize-y rounded-md border border-border bg-surface p-2 text-ui-base text-foreground"
        data-testid="uncensored-model-chat-input"
        value={text}
        placeholder={copy("settings.uncensored.messagePlaceholder")}
        onChange={(event) => onTextChange(event.target.value)}
        disabled={busy}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          data-testid="uncensored-model-chat-send"
          disabled={busy || text.trim().length === 0}
          onClick={onSend}
        >
          {busy ? (
            <LoaderCircle className="mr-1 size-3.5 animate-spin" aria-hidden="true" />
          ) : null}
          {copy("settings.uncensored.send")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-ui-sm"
          data-testid="uncensored-model-chat-cancel"
          disabled={busy}
          onClick={onCancel}
        >
          {copy("settings.uncensored.cancel")}
        </Button>
      </div>
      {result ? (
        <div
          className="rounded-lg border border-border bg-surface p-2"
          data-testid="uncensored-model-chat-result"
        >
          <p className="text-ui-sm font-medium text-foreground-subtle">
            {copy("settings.uncensored.response")}
          </p>
          <pre
            className={`mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words text-ui-sm ${
              result.ok ? "text-foreground" : "text-destructive"
            }`}
          >
            {result.text}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
