import type { PromptEnhanceResult } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * Read-only provenance for an enhanced prompt. It deliberately has no install/run
 * action: capability suggestions are informational and require a separate consent.
 */
export function EnhancePromptDetails({ result }: { result: PromptEnhanceResult }) {
  const { intl } = useZCodeIntl();
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
          <ul className="space-y-1 text-foreground-subtle">
            {result.capabilitySuggestions.map((suggestion, index) => (
              <li key={`${suggestion.kind}:${suggestion.name}:${index}`}>
                <span className="font-medium text-foreground">
                  {suggestion.kind}:{suggestion.name}
                </span>{" "}
                — {suggestion.reason}{" "}
                {suggestion.requiresConsent ? (
                  <span className="text-foreground-subtlest">
                    ({intl.formatMessage({ id: "chat.composer.enhanceRequiresConsent" })})
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
