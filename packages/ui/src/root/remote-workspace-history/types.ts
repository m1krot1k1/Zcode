import type { BindRemoteWorkspaceSessionContextResult } from "@zcode/shared";
import type { WindowTabState } from "@/store/tabStore.js";

/** Host bind 完成后的权威 workspace scope；调用方只能消费这里返回的身份。 */
export type BoundRemoteWorkspaceScope = Pick<
  BindRemoteWorkspaceSessionContextResult,
  "workspacePath" | "workspaceIdentity" | "previousWorkspaceIdentity" | "workspacePurpose"
>;

export interface RemoteWorkspaceTabStoreReader {
  getState(): {
    tabs: WindowTabState[];
  };
}

export interface RemoteWorkspaceReconnectRendererState {
  attemptedWorkspaceKeys: Set<string>;
  currentRendererDisconnectedSourceServerIds: Set<string>;
  pendingTerminallyDisconnectedSourceServerIds: Set<string>;
  observedOnlineSourceServerIds: Set<string>;
}
