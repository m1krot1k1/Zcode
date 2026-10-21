import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { Emitter } from "@zcode/rpc";
import type {
  IOpenCodeAcpRuntime,
  OpenCodeAcpConfigOption,
  OpenCodeAcpPromptResult,
  OpenCodeAcpPermissionEvent,
  OpenCodeAcpPermissionRequest,
  OpenCodeAcpSession,
  OpenCodeAcpSessionUpdate,
  OpenCodeCliStatus,
  OpenCodeInstallResult,
} from "../contract.js";
import type { OpenCodeCliResolution, OpenCodeCommandSpec } from "./cliResolver.js";
import {
  INSTALL_TIMEOUT_MS,
  installOpenCodePackage,
  installOpenCodeWingetPackage,
  resolveCliCommand,
  resolveWingetCommand,
  runVersion,
  spawnOptions,
  withTimeout,
} from "./childProcessSupport.js";
import { terminateProcessTreeAndWait } from "#src/process/processTreeTerminator.js";

const ACP_REQUEST_TIMEOUT_MS = 20_000;
const PROMPT_TIMEOUT_MS = 30 * 60_000;
const CLEANUP_REQUEST_TIMEOUT_MS = 1_500;
const MAX_PERMISSION_INPUT_CHARS = 2_000;
const MAX_PERMISSION_TITLE_CHARS = 512;
const MAX_PERMISSION_OPTION_NAME_CHARS = 256;

interface OpenCodeAcpRuntimeOptions {
  resolveCli?: (cliPath?: string) => OpenCodeCliResolution | Promise<OpenCodeCliResolution>;
  resolveWinget?: () => Promise<string | undefined>;
  runVersion?: (spec: OpenCodeCommandSpec) => Promise<OpenCodeCliStatus>;
  installPackage?: (timeoutMs: number) => Promise<boolean>;
  installWingetPackage?: (wingetPath: string, timeoutMs: number) => Promise<boolean>;
  platform?: NodeJS.Platform;
  processEnv?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  promptTimeoutMs?: number;
  cleanupRequestTimeoutMs?: number;
  installTimeoutMs?: number;
  terminateProcessTreeAndWait?: typeof terminateProcessTreeAndWait;
}

interface RuntimeConnection {
  child: ChildProcess;
  executablePath: string;
  connection: acp.ClientSideConnection;
  canCloseSessions: boolean;
  sessions: Map<string, SessionState>;
  prompts: Map<string, Promise<OpenCodeAcpPromptResult>>;
  permissionRequests: Map<string, PendingPermissionRequest>;
  disposePromise?: Promise<void>;
}

interface PendingPermissionRequest {
  sessionId: string;
  options: Map<string, import("@agentclientprotocol/sdk").PermissionOptionKind>;
  resolve: (response: import("@agentclientprotocol/sdk").RequestPermissionResponse) => void;
}

interface SessionState {
  cwd: string;
  configOptions: OpenCodeAcpConfigOption[];
  closed: boolean;
}

function stripControlCharacters(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join("");
}

function readErrorDiagnostic(error: unknown, fallback: string): string {
  // ACP error messages can contain agent output or workspace data. Expose only a stable code.
  return error instanceof Error && error.message.startsWith("opencode.") ? error.message : fallback;
}

