import { useState } from "react";
import type { PromptEnhanceCapabilitySuggestion, PromptEnhanceResult } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import type { SuggestedSkillInstallEntry } from "./useSuggestedSkillAutoInstall.js";

/**
 * Provenance for an enhanced prompt plus live status of the automatic skill installs.
 *
 * The composer starts installation itself when the suggestion list arrives; this component
 * only renders `installing`/`installed`/`error`, offers a manual retry after a failure and
 * lets the author remove a skill this flow installed. MCP/plugin/agent suggestions stay
 * informational because their installation has its own settings surface.
 */
export interface EnhancePromptDetailsProps {
  result: PromptEnhanceResult;
  /** Per-skill auto-install status owned by `useSuggestedSkillAutoInstall`. */
  skillStates?: Readonly<Record<string, SuggestedSkillInstallEntry>>;
  /** Host install path is unavailable: show the reason instead of dead actions. */
  installAvailable?: boolean;
  /** Auto-install is off in settings: keep the manual install action on the row. */
  autoInstallEnabled?: boolean;
  onRetryInstallSkill?: (suggestion: PromptEnhanceCapabilitySuggestion) => void;
  onRemoveInstalledSkill?: (suggestion: PromptEnhanceCapabilitySuggestion) => void;
  removingSkill?: string | null;
}

export function EnhancePromptDetails({
  result,
  skillStates = {},
  installAvailable = true,
  autoInstallEnabled = true,
  onRetryInstallSkill,
  onRemoveInstalledSkill,
  removingSkill = null,
}: EnhancePromptDetailsProps) {
  const { intl } = useZCodeIntl();
  // 删除技能是破坏性操作：行内二次确认，不复用全局弹窗以免增强面板依赖应用根。
  const [confirmingRemoval, setConfirmingRemoval] = useState<string | null>(null);

  return (
    <div className="space-y-3 text-ui-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-foreground-subtle">
        <span>
          {intl.formatMessage({ id: "chat.composer.enhanceFramework" })}:{" "}
          <strong className="font-medium text-foreground">{result.framework.toUpperCase()}</strong>
        </span>
        <span>
          {intl.formatMessage({ id: "chat.composer.enhanceDomain" })}:{" "}
          <strong className="font-medium text-foreground">{result.domain}</strong>
        </span>
        <span>
          {intl.formatMessage({ id: "chat.composer.enhanceTask" })}:{" "}
          <strong className="font-medium text-foreground">{result.taskKind}</strong>
        </span>
      </div>
      {result.assumptions.length > 0 ? (
        <section className="space-y-1">
          <h4 className="font-medium text-foreground">
            {intl.formatMessage({ id: "chat.composer.enhanceAssumptions" })}
          </h4>
          <ul className="list-disc space-y-1 pl-5 text-foreground-subtle">
            {result.assumptions.map((assumption, index) => (
              <li key={`${assumption.origin}:${index}`}>
                {assumption.text}{" "}
                <span className="text-foreground-subtlest">({assumption.origin})</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {result.capabilitySuggestions.length > 0 ? (
        <section className="space-y-1">
          <h4 className="font-medium text-foreground">
            {intl.formatMessage({ id: "chat.composer.enhanceCapabilities" })}
          </h4>
          <ul className="space-y-2 text-foreground-subtle">
            {result.capabilitySuggestions.map((suggestion, index) => {
              const state = skillStates[suggestion.name];
              const isSkill = suggestion.kind === "skill";
              const removed = state?.phase === "removed";
              const installed = isSkill
                ? (suggestion.installed && !removed) || state?.phase === "installed"
                : suggestion.installed;
              const isInstalling = state?.phase === "installing";
              const failed = state?.phase === "error";
              const confirming = confirmingRemoval === suggestion.name;
              return (
                <li
                  key={`${suggestion.kind}:${suggestion.name}:${index}`}
                  className="flex flex-wrap items-center gap-2"
                >
                  <span>
                    <span className="font-medium text-foreground">
                      {suggestion.kind}:{suggestion.name}
                    </span>{" "}
                    — {suggestion.reason}{" "}
                  </span>
                  {installed ? (
                    <span className="rounded-full bg-success/10 px-2 py-0.5 text-ui-xs text-success">
                      {intl.formatMessage({ id: "chat.composer.enhanceCapabilityInstalled" })}
                    </span>
                  ) : (
                    <span className="text-ui-xs text-foreground-subtlest">
                      {intl.formatMessage({ id: "chat.composer.enhanceCapabilityNotInstalled" })}
                    </span>
                  )}
                  {isSkill ? (
                    <>
                      {installed ? (
                        <span className="text-ui-xs text-foreground-subtlest">skills.sh</span>
                      ) : null}
                      {!installed && isInstalling ? (
                        <span className="text-ui-xs text-foreground-subtlest">
                          {intl.formatMessage({ id: "chat.composer.enhanceCapabilityInstalling" })}
                        </span>
                      ) : null}
                      {!installed && !isInstalling && !failed && !installAvailable ? (
                        <span className="text-ui-xs text-foreground-subtlest">
                          {intl.formatMessage({ id: "chat.composer.enhanceCapabilityUnavailable" })}
                        </span>
                      ) : null}
                      {!installed &&
                      !isInstalling &&
                      !failed &&
                      installAvailable &&
                      !autoInstallEnabled &&
                      onRetryInstallSkill ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => onRetryInstallSkill(suggestion)}
                        >
                          {intl.formatMessage({ id: "chat.composer.enhanceCapabilityInstall" })}
                        </Button>
                      ) : null}
                      {failed ? (
                        <>
                          <span className="text-ui-xs text-destructive" role="alert">
                            {state?.error}
                          </span>
                          {installAvailable && onRetryInstallSkill ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => onRetryInstallSkill(suggestion)}
                            >
                              {intl.formatMessage({ id: "chat.composer.enhanceCapabilityInstall" })}
                            </Button>
                          ) : null}
                        </>
                      ) : null}
                      {state?.phase === "installed" && onRemoveInstalledSkill ? (
                        confirming ? (
                          <span className="flex items-center gap-1">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={removingSkill === suggestion.name}
                              onClick={() => {
                                setConfirmingRemoval(null);
                                onRemoveInstalledSkill(suggestion);
                              }}
                            >
                              {intl.formatMessage({ id: "common.delete" })}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => setConfirmingRemoval(null)}
                            >
                              {intl.formatMessage({ id: "common.cancel" })}
                            </Button>
                          </span>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={removingSkill === suggestion.name}
                            onClick={() => setConfirmingRemoval(suggestion.name)}
                          >
                            {intl.formatMessage({ id: "common.delete" })}
                          </Button>
                        )
                      ) : null}
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
