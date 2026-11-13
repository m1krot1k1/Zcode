import type { RemoteSessionsState } from "./types.js";

export function createRemoteSessionsState(): RemoteSessionsState {
  return {
    pendingByRequestKey: new Map(),
    pendingProjectNavigations: new Map(),
    pendingWorkspaceBindsByRequestKey: new Map(),
    workspaceContextBindFlightsBySessionId: new Map(),
    routesBySessionId: new Map(),
    listenedHosts: new WeakSet(),
    pendingProviderProvisioningExecutions: new Map(),
    appShutdownStarted: false,
  };
}

export function requestKey(webContentsId: number, requestId: string): string {
  return `${webContentsId}\0${requestId}`;
}
