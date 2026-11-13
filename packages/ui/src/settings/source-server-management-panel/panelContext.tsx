import { createContext, useContext } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type {
  AppSettings,
  ConnectionProfile,
  IPlatformService,
  SourceServerConnectionStateSnapshot,
  SourceServerManagementSnapshot,
  SourceServerMigrationReport,
  SourceServerOperationLog,
  SourceServerRecord,
} from "@zcode/shared";
import type { ISourceServerManagementService } from "@zcode/services";
import type { RemoteConnectionProgress } from "@/remote-connection-flow/contract.js";
import type { RemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import type { ConfirmDialogRequest } from "@/store/confirmDialogStore.js";

export interface EditingConnectionState {
  profile: ConnectionProfile;
  server?: SourceServerRecord;
  focusField?: "host" | "auth";
}

export type RunPanelOperation = (
  key: string,
  operation: () => Promise<SourceServerManagementSnapshot | void>,
  scopes?: readonly string[],
) => Promise<void>;

export interface PanelRuntime {
  management: ISourceServerManagementService;
  platform: IPlatformService | null;
  snapshot: SourceServerManagementSnapshot | null;
  stateByProfile: ReadonlyMap<string, SourceServerConnectionStateSnapshot>;
  busyOperations: ReadonlyMap<string, readonly string[]>;
  busyScopes: ReadonlySet<string>;
  logsByProfileId: Record<string, SourceServerOperationLog[]>;
  migrationReports: Record<string, SourceServerMigrationReport | undefined>;
  deferredUpdates: ReadonlySet<string>;
  background: RemoteConnectionProgress | null;
  deviceCardsRef: RefObject<Map<string, HTMLElement>>;
  confirmDialog: (request: ConfirmDialogRequest) => Promise<boolean>;
  workspaceTabs: WorkspaceTabState[];
  run: RunPanelOperation;
  applySnapshot: (snapshot: SourceServerManagementSnapshot) => void;
  removeProfile: (profile: ConnectionProfile) => Promise<void>;
  removeSourceServer: (server: SourceServerRecord) => Promise<void>;
  updateProfile: (profile: ConnectionProfile) => Promise<void>;
  handleProfileAction: (
    profile: ConnectionProfile,
    presentation: RemoteConnectionPresentation,
    server?: SourceServerRecord,
  ) => void;
  toggleMigrationReport: (sourceServerId: string) => void;
  runMigrationOperation: (
    key: string,
    sourceServerId: string,
    operation: () => Promise<SourceServerMigrationReport>,
  ) => Promise<void>;
  onCreateConnection?: () => void;
  onConnectProfile?: (profileId: string) => Promise<void> | void;
  onDisconnectSource?: (sourceServerId: string) => Promise<void>;
  onShowInSidebar?: (sourceServerId: string) => void;
  onOpenProject?: (sourceServerId: string, path: string, profileId?: string) => Promise<void>;
  onShowUpdateDetails?: (sourceServerId: string) => void;
  onUpdateSettings?: (patch: Partial<AppSettings>) => Promise<unknown> | void;
  setEditingConnection: Dispatch<SetStateAction<EditingConnectionState | null>>;
  setErrorDetailsProfile: Dispatch<SetStateAction<ConnectionProfile | null>>;
  expandedProjectSources: Set<string>;
  setExpandedProjectSources: Dispatch<SetStateAction<Set<string>>>;
  expandedSavedConnectionSources: Set<string>;
  setExpandedSavedConnectionSources: Dispatch<SetStateAction<Set<string>>>;
  logExpansionBySource: ReadonlyMap<string, boolean>;
  setLogExpansionBySource: Dispatch<SetStateAction<ReadonlyMap<string, boolean>>>;
  startupAutoReconnect: boolean;
  setStartupAutoReconnect: Dispatch<SetStateAction<boolean>>;
}

/** 面板内部的运行时依赖；只有 settings 面板子树消费，不进入公开 API。 */
export const PanelRuntimeContext = createContext<PanelRuntime | null>(null);

export function usePanelRuntime(): PanelRuntime {
  const runtime = useContext(PanelRuntimeContext);
  if (!runtime) throw new Error("usePanelRuntime 必须在 PanelRuntimeContext 内使用");
  return runtime;
}
