import { useEffect, useMemo, useState } from "react";
import { Loader2, MicIcon, Settings2Icon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { useVoiceDictation, type VoiceDictationApi } from "./useVoiceDictation.js";

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

function useElapsed(startedAt: number | null): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!startedAt) {
      setElapsed(0);
      return;
    }
    setElapsed(Date.now() - startedAt);
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 500);
    return () => clearInterval(timer);
  }, [startedAt]);
  return elapsed;
}

function VoiceDictationButtonImpl({ disabled }: { disabled: boolean }) {
  const intl = useZCodeIntl().intl;
  const api = useVoiceDictation();
  const { state } = api;
  if (!state.available) return null;
  const busy = state.status === "starting" || state.status === "stopping";
  const listening = state.status === "listening";
  const selected = state.models.find((model) => model.id === state.modelId);
  const label = listening
    ? intl.formatMessage({ id: "chat.voice.stop" })
    : intl.formatMessage({ id: "chat.voice.start" });
  const tooltip =
    listening || busy ? label : `${label} · ${intl.formatMessage({ id: "chat.voice.hint" })}`;
  const onClick = () => {
    if (listening) {
      void api.stop();
      return;
    }
    if (busy) return;
    if (!selected) {
      void api.start();
      return;
    }
    if (!selected.installed) {
      api.setSettingsOpen(true);
      return;
    }
    void api.start();
  };
  return (
    <ControlHintTooltip title={tooltip}>
      <Button
        type="button"
        variant={listening ? "secondary" : "ghost"}
        size="default"
        data-testid="voice-dictation-trigger"
        data-state={state.status}
        data-mode={state.mode ?? undefined}
        aria-label={label}
        aria-pressed={listening}
        disabled={disabled || busy}
        onClick={onClick}
        className={cn(
          "group/voice h-7 w-fit justify-center gap-1 rounded-lg px-1.5 py-1.5 text-ui-base",
          "data-[composer-compact=true]:size-7 data-[composer-compact=true]:gap-0 data-[composer-compact=true]:p-0",
          listening && "text-[var(--color-danger)]",
        )}
      >
        {busy ? (
          <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
        ) : listening ? (
          <SquareIcon className="size-3.5 shrink-0 fill-current" aria-hidden />
        ) : (
          <MicIcon className="size-4 shrink-0" aria-hidden />
        )}
        <span
          className="inline-flex whitespace-nowrap group-data-[composer-compact=true]/voice:hidden"
          data-voice-label
        >
          {label}
        </span>
      </Button>
    </ControlHintTooltip>
  );
}

export function VoiceDictationButton({ disabled = false }: { disabled?: boolean }) {
  const platform = useOptionalPlatform();
  if (!platform?.voiceDictation) return null;
  return <VoiceDictationButtonImpl disabled={disabled} />;
}

