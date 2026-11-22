/** 技能诊断横幅：按严重级别汇总，展开后列出目录级诊断。 */
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { SkillsDiagnosticsBannerProps } from "@/settings/skills-section/types.js";

export function SkillsDiagnosticsBanner({
  diagnostics,
  open,
  summary,
  formatCodeLabel,
  onToggle,
}: SkillsDiagnosticsBannerProps) {
  const { intl } = useZCodeIntl();
  return (
    <div className="overflow-hidden rounded-lg border border-amber-500/40 bg-amber-500/10 text-ui-base text-foreground">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={
          open
            ? intl.formatMessage({
                id: "settings.skills.diagnostics.collapse",
              })
            : intl.formatMessage({
                id: "settings.skills.diagnostics.expand",
              })
        }
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
        )}
        <AlertTriangle
          className="size-3.5 shrink-0 text-amber-500"
          aria-hidden="true"
        />
        <span className="flex-1 truncate font-medium">{summary}</span>
      </button>
      {open ? (
        <ul className="space-y-1 border-t border-amber-500/30 px-3 py-2">
          {diagnostics.map((diagnostic, index) => (
            <li
              key={`${diagnostic.code}-${diagnostic.path ?? "no-path"}-${index}`}
              className="min-w-0"
            >
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span
                  className={
                    diagnostic.severity === "error"
                      ? "shrink-0 text-ui-xs font-semibold uppercase tracking-wide text-destructive"
                      : "shrink-0 text-ui-xs font-semibold uppercase tracking-wide text-amber-500"
                  }
                >
                  {diagnostic.severity}
                </span>
                <span className="font-medium text-foreground">
                  {formatCodeLabel(diagnostic.code)}
                </span>
                {diagnostic.skillName ? (
                  <span className="text-foreground-subtle">
                    · {diagnostic.skillName}
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 break-words text-foreground-subtle">
                {diagnostic.message}
              </div>
              {diagnostic.path ? (
                <div className="mt-0.5 break-all font-mono text-ui-xs text-foreground-subtle">
                  {diagnostic.path}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
