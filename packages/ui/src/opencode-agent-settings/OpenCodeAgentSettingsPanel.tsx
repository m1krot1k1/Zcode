import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { usePlatform, useSelectDirectory } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { OpenCodePermissionRequests } from "./OpenCodePermissionRequests.js";
import { OpenCodeCliModelCatalogSection } from "./OpenCodeCliModelCatalog.js";
import {
  findOpenCodeConfigOption,
  getOpenCodeSelectValues,
  type OpenCodeAgentConfigOption,
  type OpenCodeAgentCliStatus,
  type OpenCodeAgentModelCatalog,
  type OpenCodeAgentPermissionRequest,
  type OpenCodeAgentSession,
} from "./contract.js";

interface TranscriptItem {
  role: "user" | "assistant" | "tool";
  text: string;
}

function findOption(options: OpenCodeAgentConfigOption[], category: string) {
  return findOpenCodeConfigOption(options, category);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function eventText(update: unknown): { role: "assistant" | "tool"; text: string } | null {
  if (!isRecord(update) || typeof update.sessionUpdate !== "string") return null;
  if (
    update.sessionUpdate === "agent_message_chunk" &&
    isRecord(update.content) &&
    update.content.type === "text" &&
    typeof update.content.text === "string"
  ) {
    return { role: "assistant", text: update.content.text };
  }
  if (update.sessionUpdate === "tool_call") {
    return {
      role: "tool",
      text: `${String(update.title ?? "OpenCode tool")} · ${String(update.status ?? "updated")}`,
    };
  }
  if (update.sessionUpdate === "tool_call_update") {
    return {
      role: "tool",
      text: `${String(update.toolCallId ?? "OpenCode tool")} · ${String(update.status ?? "updated")}`,
    };
  }
  if (update.sessionUpdate === "current_mode_update" && typeof update.currentModeId === "string") {
    return { role: "tool", text: `OpenCode agent mode · ${update.currentModeId}` };
  }
  return null;
}

function statusMessage(
  status: OpenCodeAgentCliStatus | undefined,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
) {
  if (!status) return intl.formatMessage({ id: "settings.openCode.checking" });
  if (status.status === "available") {
    return intl.formatMessage({ id: "settings.openCode.available" }, { version: status.version });
  }
  if (status.diagnostic === "opencode.windows-cli-shim-unsupported") {
    return intl.formatMessage({ id: "settings.openCode.windowsShimUnsupported" });
  }
  if (
    status.diagnostic === "opencode.explicit-cli-unavailable" ||
    status.diagnostic === "opencode.explicit-cli-path-must-be-absolute" ||
    status.diagnostic === "opencode.windows-native-cli-required"
  ) {
    return intl.formatMessage({ id: "settings.openCode.explicitCliUnavailable" });
  }
  return intl.formatMessage({ id: `settings.openCode.${status.status}` });
}

function diagnosticMessageId(code: string, fallback = "settings.openCode.operationFailed") {
  if (code.startsWith("settings.")) return code;
  if (code.startsWith("opencode.")) return `settings.openCode.${code.slice("opencode.".length)}`;
  return fallback;
}

export function OpenCodeAgentSettingsPanel({
  initialWorkspacePath,
  remoteWorkspaceActive,
}: {
  initialWorkspacePath: string;
  remoteWorkspaceActive: boolean;
}) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const selectDirectory = useSelectDirectory();
  const platform = usePlatform();
  const runtime = useServices().openCodeAcpRuntime;
  const [workspacePath, setWorkspacePath] = useState(initialWorkspacePath);
  const [cliPath, setCliPath] = useState("");
  const [workspaceExplicitlyChosen, setWorkspaceExplicitlyChosen] = useState(
    (!remoteWorkspaceActive || Boolean(runtime)) && Boolean(initialWorkspacePath.trim()),
  );
  const [cliStatus, setCliStatus] = useState<OpenCodeAgentCliStatus>();
  const [modelCatalog, setModelCatalog] = useState<OpenCodeAgentModelCatalog>();
  const [session, setSession] = useState<OpenCodeAgentSession>();
  const [modelDraft, setModelDraft] = useState("");
  const [modeDraft, setModeDraft] = useState("");
  const [modelSelectionConfirmed, setModelSelectionConfirmed] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [permissionRequests, setPermissionRequests] = useState<OpenCodeAgentPermissionRequest[]>(
    [],
  );
  const [respondingPermissionIds, setRespondingPermissionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [promptText, setPromptText] = useState("");
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState(false);
  const [diagnostic, setDiagnostic] = useState("");
  const closingSessions = useRef(new Set<string>());

  const closeSessionOnce = useCallback(
    async (sessionId: string) => {
      if (!runtime || closingSessions.current.has(sessionId)) return;
      closingSessions.current.add(sessionId);
      try {
        await runtime.closeSession({ sessionId });
      } catch (error) {
        closingSessions.current.delete(sessionId);
        throw error;
      }
    },
    [runtime],
  );

  useEffect(() => {
    if (initialWorkspacePath.trim()) setWorkspacePath(initialWorkspacePath);
    setWorkspaceExplicitlyChosen(
      (!remoteWorkspaceActive || Boolean(runtime)) && Boolean(initialWorkspacePath.trim()),
    );
  }, [initialWorkspacePath, remoteWorkspaceActive, runtime]);

  const refreshStatus = useCallback(async () => {
    if (!runtime) return;
    try {
      setCliStatus(await runtime.getCliStatus({ cliPath: cliPath || undefined }));
    } catch {
      setDiagnostic(intl.formatMessage({ id: "settings.openCode.diagnosticFailed" }));
    }
  }, [cliPath, intl, runtime]);

  const refreshModelCatalog = useCallback(async () => {
    if (!runtime || cliStatus?.status !== "available") return;
    setWorking(true);
    try {
      setModelCatalog(await runtime.listModels({ cliPath: cliPath || undefined }));
    } catch {
      setModelCatalog({ status: "unavailable", diagnostic: "opencode.models-failed" });
    } finally {
      setWorking(false);
    }
  }, [cliPath, cliStatus?.status, runtime]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const configOptions: OpenCodeAgentConfigOption[] = session?.configOptions ?? [];
  const modelOption = useMemo(() => findOption(configOptions, "model"), [configOptions]);
  const modeOption = useMemo(() => findOption(configOptions, "mode"), [configOptions]);
  const modelValues = useMemo(
    () => (modelOption ? getOpenCodeSelectValues(modelOption) : []),
    [modelOption],
  );
  const modeValues = useMemo(
    () => (modeOption ? getOpenCodeSelectValues(modeOption) : []),
    [modeOption],
  );

  useEffect(() => {
    if (!runtime || !session) return;
    const subscription = runtime.onSessionUpdate({ sessionId: session.sessionId })((update) => {
      const item = eventText(update);
      if (!item) return;
      setTranscript((current) => {
        const last = current.at(-1);
        if (item.role === "assistant" && last?.role === "assistant") {
          return [...current.slice(0, -1), { ...last, text: last.text + item.text }].slice(-250);
        }
        return [...current, item].slice(-250);
      });
    });
    return () => {
      subscription.dispose();
      // The panel owns this delegated session; cleanup closes it once on unmount/session swap.
      void closeSessionOnce(session.sessionId).catch(() => undefined);
    };
  }, [closeSessionOnce, runtime, session?.sessionId]);

  useEffect(() => {
    if (!runtime || !session) return;
    const subscription = runtime.onPermissionEvent({ sessionId: session.sessionId })((event) => {
      if (event.type === "requested") {
        setPermissionRequests((current) => [
          ...current.filter((request) => request.requestId !== event.request.requestId),
          event.request,
        ]);
      } else {
        setPermissionRequests((current) =>
          current.filter((request) => request.requestId !== event.requestId),
        );
        setRespondingPermissionIds((current) => {
          const next = new Set(current);
          next.delete(event.requestId);
          return next;
        });
      }
    });
    return () => subscription.dispose();
  }, [runtime, session?.sessionId]);

  const handleChooseDirectory = useCallback(async () => {
    const path = await selectDirectory();
    if (path) {
      setWorkspacePath(path);
      setWorkspaceExplicitlyChosen(true);
    }
  }, [selectDirectory]);

  const handleChooseCli = useCallback(async () => {
    const path = await platform.selectFile();
    if (!path || !runtime) return;
    setCliPath(path);
    setWorking(true);
    setDiagnostic("");
    try {
      setCliStatus(await runtime.getCliStatus({ cliPath: path }));
    } catch {
      setDiagnostic(intl.formatMessage({ id: "settings.openCode.diagnosticFailed" }));
    } finally {
      setWorking(false);
    }
  }, [intl, platform, runtime]);

  const handleSearchPath = useCallback(async () => {
    setCliPath("");
    if (!runtime) return;
    setWorking(true);
    setDiagnostic("");
    try {
      setCliStatus(await runtime.getCliStatus());
    } catch {
      setDiagnostic(intl.formatMessage({ id: "settings.openCode.diagnosticFailed" }));
    } finally {
      setWorking(false);
    }
  }, [intl, runtime]);

  const handleInstall = useCallback(async () => {
    if (!runtime) return;
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "settings.openCode.installConfirmTitle" }),
      description: intl.formatMessage({ id: "settings.openCode.installConfirmDescription" }),
      confirmLabel: intl.formatMessage({ id: "settings.openCode.install" }),
      cancelLabel: intl.formatMessage({ id: "common.cancel" }),
    });
    if (!confirmed) return;
    setWorking(true);
    setDiagnostic("");
    try {
      const result = await runtime.installCli();
      if (result.status === "installed" || result.status === "already-installed") {
        setCliStatus({
          status: "available",
          version: result.version,
          executablePath: result.executablePath,
        });
      } else {
        setDiagnostic(intl.formatMessage({ id: diagnosticMessageId(result.diagnostic) }));
      }
    } catch {
      setDiagnostic(intl.formatMessage({ id: "settings.openCode.install-failed" }));
    } finally {
      setWorking(false);
    }
  }, [confirmDialog, intl, runtime]);

  const handleStart = useCallback(async () => {
    if (!runtime || !workspacePath.trim() || !workspaceExplicitlyChosen) return;
    setWorking(true);
    setDiagnostic("");
    setTranscript([]);
    try {
      const created = await runtime.startSession({
        cwd: workspacePath.trim(),
        cliPath: cliPath || undefined,
      });
      closingSessions.current.delete(created.sessionId);
      setSession(created);
      const model = findOption(created.configOptions, "model");
      const mode = findOption(created.configOptions, "mode");
      setModelDraft(model?.type === "select" ? model.currentValue : "");
      setModeDraft(mode?.type === "select" ? mode.currentValue : "");
      setModelSelectionConfirmed(false);
    } catch (error) {
      const code = error instanceof Error ? error.message : "settings.openCode.sessionStartFailed";
      setDiagnostic(
        intl.formatMessage({
          id: diagnosticMessageId(code, "settings.openCode.sessionStartFailed"),
        }),
      );
    } finally {
      setWorking(false);
    }
  }, [cliPath, intl, runtime, workspaceExplicitlyChosen, workspacePath]);

  const applyModelSelection = useCallback(async () => {
    if (!runtime || !session || !modelOption) return;
    setWorking(true);
    setDiagnostic("");
    try {
      const refreshed = await runtime.setConfigOption({
        sessionId: session.sessionId,
        configId: modelOption.id,
        value: modelDraft,
      });
      setSession(refreshed);
      const currentMode = findOption(refreshed.configOptions, "mode");
      if (currentMode?.type === "select") setModeDraft(currentMode.currentValue);
      setModelSelectionConfirmed(true);
    } catch (error) {
      const code =
        error instanceof Error ? error.message : "settings.openCode.modelSelectionFailed";
      setDiagnostic(
        intl.formatMessage({
          id: diagnosticMessageId(code, "settings.openCode.modelSelectionFailed"),
        }),
      );
    } finally {
      setWorking(false);
    }
  }, [intl, modelDraft, modelOption, runtime, session]);

  const applyModeSelection = useCallback(
    async (value: string) => {
      if (!runtime || !session || !modeOption) return;
      setModeDraft(value);
      setWorking(true);
      setDiagnostic("");
      try {
        const refreshed = await runtime.setConfigOption({
          sessionId: session.sessionId,
          configId: modeOption.id,
          value,
        });
        setSession(refreshed);
        const currentModel = findOption(refreshed.configOptions, "model");
        if (currentModel?.type === "select") setModelDraft(currentModel.currentValue);
        setModelSelectionConfirmed(false);
      } catch (error) {
        const code =
          error instanceof Error ? error.message : "settings.openCode.agentSelectionFailed";
        setDiagnostic(
          intl.formatMessage({
            id: diagnosticMessageId(code, "settings.openCode.agentSelectionFailed"),
          }),
        );
      } finally {
        setWorking(false);
      }
    },
    [intl, modeOption, runtime, session],
  );

  const confirmDefaultModel = useCallback(() => {
    setModelSelectionConfirmed(true);
  }, []);

  const sendPrompt = useCallback(async () => {
    const text = promptText.trim();
    if (!runtime || !session || !modelSelectionConfirmed || !text) return;
    setPromptText("");
    setTranscript((current): TranscriptItem[] =>
      [...current, { role: "user" as const, text }].slice(-250),
    );
    setBusy(true);
    setDiagnostic("");
    try {
      await runtime.prompt({ sessionId: session.sessionId, text });
    } catch (error) {
      const code = error instanceof Error ? error.message : "settings.openCode.promptFailed";
      setDiagnostic(
        intl.formatMessage({ id: diagnosticMessageId(code, "settings.openCode.promptFailed") }),
      );
    } finally {
      setBusy(false);
    }
  }, [intl, modelSelectionConfirmed, promptText, runtime, session]);

  const cancelPrompt = useCallback(async () => {
    if (!runtime || !session) return;
    try {
      await runtime.cancel({ sessionId: session.sessionId });
    } catch {
      setDiagnostic(intl.formatMessage({ id: "settings.openCode.cancelFailed" }));
    }
  }, [intl, runtime, session]);

  const respondToPermission = useCallback(
    async (request: OpenCodeAgentPermissionRequest, optionId: string) => {
      if (!runtime) return;
      setRespondingPermissionIds((current) => new Set(current).add(request.requestId));
      try {
        await runtime.respondToPermission({
          sessionId: request.sessionId,
          requestId: request.requestId,
          optionId,
        });
      } catch (error) {
        setRespondingPermissionIds((current) => {
          const next = new Set(current);
          next.delete(request.requestId);
          return next;
        });
        const code = error instanceof Error ? error.message : "settings.openCode.operationFailed";
        setDiagnostic(
          intl.formatMessage({
            id: diagnosticMessageId(code, "settings.openCode.operationFailed"),
          }),
        );
      }
    },
    [intl, runtime],
  );

  const closeSession = useCallback(async () => {
    if (!runtime || !session) return;
    setWorking(true);
    try {
      await closeSessionOnce(session.sessionId);
      setSession(undefined);
      setTranscript([]);
      setPermissionRequests([]);
      setModelSelectionConfirmed(false);
    } catch {
      setDiagnostic(intl.formatMessage({ id: "settings.openCode.closeFailed" }));
    } finally {
      setWorking(false);
    }
  }, [closeSessionOnce, intl, runtime, session]);

  const openInstallInstructions = useCallback(() => {
    platform.openExternal("https://opencode.ai/v2/docs");
  }, [platform]);

  return (
    <section
      aria-labelledby="local-opencode-agent-title"
      className="mb-4 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5"
      data-testid="opencode-agent-settings"
    >
      <header className="space-y-1">
        <h2 id="local-opencode-agent-title" className="text-ui-settings-title font-semibold">
          {intl.formatMessage({ id: "settings.openCode.title" })}
        </h2>
        <span className="inline-flex rounded-md border border-border px-2 py-0.5 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "settings.openCode.authModeCli" })}
        </span>
        <p className="text-ui-base leading-6 text-foreground-subtle">
          {intl.formatMessage({ id: "settings.openCode.ownership" })}
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        <span className="text-ui-base text-foreground-subtle">
          {statusMessage(cliStatus, intl)}
        </span>
        {cliStatus?.status === "available" ? (
          <span className="break-all text-ui-base text-foreground-subtle">
            {cliStatus.executablePath}
          </span>
        ) : null}
        {cliStatus?.status === "missing" || cliStatus?.status === "unavailable" ? (
          <>
            {cliStatus.status === "missing" && cliStatus.installSupported !== false && !cliPath ? (
              <Button
                type="button"
                size="sm"
                onClick={() => void handleInstall()}
                disabled={working || !runtime}
              >
                {working
                  ? intl.formatMessage({ id: "settings.openCode.installing" })
                  : intl.formatMessage({ id: "settings.openCode.install" })}
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="outline" onClick={openInstallInstructions}>
              {intl.formatMessage({ id: "settings.openCode.installInstructions" })}
            </Button>
          </>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void handleChooseCli()}
          disabled={working || !runtime}
        >
          {intl.formatMessage({ id: "settings.openCode.chooseCli" })}
        </Button>
        {cliPath ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void handleSearchPath()}
            disabled={working || !runtime}
          >
            {intl.formatMessage({ id: "settings.openCode.searchPath" })}
          </Button>
        ) : null}
        {cliStatus?.status !== "available" && cliStatus?.status !== "missing" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void refreshStatus()}
            disabled={working}
          >
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        ) : null}
      </div>

      {cliStatus?.status === "available" ? (
        <OpenCodeCliModelCatalogSection
          catalog={modelCatalog}
          disabled={working || !runtime}
          onRefresh={() => void refreshModelCatalog()}
        />
      ) : null}

      {!runtime ? (
        <p role="status" className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.openCode.desktopLocalHostRequired" })}
        </p>
      ) : null}
      {remoteWorkspaceActive && !runtime ? (
        <p role="status" className="rounded-lg bg-muted p-3 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.openCode.localWorkspaceNotice" })}
        </p>
      ) : null}
      {remoteWorkspaceActive && runtime ? (
        <p role="status" className="rounded-lg bg-muted p-3 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.openCode.remoteHostWorkspaceNotice" })}
        </p>
      ) : null}

      {!session ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1 space-y-1 text-ui-base">
              <span>{intl.formatMessage({ id: "settings.openCode.workspace" })}</span>
              <Input
                value={workspacePath}
                readOnly
                placeholder={intl.formatMessage({ id: "settings.openCode.chooseWorkspace" })}
              />
            </label>
            {!remoteWorkspaceActive ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleChooseDirectory()}
                disabled={working}
              >
                {intl.formatMessage({ id: "settings.openCode.chooseWorkspace" })}
              </Button>
            ) : null}
          </div>
          <Button
            type="button"
            onClick={() => void handleStart()}
            disabled={
              !runtime ||
              cliStatus?.status !== "available" ||
              !workspacePath.trim() ||
              !workspaceExplicitlyChosen ||
              working
            }
            data-testid="opencode-start-session"
          >
            {working
              ? intl.formatMessage({ id: "settings.openCode.starting" })
              : intl.formatMessage({ id: "settings.openCode.startSession" })}
          </Button>
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.openCode.cliAuthNotice" })}
          </p>
        </div>
      ) : (
        <div className="space-y-4" data-testid="opencode-session-panel">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="space-y-1 text-ui-base">
              <p className="font-medium">
                {intl.formatMessage({ id: "settings.openCode.sessionStarted" })}
              </p>
              <p className="break-all text-foreground-subtle">{session.cwd}</p>
              <p className="text-foreground-subtle">
                {intl.formatMessage(
                  { id: "settings.openCode.sessionId" },
                  { id: session.sessionId },
                )}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => void closeSession()}
              disabled={working || busy}
            >
              {intl.formatMessage({ id: "settings.openCode.closeSession" })}
            </Button>
          </div>

          <OpenCodePermissionRequests
            requests={permissionRequests}
            respondingRequestIds={respondingPermissionIds}
            onRespond={(request, optionId) => void respondToPermission(request, optionId)}
          />

          <div className="grid gap-3 md:grid-cols-2">
            {modelOption?.type === "select" ? (
              <div className="space-y-1">
                <label className="text-ui-base font-medium" htmlFor="opencode-model-select">
                  {intl.formatMessage({ id: "settings.openCode.model" })}
                </label>
                <Select value={modelDraft} onValueChange={setModelDraft} disabled={working || busy}>
                  <SelectTrigger id="opencode-model-select" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {modelValues.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="break-all text-ui-base text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.openCode.modelId" })}:{" "}
                  <code>{modelDraft}</code>
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void applyModelSelection()}
                  disabled={working || busy || !modelDraft}
                >
                  {intl.formatMessage({ id: "settings.openCode.applyModel" })}
                </Button>
              </div>
            ) : (
              <div className="space-y-2 rounded-lg bg-muted p-3">
                <p className="text-ui-base font-medium">
                  {intl.formatMessage({ id: "settings.openCode.defaultModel" })}
                </p>
                <p className="text-ui-base text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.openCode.defaultModelDetail" })}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={confirmDefaultModel}
                  disabled={working || busy}
                >
                  {intl.formatMessage({ id: "settings.openCode.confirmDefault" })}
                </Button>
              </div>
            )}
            {modeOption?.type === "select" ? (
              <div className="space-y-1">
                <label className="text-ui-base font-medium" htmlFor="opencode-agent-select">
                  {intl.formatMessage({ id: "settings.openCode.agent" })}
                </label>
                <Select
                  value={modeDraft}
                  onValueChange={(value) => void applyModeSelection(value)}
                  disabled={working || busy}
                >
                  <SelectTrigger id="opencode-agent-select" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {modeValues.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>

          <div
            className="max-h-72 space-y-2 overflow-y-auto rounded-lg border border-border bg-background p-3"
            aria-live="polite"
            data-testid="opencode-transcript"
          >
            {transcript.length === 0 ? (
              <p className="text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "settings.openCode.transcriptEmpty" })}
              </p>
            ) : (
              transcript.map((item, index) => (
                <div
                  key={`${index}-${item.role}`}
                  className={
                    item.role === "user"
                      ? "text-foreground"
                      : item.role === "tool"
                        ? "text-foreground-subtle"
                        : "text-foreground"
                  }
                >
                  <span className="font-medium">
                    {intl.formatMessage({ id: `settings.openCode.role.${item.role}` })}:{" "}
                  </span>
                  <span className="whitespace-pre-wrap break-words">{item.text}</span>
                </div>
              ))
            )}
          </div>

          <div className="space-y-2">
            <label className="text-ui-base font-medium" htmlFor="opencode-prompt">
              {intl.formatMessage({ id: "settings.openCode.prompt" })}
            </label>
            <Textarea
              id="opencode-prompt"
              value={promptText}
              onChange={(event) => setPromptText(event.target.value)}
              placeholder={intl.formatMessage({ id: "settings.openCode.promptPlaceholder" })}
              disabled={busy || working || !modelSelectionConfirmed}
              rows={3}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={() => void sendPrompt()}
                disabled={busy || working || !modelSelectionConfirmed || !promptText.trim()}
              >
                {intl.formatMessage({ id: "settings.openCode.send" })}
              </Button>
              {busy ? (
                <Button type="button" variant="outline" onClick={() => void cancelPrompt()}>
                  {intl.formatMessage({ id: "settings.openCode.cancel" })}
                </Button>
              ) : null}
            </div>
            {!modelSelectionConfirmed ? (
              <p role="status" className="text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "settings.openCode.confirmModelBeforePrompt" })}
              </p>
            ) : null}
          </div>
        </div>
      )}

      {diagnostic ? (
        <div role="alert" className="space-y-2 text-ui-base text-destructive">
          <p>{diagnostic}</p>
        </div>
      ) : null}
    </section>
  );
}
