import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { OpenCodeAgentPermissionRequest } from "./contract.js";

export function OpenCodePermissionRequests({
  requests,
  respondingRequestIds,
  onRespond,
}: {
  requests: OpenCodeAgentPermissionRequest[];
  respondingRequestIds: Set<string>;
  onRespond: (request: OpenCodeAgentPermissionRequest, optionId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  if (requests.length === 0) return null;

  return (
    <section
      aria-labelledby="opencode-permission-title"
      className="space-y-3 rounded-lg border border-warning/40 bg-warning/5 p-3"
      data-testid="opencode-permission-requests"
    >
      <h3 id="opencode-permission-title" className="text-ui-base font-semibold">
        {intl.formatMessage({ id: "settings.openCode.permission.title" })}
      </h3>
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.openCode.permission.scope" })}
      </p>
      {requests.map((request) => (
        <div
          key={request.requestId}
          className="space-y-2 rounded-md border border-border bg-background p-3"
          data-testid={`opencode-permission-${request.requestId}`}
        >
          <p className="text-ui-base font-medium">{request.toolTitle}</p>
          {request.toolKind ? (
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.openCode.permission.kind" })}: {request.toolKind}
            </p>
          ) : null}
          {request.inputSummary ? (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-ui-base">
              {request.inputSummary}
            </pre>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {request.options.map((option) => (
              <div key={option.optionId} className="space-y-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onRespond(request, option.optionId)}
                  disabled={respondingRequestIds.has(request.requestId)}
                >
                  {option.name || option.kind}
                </Button>
                <p className="text-ui-xs text-foreground-subtle">
                  {intl.formatMessage(
                    { id: "settings.openCode.permission.optionKind" },
                    { kind: option.kind },
                  )}
                </p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
