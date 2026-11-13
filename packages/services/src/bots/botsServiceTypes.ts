import type { IBroadcastService } from "../broadcast/broadcast.js";
import type { ICredentialService } from "../credential/credential.js";
import type { IModelSelectionService } from "../model-provider/providerFacadeServices.js";
import type { IZCodeTaskService } from "../session/zcodeTaskService.js";
import type { ISettingService } from "../setting/setting.js";
import type { IBotsService } from "./bots.js";
import { BotsRepo } from "./repo.js";
import type {
  BotConfig,
  BotContextState,
  BotInboundMessage,
  BotWorkspaceRef,
  BotsConfigFile,
  Locale,
  ZCodePromptAttachment,
  ZCodeTaskMeta,
} from "@zcode/shared";
import type { BotRemoteRuntimeService } from "#src/bot-project-runtime/contract.js";
import type { IProjectService } from "#src/project/contract.js";
import type { IRemoteProjectService } from "#src/remote-projects/contract.js";

export type StreamingCardTimelineBlock =
  | {
      type: "message";
      text: string;
    }
  | {
      type: "tools";
      toolIds: string[];
    };

export interface BotsServiceDeps {
  credentialService: ICredentialService;
  zcodeTaskService: IZCodeTaskService;
  projectService: Pick<IProjectService, "readProjects" | "readTree" | "prepareSession">;
  remoteProjectService?: Pick<IRemoteProjectService, "readDirectory">;
  ownerHostId?: string;
  broadcastService?: IBroadcastService;
  settingService?: ISettingService;
  modelSelectionService: Pick<IModelSelectionService, "getView">;
  remoteWorkspaceService?: BotRemoteWorkspaceService;
  repo?: BotsRepo;
  // 修复原因：desktop-attached 远端启动阶段不应抢跑 bot 轮询、runtime lock 和模型候选缓存；
  // 这些后台任务属于本地桌面 host，不属于 SSH/Docker 远端首屏连接路径。
  runStartupBackgroundTasks?: boolean;
}

export type BotRemoteWorkspaceReconnectResult = Awaited<
  ReturnType<BotRemoteRuntimeService["ensureConnected"]>
>;

type BotRemoteWorkspaceService = Pick<BotRemoteRuntimeService, "isConnected" | "ensureConnected"> &
  Partial<Omit<BotRemoteRuntimeService, "isConnected" | "ensureConnected">> & {
    resolveWorkspace?: (target: {
      workspacePath: string;
      workspaceIdentity: string;
    }) => Promise<{ workspacePath: string; workspaceIdentity: string } | null>;
  };

export interface PreparedTopicMessage {
  generation: number;
  message: BotInboundMessage;
  prepared: PreparedBotMessageContent;
}

export interface PreparedBotMessageContent {
  content: string;
  zcodeAttachments: ZCodePromptAttachment[];
}

export type BotAuthorizedCommand =
  | "help"
  | "status"
  | "new"
  | "reconnect"
  | "workspace"
  | "model"
  | "mode"
  | "thoughtLevel"
  | "task"
  | "reply"
  | "stop"
  | "message"
  | "approve";

export interface BindCodeRecord {
  botId: string;
  code: string;
  allowedWorkspaces: string[];
  expiresAt: number;
}

export interface BotModelOption {
  id: string;
  label: string;
  description?: string;
}

export interface BotModelProviderOption {
  id: string;
  label: string;
  description?: string;
  models: BotModelOption[];
}

export interface BotTaskSelectionEntry {
  task: ZCodeTaskMeta;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface BotWorkspaceSelectionEntry {
  workspace: BotWorkspaceRef;
}

export type BotPermissionOptionDisplayKind =
  | "allowOnce"
  | "allowAlways"
  | "rejectOnce"
  | "rejectAlways"
  | "custom";

export type BotsServiceInstance = IBotsService & {
  disposeAll(): void;
  disposeAllAndWait(): Promise<void>;
};

export type BotAuthorizedContext = {
  ok: true;
  config: BotsConfigFile;
  bot: BotConfig;
  user: BotConfig;
  context: BotContextState;
  locale: Locale | undefined;
};
