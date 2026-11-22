import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  getCursorInstallCommand,
  isCursorHostUnavailable,
  summarizeCursorModels,
  type CursorAgentCliStatus,
  type CursorAgentModelCatalog,
} from "./contract.js";

function statusMessage(
  status: CursorAgentCliStatus | undefined,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
) {
  if (!status) return intl.formatMessage({ id: "settings.cursor.checking" });
  if (status.status === "available") {
    return intl.formatMessage({ id: "settings.cursor.available" }, { version: status.version });
  }
  if (isCursorHostUnavailable(status)) {
    return intl.formatMessage({ id: "settings.cursor.hostUnavailable" });
  }
  if (status.status === "missing") {
    return intl.formatMessage({ id: "settings.cursor.missing" });
  }
  if (status.status === "timed-out") {
    return intl.formatMessage({ id: "settings.cursor.timed-out" });
  }
  return intl.formatMessage({ id: "settings.cursor.unavailable" });
}

/**
 * Cursor CLI provider settings.
 *
 * Enablement is a persisted preference; the Host still owns binary discovery and the model catalog,
 * so the panel never starts the CLI itself and never fabricates model entries.
 */
export function CursorAgentSettingsPanel({
  enabled,
  onEnabledChange,
  onInstalled,
}: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void | Promise<void>;
  /** Отражает установку в Provider Registry до включения провайдера. */
  onInstalled?: () => void | Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const runtime = useServices().cursorCliRuntime;
  const [cliStatus, setCliStatus] = useState<CursorAgentCliStatus>();
  const [modelCatalog, setModelCatalog] = useState<CursorAgentModelCatalog>();
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [savingEnabled, setSavingEnabled] = useState(false);
  const [optimisticEnabled, setOptimisticEnabled] = useState<boolean>();
  const [diagnostic, setDiagnostic] = useState("");
  const displayedEnabled = optimisticEnabled ?? enabled;

  useEffect(() => {
    if (optimisticEnabled === enabled) setOptimisticEnabled(undefined);
  }, [enabled, optimisticEnabled]);

  const checkCli = useCallback(async () => {
    if (!runtime) {
      setCliStatus({
        status: "unavailable",
        diagnostic: "cursor.host-unavailable",
        installCommand: "",
      });
      setModelCatalog(undefined);
      return;
    }
    setChecking(true);
    setDiagnostic("");
    try {
      const nextStatus = await runtime.getCliStatus();
      setCliStatus(nextStatus);
      if (nextStatus.status !== "available") {
        setModelCatalog(undefined);
        return;
      }
      try {
        setModelCatalog(await runtime.listModels());
      } catch {
        // Каталог не влияет на доступность бинаря: показываем отдельную диагностику списка.
        setModelCatalog({ status: "unavailable", diagnostic: "cursor.catalog-check-failed" });
      }
    } catch {
      setCliStatus({
        status: "unavailable",
        diagnostic: "cursor.cli-check-failed",
        installCommand: "",
      });
      setModelCatalog(undefined);
    } finally {
      setChecking(false);
    }
  }, [runtime]);

  useEffect(() => {
    void checkCli();
  }, [checkCli]);

  const handleEnabledChange = useCallback(
    async (nextEnabled: boolean) => {
      setOptimisticEnabled(nextEnabled);
      setSavingEnabled(true);
      setDiagnostic("");
      try {
        await onEnabledChange(nextEnabled);
      } catch {
        setOptimisticEnabled(undefined);
        setDiagnostic(intl.formatMessage({ id: "settings.cursor.setting-save-failed" }));
      } finally {
        setSavingEnabled(false);
      }
    },
    [intl, onEnabledChange],
  );

  const handleInstall = useCallback(async () => {
    if (!runtime) return;
    setInstalling(true);
    setDiagnostic("");
    try {
      const result = await runtime.installCli();
      if (result.status === "failed") {
        const id =
          result.diagnostic === "install-timeout"
            ? "settings.cursor.installTimeout"
            : result.diagnostic === "install-verification-failed"
              ? "settings.cursor.installVerificationFailed"
              : result.diagnostic === "install-platform-unsupported"
                ? "settings.cursor.installUnsupported"
                : "settings.cursor.installFailed";
        setDiagnostic(intl.formatMessage({ id }));
        return;
      }
      await checkCli();
      await onInstalled?.();
      if (!displayedEnabled) await handleEnabledChange(true);
    } catch {
      setDiagnostic(intl.formatMessage({ id: "settings.cursor.installFailed" }));
    } finally {
      setInstalling(false);
    }
  }, [checkCli, displayedEnabled, handleEnabledChange, intl, onInstalled, runtime]);

  const busy = checking || savingEnabled || installing;
  const canInstall =
    Boolean(runtime) &&
    cliStatus != null &&
    !isCursorHostUnavailable(cliStatus) &&
    (cliStatus.status === "missing" || cliStatus.status === "unavailable");
  const installCommand = getCursorInstallCommand(cliStatus);
  const modelSummary = summarizeCursorModels(modelCatalog);

  return (
    <section
      aria-labelledby="local-cursor-agent-title"
      className="mb-4 space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5"
      data-testid="cursor-agent-settings"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 id="local-cursor-agent-title" className="text-ui-settings-title font-semibold">
            {intl.formatMessage({ id: "settings.cursor.title" })}
          </h2>
          <p aria-live="polite" className="text-ui-base text-foreground-subtle">
            {statusMessage(cliStatus, intl)}
          </p>
        </div>
        <Switch
          aria-label={intl.formatMessage({ id: "settings.cursor.enable" })}
          checked={displayedEnabled}
          // 开关只保存用户偏好；Host 仍要在发布 cursor provider 前验证 CLI 和目录。
          disabled={busy || !runtime}
          onCheckedChange={(nextEnabled) => void handleEnabledChange(nextEnabled)}
          data-testid="cursor-cli-enabled-switch"
        />
      </div>

      {cliStatus && cliStatus.status !== "available" ? (
        <p
          className="break-all font-mono text-ui-xs text-foreground-subtle"
          data-testid="cursor-cli-diagnostic"
        >
          {cliStatus.diagnostic}
        </p>
      ) : null}

      {installCommand ? (
        <div className="space-y-1">
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.cursor.installHint" })}
          </p>
          <code
            className="block break-all rounded-md border border-border bg-muted px-2 py-1 font-mono text-ui-sm"
            data-testid="cursor-cli-install-command"
          >
            {installCommand}
          </code>
        </div>
      ) : null}

      {cliStatus?.status === "available" ? (
        <div className="space-y-1" data-testid="cursor-cli-models">
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.cursor.modelsTitle" })}
          </p>
          {modelSummary ? (
            modelSummary.count > 0 ? (
              <>
                <p className="text-ui-sm text-foreground-subtle">
                  {intl.formatMessage(
                    { id: "settings.cursor.modelsCount" },
                    { count: modelSummary.count },
                  )}
                </p>
                <ul className="flex flex-wrap gap-x-3 gap-y-1 text-ui-sm text-foreground-subtle">
                  {modelSummary.names.map((name, index) => (
                    <li key={`${modelSummary.modelIds[index]}:${index}`}>{name}</li>
                  ))}
                </ul>
                {modelSummary.includesBaseline ? (
                  <p className="text-ui-xs text-foreground-subtle">
                    {intl.formatMessage({ id: "settings.cursor.modelsBaseline" })}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "settings.cursor.noModels" })}
              </p>
            )
          ) : modelCatalog ? (
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "settings.cursor.modelsUnavailable" })}
            </p>
          ) : checking ? (
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "settings.cursor.checking" })}
            </p>
          ) : null}
        </div>
      ) : null}

      {diagnostic ? (
        <p role="alert" className="text-ui-base text-destructive">
          {diagnostic}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {canInstall ? (
          <Button
            type="button"
            size="sm"
            onClick={() => void handleInstall()}
            disabled={busy}
            data-testid="cursor-cli-install"
          >
            {installing
              ? intl.formatMessage({ id: "settings.cursor.installing" })
              : intl.formatMessage({ id: "settings.cursor.install" })}
          </Button>
        ) : null}
        {runtime ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void checkCli()}
            disabled={busy}
            data-testid="cursor-cli-recheck"
          >
            {checking
              ? intl.formatMessage({ id: "settings.cursor.checking" })
              : intl.formatMessage({ id: "settings.cursor.recheck" })}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
