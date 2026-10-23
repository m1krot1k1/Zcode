import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { OpenCodeAgentCliStatus } from "./contract.js";

function statusMessage(
  status: OpenCodeAgentCliStatus | undefined,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
) {
  if (!status) return intl.formatMessage({ id: "settings.openCode.checking" });
  if (status.status === "available") {
    return intl.formatMessage({ id: "settings.openCode.available" }, { version: status.version });
  }
  if (status.status === "missing") {
    if (status.installSupported === false) {
      return intl.formatMessage({
        id: "settings.openCode.install-platform-unsupported",
      });
    }
    return intl.formatMessage({ id: "settings.openCode.missing" });
  }
  if (status.diagnostic === "opencode.windows-cli-shim-unsupported") {
    return intl.formatMessage({
      id: "settings.openCode.windowsShimUnsupported",
    });
  }
  if (
    status.diagnostic === "opencode.explicit-cli-unavailable" ||
    status.diagnostic === "opencode.explicit-cli-path-must-be-absolute" ||
    status.diagnostic === "opencode.windows-native-cli-required"
  ) {
    return intl.formatMessage({
      id: "settings.openCode.explicitCliUnavailable",
    });
  }
  if (status.installSupported === false) {
    return intl.formatMessage({
      id: "settings.openCode.install-platform-unsupported",
    });
  }
  if (status.status === "timed-out") {
    return intl.formatMessage({ id: "settings.openCode.timed-out" });
  }
  return intl.formatMessage({ id: "settings.openCode.unavailable" });
}

function installDiagnosticMessageId(code: string) {
  const allowed = new Set([
    "install-failed",
    "install-download-failed",
    "install-archive-invalid",
    "install-integrity-failed",
    "install-write-failed",
    "install-timeout",
    "install-destination-conflict",
    "install-verification-failed",
    "install-requires-missing-cli",
    "install-platform-unsupported",
  ]);
  const suffix = code.startsWith("opencode.") ? code.slice("opencode.".length) : code;
  return allowed.has(suffix) ? `settings.openCode.${suffix}` : "settings.openCode.install-failed";
}

export function OpenCodeAgentSettingsPanel({
  enabled,
  onEnabledChange,
}: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void | Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const runtime = useServices().openCodeAcpRuntime;
  const [cliStatus, setCliStatus] = useState<OpenCodeAgentCliStatus>();
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
        diagnostic: "opencode.host-unavailable",
        installSupported: false,
      });
      return;
    }
    setChecking(true);
    setDiagnostic("");
    try {
      setCliStatus(await runtime.getCliStatus());
    } catch {
      setCliStatus({
        status: "unavailable",
        diagnostic: "opencode.cli-check-failed",
      });
    } finally {
      setChecking(false);
    }
  }, [runtime]);

  useEffect(() => {
    void checkCli();
  }, [checkCli]);

  const install = useCallback(async () => {
    if (!runtime || cliStatus?.status !== "missing" || cliStatus.installSupported === false) {
      return;
    }
    setInstalling(true);
    setDiagnostic("");
    try {
      const result = await runtime.installCli();
      if (result.status === "failed") {
        setDiagnostic(
          intl.formatMessage({
            id: installDiagnosticMessageId(result.diagnostic),
          }),
        );
        return;
      }
      // The installer result is not enough: re-discover the executable before showing it as ready.
      const verified = await runtime.getCliStatus();
      setCliStatus(verified);
      if (verified.status === "available") {
        // Install is the action used after the disabled switch reports a missing CLI.
        // Once the binary is verified, finish that original intent automatically.
        await onEnabledChange(true);
      } else {
        setDiagnostic(
          intl.formatMessage({
            id: "settings.openCode.install-verification-failed",
          }),
        );
      }
    } catch {
      setDiagnostic(intl.formatMessage({ id: "settings.openCode.install-failed" }));
    } finally {
      setInstalling(false);
    }
  }, [cliStatus, intl, onEnabledChange, runtime]);

  const handleEnabledChange = useCallback(
    async (nextEnabled: boolean) => {
      setOptimisticEnabled(nextEnabled);
      setSavingEnabled(true);
      setDiagnostic("");
      try {
        await onEnabledChange(nextEnabled);
      } catch {
        setOptimisticEnabled(undefined);
        setDiagnostic(intl.formatMessage({ id: "settings.openCode.setting-save-failed" }));
      } finally {
        setSavingEnabled(false);
      }
    },
    [intl, onEnabledChange],
  );

  const busy = checking || installing || savingEnabled;
  const canInstall =
    cliStatus?.status === "missing" && cliStatus.installSupported !== false && Boolean(runtime);

  return (
    <section
      aria-labelledby="local-opencode-agent-title"
      className="mb-4 space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5"
      data-testid="opencode-agent-settings"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 id="local-opencode-agent-title" className="text-ui-settings-title font-semibold">
            {intl.formatMessage({ id: "settings.openCode.title" })}
          </h2>
          <p aria-live="polite" className="text-ui-base text-foreground-subtle">
            {statusMessage(cliStatus, intl)}
          </p>
        </div>
        <Switch
          aria-label={intl.formatMessage({ id: "settings.openCode.enable" })}
          checked={displayedEnabled}
          disabled={busy || !runtime || (!enabled && cliStatus?.status !== "available")}
          onCheckedChange={(nextEnabled) => void handleEnabledChange(nextEnabled)}
          data-testid="opencode-cli-enabled-switch"
        />
      </div>

      {canInstall ? (
        <Button
          type="button"
          size="sm"
          onClick={() => void install()}
          disabled={busy}
          data-testid="opencode-cli-install"
        >
          {installing
            ? intl.formatMessage({ id: "settings.openCode.installing" })
            : intl.formatMessage({ id: "settings.openCode.install" })}
        </Button>
      ) : null}

      {diagnostic ? (
        <p role="alert" className="text-ui-base text-destructive">
          {diagnostic}
        </p>
      ) : null}

      {(cliStatus?.status === "unavailable" || cliStatus?.status === "timed-out") && runtime ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void checkCli()}
          disabled={busy}
        >
          {intl.formatMessage({ id: "common.retry" })}
        </Button>
      ) : null}
    </section>
  );
}
