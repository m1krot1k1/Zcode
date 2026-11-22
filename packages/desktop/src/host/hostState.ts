import type { IDisposable } from "@zcode/rpc";
import type { Locale, SourceServerArtifactPolicy } from "@zcode/shared";
import type { ServiceCollection } from "@zcode/services";
import type { HostApiNetworkTransport } from "@zcode/services/node";
import type { createHostDatabaseStartup } from "./database-startup/hostDatabaseStartup.js";
import type { HostRemoteConnectionCapabilities } from "./hostRemoteConnection.js";
import type { HostShutdownResult } from "./hostShutdownPhases.js";
import type { startHostSelfResourceTelemetry } from "./hostSelfResourceTelemetry.js";
import type { SourceServerConnectionManager } from "./sourceServerConnectionManager.js";
import type { SourceServerDirectory } from "./sourceServerDirectory.js";
import type { SourceServerManagementService } from "./sourceServerManagementService.js";
import type { createWindowHostAttachmentRegistry } from "./windowHostAttachmentRegistry.js";
import type { createWindowHostControllerRuntime } from "./windowHostControllerService.js";
import type { createWindowRemoteConnectionRegistry } from "./windowRemoteConnectionRegistry.js";

export type HostRemoteRegistry = ReturnType<
  typeof createWindowRemoteConnectionRegistry<ServiceCollection, HostRemoteConnectionCapabilities>
>;
export type HostControllerRuntime = ReturnType<typeof createWindowHostControllerRuntime>;
export type HostAttachmentRegistry = ReturnType<
  typeof createWindowHostAttachmentRegistry<
    ServiceCollection,
    Electron.MessagePortMain,
    HostRemoteConnectionCapabilities
  >
>;

/**
 * Host 进程唯一的可变状态所有者。
 *
 * 入口拆分后各域模块共享同一进程级状态（服务集合、Source 连接、窗口 Registry、
 * shutdown 标志），本模块只保存引用与 getter/setter，不承载业务逻辑；
 * 避免每个域各存一份状态或通过多层闭包复制同一事实。
 */
export const hostState: {
  applicationLocale: Locale | undefined;
  activeHostApiNetworkTransport: HostApiNetworkTransport | null;
  activeServices: ServiceCollection | null;
  databaseStartup: ReturnType<typeof createHostDatabaseStartup> | undefined;
  pendingStartupAttachments: Map<string, () => void>;
  sourceServerDirectory: SourceServerDirectory | null;
  sourceServerConnectionManager: SourceServerConnectionManager | null;
  sourceServerManagementService: SourceServerManagementService | null;
  sourceServerArtifactPolicy: SourceServerArtifactPolicy;
  sourceServerDisplayNameById: Map<string, string>;
  sourceSettingsStateSubscription: IDisposable | null;
  sourceServerRuntimeInitializeFlight: Promise<SourceServerConnectionManager> | null;
  activeWorkspaceBindRequestIds: Set<string>;
  cancelledWorkspaceBindRequestIds: Set<string>;
  workspaceBindAbortControllers: Map<string, AbortController>;
  projectNavigationAbortControllers: Map<string, AbortController>;
  activeLocalResourceTelemetry: IDisposable | null;
  hasDisposedHostResources: boolean;
  disposeHostResourcesInFlight: Promise<HostShutdownResult> | null;
  hostSelfResourceTelemetry: ReturnType<typeof startHostSelfResourceTelemetry> | null;
  windowRemoteConnectionRegistry: HostRemoteRegistry | null;
  windowHostControllerRuntime: HostControllerRuntime | null;
  windowHostAttachmentRegistry: HostAttachmentRegistry | null;
} = {
  applicationLocale: undefined,
  activeHostApiNetworkTransport: null,
  activeServices: null,
  databaseStartup: undefined,
  pendingStartupAttachments: new Map(),
  sourceServerDirectory: null,
  sourceServerConnectionManager: null,
  sourceServerManagementService: null,
  sourceServerArtifactPolicy: "release-versioned",
  sourceServerDisplayNameById: new Map(),
  sourceSettingsStateSubscription: null,
  sourceServerRuntimeInitializeFlight: null,
  activeWorkspaceBindRequestIds: new Set(),
  cancelledWorkspaceBindRequestIds: new Set(),
  workspaceBindAbortControllers: new Map(),
  projectNavigationAbortControllers: new Map(),
  activeLocalResourceTelemetry: null,
  hasDisposedHostResources: false,
  disposeHostResourcesInFlight: null,
  hostSelfResourceTelemetry: null,
  windowRemoteConnectionRegistry: null,
  windowHostControllerRuntime: null,
  windowHostAttachmentRegistry: null,
};

export function remoteRegistry(): HostRemoteRegistry {
  const registry = hostState.windowRemoteConnectionRegistry;
  if (!registry) throw new Error("Window Host remote registry is not initialized");
  return registry;
}

export function controllerRuntime(): HostControllerRuntime {
  const runtime = hostState.windowHostControllerRuntime;
  if (!runtime) throw new Error("Window Host controller runtime is not initialized");
  return runtime;
}

export function attachmentRegistry(): HostAttachmentRegistry {
  const registry = hostState.windowHostAttachmentRegistry;
  if (!registry) throw new Error("Window Host attachment registry is not initialized");
  return registry;
}
