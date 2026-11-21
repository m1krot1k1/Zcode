import { useState } from "react";
import type { PromptEnhanceCapabilitySuggestion, PromptEnhanceResult } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";

/**
 * Read-only provenance for an enhanced prompt plus an explicit, two-step install action
 * for skill suggestions. Nothing is installed on render: the first click only arms the
 * confirmation, the second click calls the Host install path. MCP/plugin/agent suggestions
 * stay informational because their installation has its own settings surface.
 */
export interface EnhancePromptDetailsProps {
  result: PromptEnhanceResult;
  onInstallSkill?: (suggestion: PromptEnhanceCapabilitySuggestion) => Promise<void>;
  installingSkill?: string | null;
  installError?: string | null;
}

export function EnhancePromptDetails({
  result,
  onInstallSkill,
  installingSkill = null,
  installError = null,
}: EnhancePromptDetailsProps) {
  const { intl } = useZCodeIntl();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [installedLocally, setInstalledLocally] = useState<ReadonlySet<string>>(new Set());

  const install = async (suggestion: PromptEnhanceCapabilitySuggestion) => {
    if (!onInstallSkill || suggestion.kind !== "skill") return;
    const key = suggestion.name;
    if (confirming !== key) {
      setConfirming(key);
      return;
    }
    setConfirming(null);
    await onInstallSkill(suggestion);
    setInstalledLocally((previous) => new Set(previous).add(key));
  };

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
              const locallyInstalled = installedLocally.has(suggestion.name);
              const installed = suggestion.installed || locallyInstalled;
              const isInstalling = installingSkill === suggestion.name;
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
                  {suggestion.kind === "skill" && !installed && onInstallSkill ? (
                    <Button
                      type="button"
                      size="sm"
                      variant={confirming === suggestion.name ? "default" : "outline"}
                      disabled={isInstalling}
                      onClick={() => void install(suggestion)}
                    >
                      {isInstalling
                        ? intl.formatMessage({ id: "chat.composer.enhanceCapabilityInstalling" })
                        : confirming === suggestion.name
                          ? intl.formatMessage({
                              id: "chat.composer.enhanceCapabilityConfirmInstall",
                            })
                          : intl.formatMessage({ id: "chat.composer.enhanceCapabilityInstall" })}
                    </Button>
                  ) : null}
                  {suggestion.requiresConsent && !installed ? (
                    <span className="text-ui-xs text-foreground-subtlest">
                      ({intl.formatMessage({ id: "chat.composer.enhanceRequiresConsent" })})
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {installError ? (
            <p className="text-ui-xs text-destructive" role="alert">
              {installError}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
