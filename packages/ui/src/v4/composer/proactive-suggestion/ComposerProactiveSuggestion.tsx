import type { Ref } from "react";
import { SparklesIcon, XIcon } from "lucide-react";

import { cn } from "@/components/lib/utils.js";

export interface ComposerProactiveSuggestionLabels {
  loading: string;
  hint: string;
  dismiss: string;
}

export interface ComposerProactiveSuggestionProps {
  text: string | null;
  loading: boolean;
  labels: ComposerProactiveSuggestionLabels;
  hintRef: Ref<HTMLDivElement>;
  onAccept: () => void;
  onDismiss: () => void;
}

/** Подсказка следующей задачи над полем ввода; никогда не отправляет сама. */
export function ComposerProactiveSuggestion({
  text,
  loading,
  labels,
  hintRef,
  onAccept,
  onDismiss,
}: ComposerProactiveSuggestionProps) {
  if (!text && !loading) return null;
  return (
    <div
      ref={hintRef}
      data-composer-proactive-suggestion="true"
      className="flex max-w-full items-center gap-2 rounded-lg border border-border bg-surface px-2 py-1.5 text-ui-sm"
    >
      <SparklesIcon className="size-3.5 shrink-0 text-brand" aria-hidden="true" />
      {loading ? (
        <span role="status" aria-live="polite" className="text-foreground-subtle">
          {labels.loading}
        </span>
      ) : (
        <>
          <button
            type="button"
            onClick={onAccept}
            className="min-w-0 truncate text-left text-foreground hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
            title={text ?? undefined}
          >
            {text}
          </button>
          <span className="shrink-0 text-foreground-subtlest">{labels.hint}</span>
          <button
            type="button"
            aria-label={labels.dismiss}
            onClick={onDismiss}
            className={cn(
              "grid size-5 shrink-0 place-items-center rounded-md text-foreground-subtle",
              "hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
            )}
          >
            <XIcon className="size-3" aria-hidden="true" />
          </button>
        </>
      )}
    </div>
  );
}
