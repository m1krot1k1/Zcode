import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Check, LoaderCircle, Plus, ShieldOff, Trash2 } from "lucide-react";
import type {
  ZCodeUncensoredModelEntry,
  ZCodeUncensoredProviderStatus,
  ZCodeUncensoredProviderWrite,
  ZCodeUncensoredSettingsStatus,
  ZCodeUncensoredSettingsWrite,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { UncensoredModelChatPanel } from "./UncensoredModelChatPanel.js";
import { useUncensoredModelChat } from "./useUncensoredModelChat.js";

/** Workspace identity for the Host-owned uncensored settings record. */
export interface UncensoredModelSettingsWorkspaceRef {
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * Structural port for the Host-owned settings service.
 * UI не импортирует реализацию `packages/services`: Environment передаёт сюда
 * сервис из IServiceAccessor, совместимый по форме.
 */
export interface UncensoredModelSettingsPort {
  getConfig(
    workspace: UncensoredModelSettingsWorkspaceRef,
  ): Promise<ZCodeUncensoredSettingsStatus>;
  updateConfig(
    workspace: UncensoredModelSettingsWorkspaceRef,
    write: ZCodeUncensoredSettingsWrite,
  ): Promise<ZCodeUncensoredSettingsStatus>;
  sendMessage(
    workspace: UncensoredModelSettingsWorkspaceRef,
    input: { providerId: string; modelId: string; text: string },
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
}

export const UNCENSORED_PROVIDERS_LIMIT = 20;
export const UNCENSORED_MODELS_LIMIT = 50;

interface ModelRow {
  /** Стабильный ключ строки: id может быть пустым или дублироваться во время правки. */
  uid: string;
  id: string;
  enabled: boolean;
}

interface ProviderRow {
  uid: string;
  /** Стабильный id провайдера; не редактируется пользователем. */
  id: string;
  name: string;
  apiUrl: string;
  /** Только черновик нового ключа; сохранённый ключ сюда не читается. */
  apiKey: string;
  apiKeyConfigured: boolean;
  models: ModelRow[];
  nameTouched: boolean;
  urlTouched: boolean;
}

let rowSequence = 0;

function nextUid(prefix: string): string {
  rowSequence += 1;
  return `${prefix}-${rowSequence}`;
}

function createModelRow(entry: ZCodeUncensoredModelEntry): ModelRow {
  return { uid: nextUid("uncensored-model-row"), id: entry.id, enabled: entry.enabled };
}

function createProviderRow(entry?: ZCodeUncensoredProviderStatus): ProviderRow {
  return {
    uid: nextUid("uncensored-provider-row"),
    id: entry?.id ?? `provider-${Date.now().toString(36)}-${nextUid("provider-id")}`,
    name: entry?.name ?? "",
    apiUrl: entry?.apiUrl ?? "",
    apiKey: "",
    apiKeyConfigured: entry?.apiKeyConfigured ?? false,
    models: entry?.models.map((model) => createModelRow(model)) ?? [],
    nameTouched: false,
    urlTouched: false,
  };
}

function isValidApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0 &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname !== "" &&
      url.pathname !== "/"
    );
  } catch {
    return false;
  }
}

function moveItem<T>(items: T[], index: number, delta: number): T[] {
  const target = index + delta;
  const current = items[index];
  const other = items[target];
  if (!current || !other) return items;
  const next = [...items];
  next[index] = other;
  next[target] = current;
  return next;
}

