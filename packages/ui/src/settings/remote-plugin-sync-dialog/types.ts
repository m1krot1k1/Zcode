import type {
  PluginSyncCandidate,
  PluginSyncImportResult,
  RemoteTarget,
  RendererTelemetryEventPayload,
  ZCodePluginOptionValue,
  ZCodePluginUserConfigOption,
} from "@zcode/shared";
import type { IPluginSyncService, IZCodeAgentService } from "@zcode/services";

export type RemotePluginSyncDialogStep =
  | "loading"
  | "selection"
  | "preflighting"
  | "syncing"
  | "complete";
export type Step = RemotePluginSyncDialogStep;
export type RemotePluginSyncKind = "inline" | "marketplace";

export interface RemotePluginSyncPluginOptions {
  configuredOptions: Record<string, ZCodePluginOptionValue>;
  userConfig: Record<string, ZCodePluginUserConfigOption>;
}

export type RemotePluginSyncAgentService = Pick<
  IZCodeAgentService,
  | "addPluginMarketplace"
  | "cancelPluginOperation"
  | "configurePlugin"
  | "getPluginsOverview"
  | "installPlugin"
  | "listPlugins"
  | "setPluginEnabled"
>;

export const REMOTE_PLUGIN_SYNC_CONFIG_SCOPE = "user" as const;

export interface RemotePluginSyncCandidate {
  id: string;
  kind: RemotePluginSyncKind;
  name: string;
  pluginId: string;
  marketplace: string;
  description?: string;
  version?: string;
  path?: string;
  enabled: boolean;
  componentTypes: string[];
  inlineCandidate?: PluginSyncCandidate;
  pluginOptions?: RemotePluginSyncPluginOptions;
  marketplacePlugin?: {
    marketplaceSourceArchive?: {
      marketplaceId: string;
      source: Record<string, unknown>;
    };
    marketplaceSourceInput?: string;
    pluginName: string;
  };
}

export interface RemotePluginSyncCandidateStatus {
  candidateId: string;
  exists: boolean;
  path?: string;
  reason?: "samePluginId" | "targetExists";
  remoteMarketplaceExists?: boolean;
}

export interface RemotePluginSyncRow {
  candidate: RemotePluginSyncCandidate;
  exists: boolean;
  path?: string;
  reason?: "samePluginId" | "targetExists";
  remoteMarketplaceExists?: boolean;
}

export type RemotePluginSyncResultStatus =
  | PluginSyncImportResult["results"][number]["status"]
  | "stopped";

export interface RemotePluginSyncResultItem extends Omit<
  PluginSyncImportResult["results"][number],
  "status"
> {
  status: RemotePluginSyncResultStatus;
}

export interface RemotePluginSyncRunResult {
  results: RemotePluginSyncResultItem[];
}

export type RemotePluginSyncProgressStatus = "queued" | "syncing" | RemotePluginSyncResultStatus;

export interface RemotePluginSyncProgressEvent {
  candidateId: string;
  log: string;
  pluginId: string;
  result?: RemotePluginSyncResultItem;
  status: RemotePluginSyncProgressStatus;
}

export interface RemotePluginSyncStopControl {
  cancelOperation?: (operationId: string) => Promise<void>;
  isStopped: (candidateId: string) => boolean;
  waitForStop?: (candidateId: string) => Promise<void>;
}

export interface RemotePluginSyncProgressView {
  logs: string[];
  result?: RemotePluginSyncResultItem;
  status: RemotePluginSyncProgressStatus;
}

export interface RemotePluginSyncDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  localPluginSyncService: IPluginSyncService;
  remotePluginSyncService: IPluginSyncService;
  localZCodeAgentService?: RemotePluginSyncAgentService | null;
  remoteZCodeAgentService?: RemotePluginSyncAgentService | null;
  remoteTarget: RemoteTarget;
  localWorkspacePath?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  onSynced: () => Promise<void> | void;
}

export interface RemotePluginSyncWorkspace {
  workspaceIdentity?: string;
  workspacePath: string;
}

/** 单步远端同步执行上下文：进度回调、取消信号与停止控制。 */
export interface RemotePluginSyncExecParams {
  onItemProgress?: (event: RemotePluginSyncProgressEvent) => void;
  signal?: AbortSignal;
  stopControl?: RemotePluginSyncStopControl;
}

export interface RemotePluginSyncRunParams extends RemotePluginSyncExecParams {
  localPluginSyncService: IPluginSyncService;
  reportTelemetryEvent?: (event: RendererTelemetryEventPayload) => void | Promise<void>;
  remotePluginSyncService: IPluginSyncService;
  remoteWorkspaceIdentity?: string;
  remoteWorkspacePath: string;
  remoteZCodeAgentService?: RemotePluginSyncAgentService | null;
  rows: readonly RemotePluginSyncRow[];
}

export type RemotePluginSyncRemoteParams = Omit<
  RemotePluginSyncRunParams,
  "reportTelemetryEvent" | "rows"
>;
