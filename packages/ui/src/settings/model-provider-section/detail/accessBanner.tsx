import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodingPlanStatus } from "../constants.js";

export function CodingPlanAccessBanner({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="text-ui-base font-medium text-foreground">{title}</div>
      <p className="mt-1 text-ui-sm leading-6 text-foreground-subtle">{description}</p>
    </div>
  );
}

export function resolveCodingPlanAccessBanner(
  status: CodingPlanStatus,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  reloginOnFailure = false,
): { title: string; description: string } | null {
  if (
    status !== "disconnected" &&
    status !== "notPurchased" &&
    !(status === "unavailable" && reloginOnFailure)
  ) {
    return null;
  }
  return {
    title: intl.formatMessage({
      id: `settings.modelProvider.codingPlan.status.${status}`,
    }),
    description: intl.formatMessage({
      id:
        status === "unavailable" && reloginOnFailure
          ? "settings.modelProvider.codingPlan.description.credentialFailed"
          : `settings.modelProvider.codingPlan.description.${status}`,
    }),
  };
}