function duplicateModelIds(models: readonly ModelRow[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const model of models) {
    const id = model.id.trim();
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const duplicates = new Set<string>();
  for (const [id, count] of counts) {
    if (count > 1) duplicates.add(id);
  }
  return duplicates;
}

export function UncensoredModelSettings({
  port,
  workspaceRef,
}: {
  port?: UncensoredModelSettingsPort;
  workspaceRef?: UncensoredModelSettingsWorkspaceRef;
}) {
  const { intl } = useZCodeIntl();
  const copy = useCallback((id: string) => intl.formatMessage({ id }), [intl]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [busy, setBusy] = useState<"save" | `clear:${string}` | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const applyStatus = useCallback((next: ZCodeUncensoredSettingsStatus) => {
    // Возвращённый статус — единственный принятый источник: ключи очищаются и не читаются.
    setProviders(next.providers.map((provider) => createProviderRow(provider)));
    setSubmitAttempted(false);
  }, []);

  useEffect(() => {
    if (!port || !workspaceRef) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    void port
      .getConfig(workspaceRef)
      .then((next) => {
        if (!cancelled) applyStatus(next);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // Только краткая причина: секрет и тело ответа сюда не попадают.
        logger.warn("[UncensoredModelSettings] load failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyStatus, port, reloadToken, workspaceRef]);

  const providerErrors = useMemo(() => {
    const errors = new Map<
      string,
      { name: boolean; url: boolean; models: ReadonlyMap<string, "invalid" | "duplicate"> }
    >();
    for (const provider of providers) {
      const duplicates = duplicateModelIds(provider.models);
      const modelErrors = new Map<string, "invalid" | "duplicate">();
      for (const model of provider.models) {
        const id = model.id.trim();
        if (!id) modelErrors.set(model.uid, "invalid");
        else if (duplicates.has(id)) modelErrors.set(model.uid, "duplicate");
      }
      const url = provider.apiUrl.trim();
      errors.set(provider.uid, {
        name: provider.name.trim().length === 0,
        url: url === "" || !isValidApiUrl(url),
        models: modelErrors,
      });
    }
    return errors;
  }, [providers]);

  const hasValidationErrors = useMemo(
    () =>
      providers.some((provider) => {
        const error = providerErrors.get(provider.uid);
        return Boolean(error && (error.name || error.url || error.models.size > 0));
      }),
    [providerErrors, providers],
  );

  const buildWrite = useCallback(
    (keyOverrides?: ReadonlyMap<string, string | null>): ZCodeUncensoredSettingsWrite => ({
      providers: providers.map((provider) => {
        const entry: ZCodeUncensoredProviderWrite = {
          id: provider.id,
          name: provider.name.trim(),
          apiUrl: provider.apiUrl.trim(),
          // order = fallback order: отправляем ровно текущий порядок провайдеров и моделей.
          models: provider.models.map((model) => ({
            id: model.id.trim(),
            enabled: model.enabled,
          })),
        };
        const override = keyOverrides?.get(provider.uid);
        if (override !== undefined) {
          entry.apiKey = override;
        } else {
          const trimmedKey = provider.apiKey.trim();
          // Пустое поле сохраняет текущий секрет: ключ не отправляется вовсе.
          if (trimmedKey !== "") entry.apiKey = trimmedKey;
        }
        return entry;
      }),
    }),
    [providers],
  );

  const persist = useCallback(
    async (
      keyOverrides: ReadonlyMap<string, string | null> | undefined,
      busyState: "save" | `clear:${string}`,
      okMessageId: string,
    ) => {
      if (!port || !workspaceRef || busy !== null) return;
      setSubmitAttempted(true);
      if (hasValidationErrors) return;
      setBusy(busyState);
      setMessage(null);
      try {
        const next = await port.updateConfig(workspaceRef, buildWrite(keyOverrides));
        applyStatus(next);
        setMessage({ ok: true, text: copy(okMessageId) });
      } catch (error: unknown) {
        logger.warn("[UncensoredModelSettings] save failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        setMessage({ ok: false, text: copy("settings.uncensored.saveFailed") });
      } finally {
        setBusy(null);
      }
    },
    [applyStatus, buildWrite, busy, copy, hasValidationErrors, port, workspaceRef],
  );

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await persist(undefined, "save", "settings.uncensored.saved");
  };

  const clearProviderKey = async (uid: string) => {
    await persist(new Map([[uid, null]]), `clear:${uid}`, "settings.uncensored.tokenCleared");
  };

  const chat = useUncensoredModelChat(port, workspaceRef);

  if (!port || !workspaceRef) return null;

  const updateProvider = (
    uid: string,
    patch: Partial<Pick<ProviderRow, "name" | "apiUrl" | "apiKey" | "nameTouched" | "urlTouched">>,
  ) => {
    setProviders((current) =>
      current.map((provider) => (provider.uid === uid ? { ...provider, ...patch } : provider)),
    );
  };

  const updateModel = (
    providerUid: string,
    modelUid: string,
    patch: Partial<Pick<ModelRow, "id" | "enabled">>,
  ) => {
    setProviders((current) =>
      current.map((provider) =>
        provider.uid === providerUid
          ? {
              ...provider,
              models: provider.models.map((model) =>
                model.uid === modelUid ? { ...model, ...patch } : model,
              ),
            }
          : provider,
      ),
    );
  };

  const addProvider = () => {
    setProviders((current) =>
      current.length >= UNCENSORED_PROVIDERS_LIMIT ? current : [...current, createProviderRow()],
    );
  };

  const removeProvider = (uid: string) => {
    setProviders((current) => current.filter((provider) => provider.uid !== uid));
  };

  const addModel = (providerUid: string) => {
    setProviders((current) =>
      current.map((provider) =>
        provider.uid === providerUid && provider.models.length < UNCENSORED_MODELS_LIMIT
          ? {
              ...provider,
              models: [...provider.models, createModelRow({ id: "", enabled: true })],
            }
          : provider,
      ),
    );
  };

  const removeModel = (providerUid: string, modelUid: string) => {
    setProviders((current) =>
      current.map((provider) =>
        provider.uid === providerUid
          ? { ...provider, models: provider.models.filter((model) => model.uid !== modelUid) }
          : provider,
      ),
    );
  };

  return (
    <section
      aria-labelledby="uncensored-model-settings-title"
      className="max-w-3xl space-y-4"
      data-testid="uncensored-model-settings"
    >
      <header className="flex min-w-0 items-center gap-2">
        <ShieldOff className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h2
          id="uncensored-model-settings-title"
          className="truncate text-ui-settings-title font-semibold"
        >
          {copy("settings.uncensored.title")}
        </h2>
      </header>

      {loading ? (
        <p role="status" aria-live="polite" className="text-ui-base text-foreground-subtle">
          {copy("common.loading")}
        </p>
      ) : loadFailed ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-ui-base text-destructive">
            {copy("settings.uncensored.loadFailed")}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="uncensored-model-retry"
            onClick={() => setReloadToken((current) => current + 1)}
          >
            {copy("common.retry")}
          </Button>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={(event) => void save(event)} noValidate>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 text-ui-sm text-foreground-subtle">
              {copy("settings.uncensored.description")}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="uncensored-provider-add"
              disabled={busy !== null || providers.length >= UNCENSORED_PROVIDERS_LIMIT}
              onClick={addProvider}
            >
              <Plus className="mr-1 size-3.5" aria-hidden="true" />
              {copy("settings.uncensored.addProvider")}
            </Button>
          </div>

          {providers.length === 0 ? (
            <p className="text-ui-sm text-foreground-subtle">
              {copy("settings.uncensored.empty")}
            </p>
          ) : (
            <ul className="space-y-3">
              {providers.map((provider, providerIndex) => {
                const error = providerErrors.get(provider.uid);
                const showNameError =
                  error?.name === true && (submitAttempted || provider.nameTouched);
                const showUrlError =
                  error?.url === true && (submitAttempted || provider.urlTouched);
                const providerLabel = provider.name.trim() || String(providerIndex + 1);
                return (
                  <li
                    key={provider.uid}
                    className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-3"
                    data-testid="uncensored-provider-row"
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <Input
                        className="h-9 min-w-0 flex-1"
                        data-testid="uncensored-provider-name"
                        aria-label={`${copy("settings.uncensored.providerName")} ${providerIndex + 1}`}
                        aria-invalid={error?.name === true}
                        placeholder={copy("settings.uncensored.providerName")}
                        value={provider.name}
                        onChange={(event) =>
                          updateProvider(provider.uid, { name: event.target.value })
                        }
                        onBlur={() => updateProvider(provider.uid, { nameTouched: true })}
                        disabled={busy !== null}
                      />
                      <div className="flex shrink-0 flex-wrap items-center gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="text-ui-sm"
                          data-testid="uncensored-provider-up"
                          aria-label={`${copy("settings.uncensored.moveUp")}: ${providerLabel}`}
                          disabled={busy !== null || providerIndex === 0}
                          onClick={() =>
                            setProviders((current) => moveItem(current, providerIndex, -1))
                          }
                        >
                          {copy("settings.uncensored.moveUp")}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="text-ui-sm"
                          data-testid="uncensored-provider-down"
                          aria-label={`${copy("settings.uncensored.moveDown")}: ${providerLabel}`}
                          disabled={busy !== null || providerIndex === providers.length - 1}
                          onClick={() =>
                            setProviders((current) => moveItem(current, providerIndex, 1))
                          }
                        >
                          {copy("settings.uncensored.moveDown")}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="text-ui-sm text-destructive"
                          data-testid="uncensored-provider-remove"
                          aria-label={`${copy("settings.uncensored.removeProvider")}: ${providerLabel}`}
                          disabled={busy !== null}
                          onClick={() => removeProvider(provider.uid)}
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        </Button>
                      </div>
                    </div>
                    {showNameError ? (
                      <p role="alert" className="break-words text-ui-sm text-destructive">
                        {copy("settings.uncensored.providerNameRequired")}
                      </p>
                    ) : null}

                    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                      <div className="min-w-0 space-y-1">
                        <label
                          htmlFor={`uncensored-provider-url-${provider.uid}`}
                          className="text-ui-sm font-medium text-foreground"
                        >
                          {copy("settings.uncensored.providerApiUrl")}
                        </label>
                        <Input
                          id={`uncensored-provider-url-${provider.uid}`}
                          data-testid="uncensored-provider-url"
                          className="h-9 min-w-0"
                          value={provider.apiUrl}
                          placeholder="https://provider.example/v1/chat/completions"
                          onChange={(event) =>
                            updateProvider(provider.uid, { apiUrl: event.target.value })
                          }
                          onBlur={() => updateProvider(provider.uid, { urlTouched: true })}
                          aria-invalid={error?.url === true}
                          disabled={busy !== null}
                        />
                        {showUrlError ? (
                          <p role="alert" className="break-words text-ui-sm text-destructive">
                            {copy("settings.uncensored.invalidUrl")}
                          </p>
                        ) : null}
                      </div>
                      <div className="min-w-0 space-y-1">
                        <label
                          htmlFor={`uncensored-provider-key-${provider.uid}`}
                          className="text-ui-sm font-medium text-foreground"
                        >
                          {copy("settings.uncensored.providerApiKey")}
                        </label>
                        <Input
                          id={`uncensored-provider-key-${provider.uid}`}
                          data-testid="uncensored-provider-key"
                          type="password"
                          autoComplete="new-password"
                          className="h-9 min-w-0"
                          value={provider.apiKey}
                          placeholder={
                            provider.apiKeyConfigured
                              ? copy("settings.uncensored.apiKeyConfigured")
                              : copy("settings.uncensored.providerApiKey")
                          }
                          onChange={(event) =>
                            updateProvider(provider.uid, { apiKey: event.target.value })
                          }
                          disabled={busy !== null}
                        />
                        {provider.apiKeyConfigured ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="break-words text-ui-sm text-foreground-subtle">
                              {copy("settings.uncensored.apiKeyConfigured")}
                            </p>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="text-ui-sm text-muted-foreground"
                              data-testid="uncensored-provider-clear-key"
                              disabled={busy !== null}
                              onClick={() => void clearProviderKey(provider.uid)}
                            >
                              {busy === `clear:${provider.uid}` ? (
                                <LoaderCircle
                                  className="mr-1 size-3.5 animate-spin"
                                  aria-hidden="true"
                                />
                              ) : null}
                              {copy("settings.uncensored.clearKey")}
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <section className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-ui-base font-semibold">
                          {copy("settings.uncensored.models")}
                        </h3>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          data-testid="uncensored-model-add"
                          disabled={
                            busy !== null || provider.models.length >= UNCENSORED_MODELS_LIMIT
                          }
                          onClick={() => addModel(provider.uid)}
                        >
                          <Plus className="mr-1 size-3.5" aria-hidden="true" />
                          {copy("settings.uncensored.addModel")}
                        </Button>
                      </div>
                      {provider.models.length === 0 ? (
                        <p className="text-ui-sm text-foreground-subtle">
                          {copy("settings.uncensored.noModels")}
                        </p>
                      ) : (
                        <ul className="space-y-2">
                          {provider.models.map((model, modelIndex) => {
                            const modelError = error?.models.get(model.uid);
                            const showModelError = modelError !== undefined && submitAttempted;
                            const modelLabel = model.id.trim() || String(modelIndex + 1);
                            return (
                              <li
                                key={model.uid}
                                className="min-w-0 rounded-lg border border-border bg-surface p-2"
                                data-testid="uncensored-model-row"
                              >
                                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                                  <Input
                                    className="h-9 min-w-0"
                                    data-testid="uncensored-model-id"
                                    aria-label={`${copy("settings.uncensored.models")} ${modelIndex + 1}`}
                                    aria-invalid={modelError !== undefined}
                                    value={model.id}
                                    onChange={(event) =>
                                      updateModel(provider.uid, model.uid, {
                                        id: event.target.value,
                                      })
                                    }
                                    disabled={busy !== null}
                                  />
                                  <div className="flex shrink-0 flex-wrap items-center gap-1">
                                    <span className="text-ui-sm text-foreground-subtle">
                                      {copy("settings.uncensored.modelEnabled")}
                                    </span>
                                    <Switch
                                      size="sm"
                                      data-testid="uncensored-model-enabled"
                                      aria-label={`${copy("settings.uncensored.modelEnabled")}: ${modelLabel}`}
                                      checked={model.enabled}
                                      onCheckedChange={(next) =>
                                        updateModel(provider.uid, model.uid, { enabled: next })
                                      }
                                      disabled={busy !== null}
                                    />
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      className="text-ui-sm"
                                      data-testid="uncensored-model-up"
                                      aria-label={`${copy("settings.uncensored.moveUp")}: ${modelLabel}`}
                                      disabled={busy !== null || modelIndex === 0}
                                      onClick={() =>
                                        setProviders((current) =>
                                          current.map((candidate) =>
                                            candidate.uid === provider.uid
                                              ? {
                                                  ...candidate,
                                                  models: moveItem(
                                                    candidate.models,
                                                    modelIndex,
                                                    -1,
                                                  ),
                                                }
                                              : candidate,
                                          ),
                                        )
                                      }
                                    >
                                      {copy("settings.uncensored.moveUp")}
                                    </Button>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      className="text-ui-sm"
                                      data-testid="uncensored-model-down"
                                      aria-label={`${copy("settings.uncensored.moveDown")}: ${modelLabel}`}
                                      disabled={
                                        busy !== null || modelIndex === provider.models.length - 1
                                      }
                                      onClick={() =>
                                        setProviders((current) =>
                                          current.map((candidate) =>
                                            candidate.uid === provider.uid
                                              ? {
                                                  ...candidate,
                                                  models: moveItem(
                                                    candidate.models,
                                                    modelIndex,
                                                    1,
                                                  ),
                                                }
                                              : candidate,
                                          ),
                                        )
                                      }
                                    >
                                      {copy("settings.uncensored.moveDown")}
                                    </Button>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      className="text-ui-sm"
                                      data-testid="uncensored-model-chat"
                                      aria-label={`${copy("settings.uncensored.write")}: ${modelLabel}`}
                                      disabled={busy !== null || chat.busy}
                                      onClick={() => chat.start(provider.uid, model.uid)}
                                    >
                                      {copy("settings.uncensored.write")}
                                    </Button>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      className="text-ui-sm text-destructive"
                                      data-testid="uncensored-model-remove"
                                      aria-label={`${copy("settings.uncensored.remove")}: ${modelLabel}`}
                                      disabled={busy !== null}
                                      onClick={() => removeModel(provider.uid, model.uid)}
                                    >
                                      {copy("settings.uncensored.remove")}
                                    </Button>
                                  </div>
                                </div>
                                {showModelError ? (
                                  <p
                                    role="alert"
                                    className="mt-1 break-words text-ui-sm text-destructive"
                                  >
                                    {copy(
                                      modelError === "duplicate"
                                        ? "settings.uncensored.duplicateModel"
                                        : "settings.uncensored.invalidModel",
                                    )}
                                  </p>
                                ) : null}
                                {chat.target?.providerUid === provider.uid &&
                                chat.target.modelUid === model.uid ? (
                                  <UncensoredModelChatPanel
                                    text={chat.text}
                                    busy={chat.busy}
                                    result={chat.result}
                                    onTextChange={chat.setText}
                                    onSend={() => void chat.send(provider.id, model.id)}
                                    onCancel={chat.close}
                                  />
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </section>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              size="sm"
              data-testid="uncensored-model-save"
              disabled={busy !== null}
            >
              {busy === "save" ? (
                <LoaderCircle className="mr-1 size-3.5 animate-spin" aria-hidden="true" />
              ) : null}
              {copy("settings.uncensored.save")}
            </Button>
          </div>
        </form>
      )}

      {message ? (
        <p
          role={message.ok ? "status" : "alert"}
          aria-live={message.ok ? "polite" : undefined}
          className={`flex items-center gap-1 break-words text-ui-sm ${
            message.ok ? "text-success-surface-foreground" : "text-destructive"
          }`}
          data-testid="uncensored-model-message"
        >
          {message.ok ? <Check className="size-3.5" aria-hidden="true" /> : null}
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
