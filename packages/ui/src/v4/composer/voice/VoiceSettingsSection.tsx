import { useEffect, useMemo, useRef } from "react";
import { DownloadIcon, MicIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { useVoiceDictation } from "./useVoiceDictation.js";

function formatBytes(value: number | null): string {
  if (!value || value <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unit]}`;
}

function VoiceSettingsSectionImpl() {
  const { intl } = useZCodeIntl();
  const api = useVoiceDictation();
  const { state } = api;
  const refreshedRef = useRef(false);
  useEffect(() => {
    if (refreshedRef.current) return;
    refreshedRef.current = true;
    // Refresh once when the section opens; later downloads update the same catalog.
    void api.refreshModels();
  }, [api]);

  const languages = useMemo(() => {
    const values = new Set<string>(state.language ? [state.language] : []);
    for (const model of state.models) {
      for (const language of model.languages) values.add(language);
    }
    return [...values].sort();
  }, [state.language, state.models]);
  const selected = state.models.find((model) => model.id === state.modelId);
  const progress = state.progress;
  const busy = progress !== null;

  if (!state.available) {
    return (
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "chat.voice.unavailable" })}
          description={state.error ?? state.reason ?? undefined}
          control={<MicIcon className="size-4 text-foreground-subtle" aria-hidden />}
        />
      </SettingsGroupCard>
    );
  }

  return (
    <div className="space-y-4" data-testid="voice-settings-section">
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "chat.voice.language" })}
          description={intl.formatMessage({ id: "settings.voice.description" })}
          control={
            <select
              className="h-8 w-full rounded-md border border-border bg-background px-2 text-ui-base"
              value={state.language}
              onChange={(event) => api.selectLanguage(event.target.value)}
            >
              {languages.map((language) => (
                <option key={language} value={language}>
                  {language}
                </option>
              ))}
            </select>
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "chat.voice.model" })}
          description={
            selected
              ? `${selected.name}${selected.streams ? " · live" : ""}${
                  selected.downloadBytes ? ` · ${formatBytes(selected.downloadBytes)}` : ""
                }`
              : intl.formatMessage({ id: "chat.voice.noModels" })
          }
          control={
            <div className="flex items-center justify-end gap-2">
              <select
                className="h-8 max-w-[220px] rounded-md border border-border bg-background px-2 text-ui-base"
                value={state.modelId ?? ""}
                onChange={(event) => api.selectModel(event.target.value)}
              >
                {state.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                    {model.installed ? " ✓" : ""}
                  </option>
                ))}
              </select>
              {selected && !selected.installed ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void api.prepareModel(selected.id, state.language)}
                >
                  <DownloadIcon className="size-3.5" aria-hidden />
                  {intl.formatMessage({ id: "chat.voice.download" })}
                </Button>
              ) : null}
            </div>
          }
          detail={
            progress ? (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-ui-xs text-foreground-subtle">
                  <span>{progress.stage}</span>
                  <span>
                    {progress.totalBytes > 0
                      ? `${Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))}%`
                      : ""}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full rounded-full bg-foreground transition-[width]"
                    style={{
                      width:
                        progress.totalBytes > 0
                          ? `${Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))}%`
                          : "0%",
                    }}
                  />
                </div>
              </div>
            ) : undefined
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.voice.shortcut" })}
          description={intl.formatMessage({ id: "settings.voice.localOnly" })}
          control={<span className="text-ui-base text-foreground-subtle">⌥</span>}
        />
      </SettingsGroupCard>
      {state.error ? (
        <p className="text-ui-base text-[var(--color-danger)]">{state.error}</p>
      ) : null}
    </div>
  );
}

function VoiceSettingsUnavailable() {
  const { intl } = useZCodeIntl();
  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "chat.voice.unavailable" })}
        control={<MicIcon className="size-4 text-foreground-subtle" aria-hidden />}
      />
    </SettingsGroupCard>
  );
}

export function VoiceSettingsSection() {
  const platform = useOptionalPlatform();
  if (!platform?.voiceDictation) return <VoiceSettingsUnavailable />;
  return <VoiceSettingsSectionImpl />;
}