export function createOpenCodeAcpRuntime(
  options: OpenCodeAcpRuntimeOptions = {},
): IOpenCodeAcpRuntime {
  let runtime: RuntimeConnection | undefined;
  let initializing: Promise<RuntimeConnection> | undefined;
  let initializingExecutablePath: string | undefined;
  let terminallyDisposed = false;
  let disposePromise: Promise<void> | undefined;
  const childEnvironment = options.processEnv ?? process.env;
  const platform = options.platform ?? process.platform;
  const runVersionCommand =
    options.runVersion ??
    ((spec: OpenCodeCommandSpec) => runVersion(spec, childEnvironment, platform));
  const installPackage =
    options.installPackage ??
    ((timeoutMs: number) => installOpenCodePackage(timeoutMs, childEnvironment, platform));
  const installWingetPackage =
    options.installWingetPackage ??
    ((wingetPath: string, timeoutMs: number) =>
      installOpenCodeWingetPackage(wingetPath, timeoutMs, childEnvironment, platform));
  const emitters = new Map<string, Emitter<OpenCodeAcpSessionUpdate>>();
  const permissionEmitters = new Map<string, Emitter<OpenCodeAcpPermissionEvent>>();

  const getEmitter = (sessionId: string) => {
    let emitter = emitters.get(sessionId);
    if (!emitter) {
      emitter = new Emitter<OpenCodeAcpSessionUpdate>();
      emitters.set(sessionId, emitter);
    }
    return emitter;
  };

  const getPermissionEmitter = (sessionId: string) => {
    let emitter = permissionEmitters.get(sessionId);
    if (!emitter) {
      emitter = new Emitter<OpenCodeAcpPermissionEvent>();
      permissionEmitters.set(sessionId, emitter);
    }
    return emitter;
  };

  const settlePermission = (
    target: RuntimeConnection,
    requestId: string,
    outcome: import("@agentclientprotocol/sdk").RequestPermissionOutcome,
  ): boolean => {
    const pending = target.permissionRequests.get(requestId);
    if (!pending) return false;
    target.permissionRequests.delete(requestId);
    pending.resolve({ outcome });
    getPermissionEmitter(pending.sessionId).fire({
      type: "resolved",
      requestId,
      sessionId: pending.sessionId,
    });
    return true;
  };

  const cancelSessionPermissions = (target: RuntimeConnection, sessionId: string): void => {
    for (const [requestId, pending] of target.permissionRequests) {
      if (pending.sessionId === sessionId) {
        settlePermission(target, requestId, { outcome: "cancelled" });
      }
    }
  };

  const cancelAllPermissions = (target: RuntimeConnection): void => {
    for (const requestId of target.permissionRequests.keys()) {
      settlePermission(target, requestId, { outcome: "cancelled" });
    }
  };

  const request = async <T>(
    connection: RuntimeConnection,
    promise: Promise<T>,
    fallback: string,
    timeoutMs = options.requestTimeoutMs ?? ACP_REQUEST_TIMEOUT_MS,
  ): Promise<T> => {
    if (connection.connection.signal.aborted) throw new Error("opencode.acp-connection-closed");
    const closed = connection.connection.closed.then(() => {
      throw new Error("opencode.acp-connection-closed");
    });
    try {
      return await withTimeout(Promise.race([promise, closed]), timeoutMs, "opencode.acp-timeout");
    } catch (error) {
      throw new Error(readErrorDiagnostic(error, fallback));
    }
  };

  const ensureRuntime = async (
    cwd: string,
    resolution: Extract<OpenCodeCliResolution, { status: "resolved" }>,
  ): Promise<RuntimeConnection> => {
    if (terminallyDisposed) throw new Error("opencode.runtime-disposed");
    if (runtime && !runtime.connection.signal.aborted && runtime.child.exitCode === null) {
      if (runtime.executablePath !== resolution.executablePath) {
        throw new Error("opencode.runtime-cli-path-mismatch");
      }
      return runtime;
    }
    if (initializing) {
      if (initializingExecutablePath !== resolution.executablePath) {
        throw new Error("opencode.runtime-cli-path-mismatch");
      }
      return await initializing;
    }
    if (runtime) await stopRuntime(runtime);

    const starting = (async (): Promise<RuntimeConnection> => {
      const spec = resolution.spec;
      const child = spawn(
        spec.command,
        [...spec.prefixArgs, "acp"],
        spawnOptions(cwd, ["pipe", "pipe", "ignore"], childEnvironment, platform),
      );
      if (!child.stdin || !child.stdout) {
        child.kill();
        throw new Error("opencode.acp-stdio-unavailable");
      }

      const permissionRequests = new Map<string, PendingPermissionRequest>();
      const sessions = new Map<string, SessionState>();
      const prompts = new Map<string, Promise<OpenCodeAcpPromptResult>>();
      const connection = new acp.ClientSideConnection(
        () => ({
          requestPermission: async (params) => {
            if (!sessions.has(params.sessionId) || !prompts.has(params.sessionId)) {
              return { outcome: { outcome: "cancelled" } };
            }
            const requestId = randomUUID();
            const options = params.options.map((option) => ({
              optionId: option.optionId,
              kind: option.kind,
              name: stripControlCharacters(option.name).slice(0, MAX_PERMISSION_OPTION_NAME_CHARS),
            }));
            if (options.length === 0) return { outcome: { outcome: "cancelled" } };
            let inputSummary: string | undefined;
            if (params.toolCall.rawInput !== undefined) {
              try {
                inputSummary =
                  JSON.stringify(params.toolCall.rawInput) ?? String(params.toolCall.rawInput);
              } catch {
                inputSummary = "[unavailable]";
              }
              inputSummary = stripControlCharacters(inputSummary).slice(
                0,
                MAX_PERMISSION_INPUT_CHARS,
              );
            }
            const request: OpenCodeAcpPermissionRequest = {
              requestId,
              sessionId: params.sessionId,
              toolTitle:
                stripControlCharacters(params.toolCall.title ?? "OpenCode tool").slice(
                  0,
                  MAX_PERMISSION_TITLE_CHARS,
                ) || "OpenCode tool",
              ...(params.toolCall.kind ? { toolKind: params.toolCall.kind } : {}),
              ...(inputSummary ? { inputSummary } : {}),
              options,
            };
            return await new Promise<import("@agentclientprotocol/sdk").RequestPermissionResponse>(
              (resolve) => {
                permissionRequests.set(requestId, {
                  sessionId: params.sessionId,
                  options: new Map(options.map((option) => [option.optionId, option.kind])),
                  resolve: (response) => {
                    permissionRequests.delete(requestId);
                    resolve(response);
                  },
                });
                getPermissionEmitter(params.sessionId).fire({
                  type: "requested",
                  request,
                });
              },
            );
          },
          sessionUpdate: async (params) => {
            emitters.get(params.sessionId)?.fire(params.update);
          },
        }),
        acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
      );
      const created: RuntimeConnection = {
        child,
        executablePath: resolution.executablePath,
        connection,
        canCloseSessions: false,
        sessions,
        prompts,
        permissionRequests,
      };
      child.once("error", () => undefined);
      void connection.closed.then(() => {
        cancelAllPermissions(created);
        if (runtime === created && !created.disposePromise) runtime = undefined;
      });

      try {
        const initialized = await request(
          created,
          connection.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientInfo: { name: "ZCode", version: "1" },
            clientCapabilities: {},
          }),
          "opencode.acp-initialize-failed",
        );
        if (terminallyDisposed) throw new Error("opencode.runtime-disposed");
        created.canCloseSessions = Boolean(
          initialized.agentCapabilities?.sessionCapabilities?.close,
        );
        runtime = created;
        return created;
      } catch (error) {
        await stopRuntime(created);
        throw error;
      }
    })();
    initializing = starting;
    initializingExecutablePath = resolution.executablePath;
    try {
      return await starting;
    } finally {
      if (initializing === starting) {
        initializing = undefined;
        initializingExecutablePath = undefined;
      }
    }
  };

  const stopRuntime = async (target: RuntimeConnection): Promise<void> => {
    if (target.disposePromise) return target.disposePromise;
    const disposing = (async () => {
      for (const sessionId of target.sessions.keys()) {
        cancelSessionPermissions(target, sessionId);
        if (target.prompts.has(sessionId)) {
          await request(
            target,
            target.connection.cancel({ sessionId }),
            "opencode.acp-cancel-timeout",
            options.cleanupRequestTimeoutMs ?? CLEANUP_REQUEST_TIMEOUT_MS,
          ).catch(() => undefined);
        }
      }
      cancelAllPermissions(target);
      if (target.canCloseSessions) {
        for (const sessionId of target.sessions.keys()) {
          await request(
            target,
            target.connection.closeSession({ sessionId }),
            "opencode.acp-close-timeout",
            options.cleanupRequestTimeoutMs ?? CLEANUP_REQUEST_TIMEOUT_MS,
          ).catch(() => undefined);
        }
      }
      await (options.terminateProcessTreeAndWait ?? terminateProcessTreeAndWait)(target.child, {
        ownedProcessGroupId: target.child.pid,
        forceAfterMs: 1_500,
        waitAfterForceMs: 1_500,
      }).catch(() => undefined);
      for (const emitter of emitters.values()) emitter.dispose();
      emitters.clear();
      for (const emitter of permissionEmitters.values()) emitter.dispose();
      permissionEmitters.clear();
      target.sessions.clear();
      target.prompts.clear();
      if (runtime === target) runtime = undefined;
    })();
    target.disposePromise = disposing;
    return disposing;
  };

  return {
    getCliStatus: async ({ cliPath } = {}) => {
      const resolution = await (options.resolveCli ?? resolveCliCommand)(cliPath);
      if (resolution.status !== "resolved") {
        const platform = options.platform ?? process.platform;
        const installSupported =
          resolution.status === "missing" &&
          (platform === "win32"
            ? Boolean(await (options.resolveWinget ?? resolveWingetCommand)())
            : resolution.installSupported);
        return {
          status: resolution.status === "missing" ? "missing" : "unavailable",
          diagnostic: resolution.diagnostic,
          installSupported,
        };
      }
      return await runVersionCommand(resolution.spec);
    },

    installCli: async ({ cliPath } = {}): Promise<OpenCodeInstallResult> => {
      const resolution = await (options.resolveCli ?? resolveCliCommand)(cliPath);
      const platform = options.platform ?? process.platform;
      if (cliPath?.trim()) {
        if (resolution.status === "resolved") {
          const current = await runVersionCommand(resolution.spec);
          if (current.status === "available") {
            return {
              status: "already-installed",
              version: current.version,
              executablePath: current.executablePath,
            };
          }
        }
        return {
          status: "failed",
          diagnostic: "opencode.install-explicit-path-selected",
        };
      }
      if (platform === "win32") {
        if (resolution.status === "resolved") {
          const current = await runVersionCommand(resolution.spec);
          if (current.status === "available") {
            return {
              status: "already-installed",
              version: current.version,
              executablePath: current.executablePath,
            };
          }
        }
        if (resolution.status !== "missing") {
          return {
            status: "failed",
            diagnostic: "opencode.install-requires-missing-cli",
          };
        }
        const wingetPath = await (options.resolveWinget ?? resolveWingetCommand)();
        if (!wingetPath)
          return {
            status: "failed",
            diagnostic: "opencode.install-platform-unsupported",
          };
        const installed = await installWingetPackage(
          wingetPath,
          options.installTimeoutMs ?? INSTALL_TIMEOUT_MS,
        );
        if (!installed) return { status: "failed", diagnostic: "opencode.install-failed" };
        const afterResolution = await (options.resolveCli ?? resolveCliCommand)();
        if (afterResolution.status !== "resolved") {
          return {
            status: "failed",
            diagnostic: "opencode.install-verification-failed",
          };
        }
        const after = await runVersionCommand(afterResolution.spec);
        return after.status === "available"
          ? {
              status: "installed",
              version: after.version,
              executablePath: after.executablePath,
            }
          : {
              status: "failed",
              diagnostic: "opencode.install-verification-failed",
            };
      }
      // Причина: установка на POSIX ранее требовала resolved CLI и отказывала именно при отсутствии бинарника, хотя UI уже предлагал Install. Разрешаем установку для подтверждённого missing status и сохраняем повторную проверку версии после неё.
      if (resolution.status === "resolved") {
        const before = await runVersionCommand(resolution.spec);
        if (before.status === "available") {
          return {
            status: "already-installed",
            version: before.version,
            executablePath: before.executablePath,
          };
        }
        if (before.status !== "missing") {
          return {
            status: "failed",
            diagnostic: "opencode.install-requires-missing-cli",
          };
        }
      } else if (resolution.status !== "missing" || !resolution.installSupported) {
        return {
          status: "failed",
          diagnostic: "opencode.install-requires-missing-cli",
        };
      }
      const installed = await installPackage(options.installTimeoutMs ?? INSTALL_TIMEOUT_MS);
      if (!installed) return { status: "failed", diagnostic: "opencode.install-failed" };
      const afterResolution = await (options.resolveCli ?? resolveCliCommand)();
      if (afterResolution.status !== "resolved") {
        return {
          status: "failed",
          diagnostic: "opencode.install-verification-failed",
        };
      }
      const after = await runVersionCommand(afterResolution.spec);
      return after.status === "available"
        ? {
            status: "installed",
            version: after.version,
            executablePath: after.executablePath,
          }
        : {
            status: "failed",
            diagnostic: "opencode.install-verification-failed",
          };
    },

    startSession: async ({ cwd, cliPath }): Promise<OpenCodeAcpSession> => {
      if (!isAbsolute(cwd)) throw new Error("opencode.workspace-path-must-be-absolute");
      const workspace = await stat(cwd).catch(() => null);
      if (!workspace?.isDirectory()) throw new Error("opencode.workspace-directory-unavailable");
      const resolution = await (options.resolveCli ?? resolveCliCommand)(cliPath);
      if (resolution.status !== "resolved") throw new Error(resolution.diagnostic);
      const status = await runVersionCommand(resolution.spec);
      if (status.status !== "available") throw new Error("opencode.cli-not-ready");
      // `serve` 与 stdio ACP 是不同命令；此前检查 `serve --stdio` 会误拒绝官方 `opencode acp`。由真实 initialize 握手确认协议兼容。
      const activeRuntime = await ensureRuntime(cwd, resolution);
      try {
        const result = await request(
          activeRuntime,
          activeRuntime.connection.newSession({ cwd, mcpServers: [] }),
          "opencode.acp-session-create-failed",
        );
        const session: SessionState = {
          cwd,
          configOptions: result.configOptions ?? [],
          closed: false,
        };
        activeRuntime.sessions.set(result.sessionId, session);
        getEmitter(result.sessionId);
        return {
          sessionId: result.sessionId,
          cwd,
          configOptions: session.configOptions,
        };
      } catch (error) {
        await stopRuntime(activeRuntime);
        throw error;
      }
    },

    setConfigOption: async ({ sessionId, configId, value }): Promise<OpenCodeAcpSession> => {
      const activeRuntime = runtime;
      const session = activeRuntime?.sessions.get(sessionId);
      if (!activeRuntime || !session || session.closed)
        throw new Error("opencode.session-not-found");
      if (activeRuntime.prompts.has(sessionId)) throw new Error("opencode.session-busy");
      const option = session.configOptions.find((candidate) => candidate.id === configId);
      if (!option || (option.type === "select" && typeof value !== "string")) {
        throw new Error("opencode.config-option-invalid");
      }
      if (option.type === "boolean" && typeof value !== "boolean") {
        throw new Error("opencode.config-option-invalid");
      }
      const configRequest =
        option.type === "select"
          ? {
              sessionId,
              configId,
              type: "select" as const,
              value: value as string,
            }
          : {
              sessionId,
              configId,
              type: "boolean" as const,
              value: value as boolean,
            };
      const result = await request(
        activeRuntime,
        activeRuntime.connection.setSessionConfigOption(configRequest),
        "opencode.config-option-update-failed",
      );
      session.configOptions = result.configOptions;
      return {
        sessionId,
        cwd: session.cwd,
        configOptions: session.configOptions,
      };
    },

    prompt: async ({ sessionId, text }): Promise<OpenCodeAcpPromptResult> => {
      const activeRuntime = runtime;
      const session = activeRuntime?.sessions.get(sessionId);
      if (!activeRuntime || !session || session.closed)
        throw new Error("opencode.session-not-found");
      if (activeRuntime.prompts.has(sessionId)) throw new Error("opencode.session-busy");
      const promptText = text.trim();
      if (!promptText || promptText.length > 64_000) throw new Error("opencode.prompt-invalid");
      const operation = request(
        activeRuntime,
        activeRuntime.connection.prompt({
          sessionId,
          prompt: [{ type: "text", text: promptText }],
        }),
        "opencode.prompt-failed",
        options.promptTimeoutMs ?? PROMPT_TIMEOUT_MS,
      );
      activeRuntime.prompts.set(sessionId, operation);
      try {
        return await operation;
      } finally {
        if (activeRuntime.prompts.get(sessionId) === operation) {
          activeRuntime.prompts.delete(sessionId);
        }
      }
    },

    cancel: async ({ sessionId }) => {
      const activeRuntime = runtime;
      if (!activeRuntime?.prompts.has(sessionId)) return;
      cancelSessionPermissions(activeRuntime, sessionId);
      try {
        await request(
          activeRuntime,
          activeRuntime.connection.cancel({ sessionId }),
          "opencode.acp-cancel-timeout",
          options.cleanupRequestTimeoutMs ?? CLEANUP_REQUEST_TIMEOUT_MS,
        );
      } catch (error) {
        await stopRuntime(activeRuntime);
        throw error;
      }
    },

    respondToPermission: async ({ sessionId, requestId, optionId }) => {
      const activeRuntime = runtime;
      const pending = activeRuntime?.permissionRequests.get(requestId);
      if (!activeRuntime || !pending || pending.sessionId !== sessionId) {
        throw new Error("opencode.permission-request-not-found");
      }
      if (!pending.options.has(optionId)) throw new Error("opencode.permission-option-invalid");
      settlePermission(activeRuntime, requestId, {
        outcome: "selected",
        optionId,
      });
    },

    closeSession: async ({ sessionId }) => {
      const activeRuntime = runtime;
      const session = activeRuntime?.sessions.get(sessionId);
      if (!activeRuntime || !session || session.closed) return;
      cancelSessionPermissions(activeRuntime, sessionId);
      try {
        if (activeRuntime.prompts.has(sessionId)) {
          await request(
            activeRuntime,
            activeRuntime.connection.cancel({ sessionId }),
            "opencode.acp-cancel-timeout",
            options.cleanupRequestTimeoutMs ?? CLEANUP_REQUEST_TIMEOUT_MS,
          );
        }
        if (activeRuntime.canCloseSessions) {
          await request(
            activeRuntime,
            activeRuntime.connection.closeSession({ sessionId }),
            "opencode.acp-close-timeout",
            options.cleanupRequestTimeoutMs ?? CLEANUP_REQUEST_TIMEOUT_MS,
          );
        }
      } catch {
        await stopRuntime(activeRuntime);
        return;
      }
      session.closed = true;
      activeRuntime.sessions.delete(sessionId);
      emitters.get(sessionId)?.dispose();
      emitters.delete(sessionId);
      permissionEmitters.get(sessionId)?.dispose();
      permissionEmitters.delete(sessionId);
      if (activeRuntime.sessions.size === 0) await stopRuntime(activeRuntime);
    },

    onSessionUpdate: ({ sessionId }) => getEmitter(sessionId).event,
    onPermissionEvent: ({ sessionId }) => getPermissionEmitter(sessionId).event,

    disposeAllAndWait: async () => {
      if (disposePromise) return disposePromise;
      terminallyDisposed = true;
      const currentRuntime = runtime;
      const currentInitialization = initializing;
      disposePromise = (async () => {
        if (currentRuntime) await stopRuntime(currentRuntime);
        const initializingRuntime = await currentInitialization?.catch(() => undefined);
        if (initializingRuntime) await stopRuntime(initializingRuntime);
      })();
      return disposePromise;
    },
  };
}
