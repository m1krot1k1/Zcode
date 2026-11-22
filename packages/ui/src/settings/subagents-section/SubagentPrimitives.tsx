import type { AgentColor } from "@zcode/shared";
import { Check } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { SUBAGENT_COLORS, SUBAGENT_COLOR_CLASS } from "@/lib/subagentColors.js";
import { RISKY_TOOLS } from "@/settings/subagents-section/subagentModel.js";

export const AGENT_COLORS: AgentColor[] = [...SUBAGENT_COLORS];
export const COLOR_DOT_CLASS: Record<AgentColor, string> = SUBAGENT_COLOR_CLASS;

export function FormFieldLabel({ children }: { children: string }) {
  return (
    <label className="mb-1.5 block text-ui-base font-medium text-foreground-subtle">
      {children}
    </label>
  );
}

export function AgentColorDot({ color }: { color?: AgentColor }) {
  return (
    <span
      className={cn(
        "inline-flex size-2 shrink-0 rounded-full",
        color ? COLOR_DOT_CLASS[color] : "bg-foreground-subtlest",
      )}
      aria-hidden="true"
    />
  );
}

export function AgentBadge({ children, className }: { children: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex min-h-5 items-center rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle ring-1 ring-border",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function ToolCheckbox({
  checked,
  disabled,
  label,
  onToggle,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "flex min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left transition-colors",
        disabled ? "cursor-not-allowed opacity-60" : "hover:bg-surface-hover",
      )}
    >
      <span className="flex size-6 shrink-0 items-center justify-center" aria-hidden="true">
        <span
          className={cn(
            "flex size-4 items-center justify-center rounded-sm border transition-colors",
            checked
              ? "border-primary bg-primary text-primary-foreground"
              : "border-input-border bg-input text-transparent",
          )}
        >
          <Check className="size-3.5" />
        </span>
      </span>
      <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
        {label}
      </span>
      {RISKY_TOOLS.has(label) ? (
        <span className="size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
      ) : null}
    </button>
  );
}
