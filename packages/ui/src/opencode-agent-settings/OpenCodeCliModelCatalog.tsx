import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { OpenCodeAgentModelCatalog } from "./contract.js";

export function OpenCodeCliModelCatalogSection({
  catalog,
  disabled,
  onRefresh,
}: {
  catalog: OpenCodeAgentModelCatalog | undefined;
  disabled: boolean;
  onRefresh: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div
      className="space-y-2 rounded-lg border border-border p-3"
      data-testid="opencode-cli-model-catalog"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-ui-base font-medium">
            {intl.formatMessage({ id: "settings.openCode.cliModelCatalogTitle" })}
          </p>
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.openCode.cliAuthNotChecked" })}
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={onRefresh} disabled={disabled}>
          {intl.formatMessage({ id: "settings.openCode.refreshModels" })}
        </Button>
      </div>
      {catalog?.status === "available" ? (
        catalog.models.length > 0 ? (
          <ul className="max-h-40 space-y-1 overflow-auto text-ui-sm text-foreground-subtle">
            {catalog.models.map((model) => (
              <li key={model} className="break-all">
                {model}
              </li>
            ))}
          </ul>
        ) : (
          <p role="status" className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.openCode.noCliModels" })}
          </p>
        )
      ) : null}
      {catalog?.status !== "available" && catalog ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.openCode.modelsUnavailable" })}
        </p>
      ) : null}
    </div>
  );
}