function VoiceSettingsDialog({ api }: { api: VoiceDictationApi }) {
  const intl = useZCodeIntl().intl;
  const { state } = api;
  const selected = state.models.find((model) => model.id === state.modelId);
  const languages = selected?.languages ?? [];
  const progress = state.progress;
  return (
    <Dialog open={state.settingsOpen} onOpenChange={(open) => api.setSettingsOpen(open)}>
      <DialogContent className="max-w-xl" data-testid="voice-dictation-settings">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "chat.voice.settings" })}</DialogTitle>
          <DialogDescription>{intl.formatMessage({ id: "chat.voice.hint" })}</DialogDescription>
        </DialogHeader>
        {!state.available ? (
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "chat.voice.unavailable" })}
          </p>
        ) : (
          <div className="space-y-4">
            <label className="block space-y-1 text-ui-base">
              <span className="text-foreground-subtle">
                {intl.formatMessage({ id: "chat.voice.language" })}
              </span>
              <select
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-ui-base"
                value={state.language}
                onChange={(event) => api.selectLanguage(event.target.value)}
              >
                {languages.length === 0 ? (
                  <option value={state.language}>{state.language}</option>
                ) : (
                  languages.map((language) => (
                    <option key={language} value={language}>
                      {language}
                    </option>
                  ))
                )}
              </select>
            </label>
            <div className="space-y-2">
              <div className="text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "chat.voice.model" })}
              </div>
              {state.models.length === 0 ? (
                <p className="text-ui-base text-foreground-subtle">
                  {intl.formatMessage({ id: "chat.voice.noModels" })}
                </p>
              ) : (
                <ul className="max-h-80 space-y-2 overflow-y-auto">
                  {state.models.map((model) => {
                    const active = model.id === state.modelId;
                    return (
                      <li
                        key={model.id}
                        className={cn(
                          "flex items-center gap-3 rounded-lg border px-3 py-2",
                          active ? "border-foreground/30 bg-surface-raised" : "border-border",
                        )}
                      >
                        <button
                          type="button"
                          className="min-w-0 flex-1 text-left"
                          onClick={() => api.selectModel(model.id)}
                        >
                          <div className="flex items-center gap-2 text-ui-base text-foreground">
                            <span className="truncate">{model.name}</span>
                            {model.streams ? (
                              <span className="rounded-full border border-border px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
                                live
                              </span>
                            ) : null}
                          </div>
                          <div className="text-ui-xs text-foreground-subtle">
                            {model.languages.slice(0, 8).join(", ")}
                            {model.languages.length > 8 ? "…" : ""}
                            {model.downloadBytes ? ` · ${formatBytes(model.downloadBytes)}` : ""}
                          </div>
                        </button>
                        {model.installed ? (
                          <span className="text-ui-xs text-foreground-subtle">
                            {intl.formatMessage({ id: "chat.voice.downloaded" })}
                          </span>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={progress?.modelId === model.id}
                            onClick={() => {
                              api.selectModel(model.id);
                              void api.prepareModel(model.id, state.language);
                            }}
                          >
                            {progress?.modelId === model.id
                              ? intl.formatMessage({ id: "chat.voice.downloading" })
                              : intl.formatMessage({ id: "chat.voice.download" })}
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            {progress ? (
              <div className="space-y-1 text-ui-xs text-foreground-subtle">
                <div className="flex items-center justify-between">
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
            ) : null}
            {state.error ? (
              <p className="text-ui-base text-[var(--color-danger)]">{state.error}</p>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function VoiceDictationOverlayImpl() {
  const intl = useZCodeIntl().intl;
  const api = useVoiceDictation();
  const { state } = api;
  const elapsed = useElapsed(state.startedAt);
  const active = state.status !== "idle" || state.settingsOpen;
  const model = useMemo(
    () => state.models.find((item) => item.id === state.modelId),
    [state.modelId, state.models],
  );
  if (!active) return null;
  const listening = state.status === "listening";
  const hint =
    state.mode === "streaming"
      ? intl.formatMessage({ id: "chat.voice.streamingHint" })
      : state.mode === "rolling"
        ? intl.formatMessage({ id: "chat.voice.rollingHint" })
        : null;
  const bars = [0.35, 0.6, 0.9, 0.55, 0.4];
  return (
    <>
      <div
        className="fixed left-1/2 top-4 z-50 flex w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-surface-raised px-3 py-2 shadow-lg"
        data-testid="voice-dictation-overlay"
        data-state={state.status}
      >
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            listening ? "animate-pulse bg-[var(--color-danger)]" : "bg-foreground-subtle",
          )}
          aria-hidden
        />
        <div className="flex min-w-[96px] items-center gap-0.5" aria-hidden>
          {bars.map((base, index) => (
            <span
              key={index}
              className="w-1 rounded-full bg-current text-foreground-subtle transition-[height]"
              style={{ height: `${Math.max(3, Math.round(base * state.level * 18))}px` }}
            />
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui-base text-foreground">
            {state.status === "error"
              ? state.error?.includes("NotAllowed") ||
                state.error?.includes("Permission") ||
                state.error?.includes("denied")
                ? intl.formatMessage({ id: "chat.voice.microphoneDenied" })
                : state.error
              : listening
                ? intl.formatMessage({ id: "chat.voice.listening" })
                : state.status === "starting"
                  ? intl.formatMessage({ id: "chat.voice.start" })
                  : intl.formatMessage({ id: "chat.voice.stop" })}
          </div>
          <div className="truncate text-ui-xs text-foreground-subtle">
            {model?.name ?? state.modelId}
            {hint ? ` · ${hint}` : ""}
          </div>
        </div>
        <span className="text-ui-xs tabular-nums text-foreground-subtle">
          {Math.floor(elapsed / 1000)}s
        </span>
        <ControlHintTooltip title={intl.formatMessage({ id: "chat.voice.settings" })}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={intl.formatMessage({ id: "chat.voice.settings" })}
            onClick={() => api.setSettingsOpen(true)}
          >
            <Settings2Icon className="size-4" aria-hidden />
          </Button>
        </ControlHintTooltip>
        {listening || state.status === "starting" || state.status === "stopping" ? (
          <>
            <Button type="button" size="sm" variant="outline" onClick={() => void api.cancel()}>
              {intl.formatMessage({ id: "chat.voice.cancel" })}
            </Button>
            <Button type="button" size="sm" onClick={() => void api.stop()}>
              {intl.formatMessage({ id: "chat.voice.stop" })}
            </Button>
          </>
        ) : null}
      </div>
      <VoiceSettingsDialog api={api} />
    </>
  );
}

export function VoiceDictationOverlay() {
  const platform = useOptionalPlatform();
  if (!platform?.voiceDictation) return null;
  return <VoiceDictationOverlayImpl />;
}
