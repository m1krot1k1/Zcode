// StatusCards 拆分：模型服务商区块的无状态卡片外壳与占位展示。
import { Loader2Icon } from "lucide-react";
import type { ReactNode } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function PlanStatusCardSurface({
  planTitle,
  titleAccessory,
  statusMeta,
  trailingAction,
  usageContent,
}: {
  planTitle: string;
  titleAccessory?: ReactNode;
  statusMeta: ReactNode;
  trailingAction?: ReactNode;
  usageContent?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex min-w-0 items-center justify-between gap-3 max-sm:flex-col max-sm:items-stretch">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <h3 className="min-w-0 truncate text-ui-lg font-semibold leading-5 text-foreground">
              {planTitle}
            </h3>
            {titleAccessory}
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {statusMeta}
          </div>
        </div>
        {trailingAction ? (
          <div className="shrink-0 max-sm:flex max-sm:w-full max-sm:[&>button]:w-full">
            {trailingAction}
          </div>
        ) : null}
      </div>
      {usageContent ? (
        <>
          <div className="my-4 border-t border-border" />
          {usageContent}
        </>
      ) : null}
    </div>
  );
}

export function ModelProviderLoadingCard({ loadingLabel }: { loadingLabel: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3">
      <div className="flex items-center gap-2 text-ui-base text-foreground-subtle">
        <Loader2Icon className="size-4 animate-spin" />
        <span>{loadingLabel}</span>
      </div>
    </div>
  );
}

export function PresetProviderPlaceholderCard({
  displayName,
  messageId = "settings.modelProvider.presetEmpty",
}: {
  displayName: string;
  messageId?: string;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="bg-background/50 rounded-2xl p-3">
      <div className="text-ui-lg font-semibold text-foreground">{displayName}</div>
      <div className="mt-1 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: messageId })}
      </div>
    </div>
  );
}
