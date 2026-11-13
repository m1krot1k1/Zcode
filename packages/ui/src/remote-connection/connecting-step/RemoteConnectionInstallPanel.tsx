import type { RemoteTarget } from "@zcode/shared";
import { AlertTriangleIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { RemoteConnectionInstallConfirmation } from "@/remote-connection/connecting-step/types.js";

/** 安装确认是阶段内的中性信息面板，圆角比所属阶段行低一级。 */
export function RemoteConnectionInstallPanel({
  confirmation,
}: {
  confirmation: RemoteConnectionInstallConfirmation;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="mt-2 flex items-start gap-3 rounded-sm border border-border bg-background px-3.5 py-3 text-ui-sm text-foreground">
      <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="font-medium">
          {intl.formatMessage({ id: "remote.sourceServerInstallTitle" })}
        </p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-ui-xs">
          <dt className="text-remote-foreground-muted">
            {intl.formatMessage({ id: "remote.installTarget" })}
          </dt>
          <dd className="font-mono">{formatInstallTarget(confirmation.target)}</dd>
          <dt className="text-remote-foreground-muted">
            {intl.formatMessage({ id: "remote.installVersion" })}
          </dt>
          <dd className="font-mono" data-testid="remote-install-version">
            {confirmation.preview?.version ?? intl.formatMessage({ id: "remote.infoUnavailable" })}
          </dd>
          <dt className="text-remote-foreground-muted">
            {intl.formatMessage({ id: "remote.installLocation" })}
          </dt>
          <dd className="break-all font-mono" data-testid="remote-install-path">
            {confirmation.preview?.installPath ??
              intl.formatMessage({ id: "remote.infoUnavailable" })}
          </dd>
          <dt className="text-remote-foreground-muted">
            {intl.formatMessage({ id: "remote.installSize" })}
          </dt>
          <dd className="font-mono">
            {confirmation.preview
              ? `${(confirmation.preview.sizeBytes / 1048576).toFixed(1)} MB`
              : intl.formatMessage({ id: "remote.infoUnavailable" })}
          </dd>
        </dl>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button type="button" size="sm" onClick={confirmation.onConfirm}>
            {intl.formatMessage({
              id: "remote.sourceServerInstallConfirm",
            })}
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={confirmation.onCancel}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
        </div>
      </div>
    </div>
  );
}

// 原型安装确认表格「目标账号」列直接展示 user@host:port，不再包整句文案。
function formatInstallTarget(target: RemoteTarget): string {
  if (target.kind === "ssh") {
    return `${target.username}@${target.host}:${target.port ?? 22}`;
  }
  if (target.kind === "wsl")
    return ["WSL", target.distro ?? "default", target.user].filter(Boolean).join(" · ");
  if (target.kind === "docker") return `Docker · ${target.container}`;
  return target.url;
}
