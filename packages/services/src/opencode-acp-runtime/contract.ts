import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** These are ACP wire values. They are intentionally not ZCode provider/model IDs. */
export type OpenCodeAcpConfigOption = import("@agentclientprotocol/sdk").SessionConfigOption;
export type OpenCodeAcpSessionUpdate = import("@agentclientprotocol/sdk").SessionUpdate;
export type OpenCodeAcpPermissionOptionKind =
  import("@agentclientprotocol/sdk").PermissionOptionKind;

export interface OpenCodeAcpPermissionRequest {
  requestId: string;
  sessionId: string;
  toolTitle: string;
  toolKind?: string;
  inputSummary?: string;
  options: Array<{
    optionId: string;
    kind: OpenCodeAcpPermissionOptionKind;
    name: string;
  }>;
}

export type OpenCodeAcpPermissionEvent =
  | { type: "requested"; request: OpenCodeAcpPermissionRequest }
  | { type: "resolved"; requestId: string; sessionId: string };

export type OpenCodeCliStatus =
  | { status: "available"; version: string; executablePath: string }
  | {
      status: "missing" | "unavailable" | "timed-out";
      diagnostic: string;
      installSupported?: boolean;
    };

export type OpenCodeInstallResult =
  | { status: "installed"; version: string; executablePath: string }
  | { status: "already-installed"; version: string; executablePath: string }
  | { status: "failed"; diagnostic: string };

/** Safe, fixed install diagnostics. Raw process output never crosses the Host boundary. */
export type OpenCodeInstallFailureDiagnostic =
  | "opencode.install-download-failed"
  | "opencode.install-script-invalid"
  | "opencode.install-execution-failed"
  | "opencode.install-package-manager-failed"
  | "opencode.install-timeout"
  | "opencode.install-destination-conflict"
  | "opencode.install-verification-failed"
  | "opencode.install-platform-unsupported";

export type OpenCodeInstallCommandOutcome =
  | { ok: true }
  | { ok: false; diagnostic: OpenCodeInstallFailureDiagnostic };

/** Read-only OpenCode CLI catalog. Authentication is intentionally not queried by this call. */
export type OpenCodeCliModelCatalog =
  | { status: "available"; models: string[]; authentication: "not-checked" }
  | { status: "unavailable" | "timed-out"; diagnostic: string };

export interface OpenCodeAcpSession {
  sessionId: string;
  cwd: string;
  configOptions: OpenCodeAcpConfigOption[];
}

export interface OpenCodeAcpPromptResult {
  stopReason: string;
}

/**
 * Process-owning Host service for an explicitly delegated OpenCode ACP session.
 * It never authenticates, reads OpenCode's auth store, starts a session for catalog discovery,
 * or forwards this work into the ZCode conversation/provider runtime.
 */
export interface IOpenCodeAcpRuntime {
  /** Runs only `opencode --version`; no process is retained and no ACP session is created. */
  getCliStatus(params?: { cliPath?: string }): Promise<OpenCodeCliStatus>;

  /**
   * Installs the official platform CLI only after explicit UI confirmation. POSIX installation
   * runs in a temporary HOME and copies the verified binary with exclusive creation; WinGet uses
   * --no-upgrade. Re-probes before install and never replaces an already discoverable CLI.
   */
  installCli(params?: { cliPath?: string }): Promise<OpenCodeInstallResult>;

  /** Lists bounded provider/model IDs via `opencode models`; it never starts an ACP session or prompt. */
  listModels(params?: { cliPath?: string }): Promise<OpenCodeCliModelCatalog>;

  /** Starts ACP and creates a durable OpenCode session. Calling this is the user's explicit start action. */
  startSession(params: { cwd: string; cliPath?: string }): Promise<OpenCodeAcpSession>;

  /** Sends one ACP session/set_config_option call and returns the complete fresh option set. */
  setConfigOption(params: {
    sessionId: string;
    configId: string;
    value: string | boolean;
  }): Promise<OpenCodeAcpSession>;

  /** Runs a prompt in the explicitly selected OpenCode session; at most one prompt may be active per session. */
  prompt(params: { sessionId: string; text: string }): Promise<OpenCodeAcpPromptResult>;

  /** Cancels the active prompt in that session; idempotent if no prompt is active. */
  cancel(params: { sessionId: string }): Promise<void>;

  /** Answers one live ACP permission request with an option advertised by that request. */
  respondToPermission(params: {
    sessionId: string;
    requestId: string;
    optionId: string;
  }): Promise<void>;

  /** Closes the durable session when ACP advertises session/close; idempotent for an already-closed session. */
  closeSession(params: { sessionId: string }): Promise<void>;

  /** A dynamic event scoped to one OpenCode session; each update retains the ACP session ID. */
  onSessionUpdate(params: { sessionId: string }): Event<OpenCodeAcpSessionUpdate>;

  /** Explicit user permission requests from the delegated OpenCode session. */
  onPermissionEvent(params: { sessionId: string }): Event<OpenCodeAcpPermissionEvent>;

  /** Host shutdown only: closes sessions and waits for the owned CLI process tree to exit. */
  disposeAllAndWait(): Promise<void>;
}

export const IOpenCodeAcpRuntime = createServiceDescriptor<IOpenCodeAcpRuntime>(
  ServiceChannels.OpenCodeAcp,
);
