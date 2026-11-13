import type {
  BotAuthorizedCommand,
  BotAuthorizedContext,
  BotModelOption,
  BotModelProviderOption,
  BotRemoteWorkspaceReconnectResult,
  BotTaskSelectionEntry,
  BotWorkspaceSelectionEntry,
  PreparedBotMessageContent,
  PreparedTopicMessage,
} from "./botsServiceTypes.js";
import type { BotsServiceState } from "./botsServiceContext.js";
import type { BotsServiceCommandPorts } from "./botsServiceCommandPorts.js";
import type { ModelSelectionView } from "../model-provider/providerFacadeServices.js";
import type { IZCodeTaskService } from "../session/zcodeTaskService.js";
import type { ZCodeAgentAppRuntimePreferences } from "../zcode-agent/zcodeAgent.js";
import type {
  BotAutomationRunWatchParams,
  BotBindCodeResult,
  BotCreateBindCodeParams,
  BotFeishuRegistrationBeginParams,
  BotFeishuRegistrationBeginResult,
  BotFeishuRegistrationPollParams,
  BotFeishuRegistrationPollResult,
  BotListWorkspaceRefsParams,
  BotSaveBotParams,
  BotTestResult,
  BotUserConfigOptionsParams,
  BotWeixinRegistrationBeginResult,
  BotWeixinRegistrationPollParams,
  BotWeixinRegistrationPollResult,
} from "./bots.js";
import type { BotMessageId } from "./messages.js";
import type { BotAssistantReplyBlock, BotReplyToolCallState } from "./replyFormatter.js";
import type {
  BotActor,
  BotCommand,
  BotConfig,
  BotContextState,
  BotDraftOptions,
  BotGroupDelivery,
  BotGroupInputProgress,
  BotGroupInputSource,
  BotGroupInputStatus,
  BotInboundMessage,
  BotOutboundMessage,
  BotPendingElicitation,
  BotProvider,
  BotProviderCallbackResult,
  BotReplyGranularity,
  BotRuntimeInfo,
  BotServiceStatus,
  BotState,
  BotStructuredElicitationResponse,
  BotTaskBroadcastPayload,
  BotWorkspaceRef,
  BotsConfigFile,
  BotsStateFile,
  Locale,
  ModelSelection,
  SelectionPrompt,
  TaskStreamMirrorableEvent,
  ZCodeAssistantMessagePart,
  ZCodeAutomationBotDeliveryTarget,
  ZCodeConfigOption,
  ZCodeElicitationQuestion,
  ZCodePromptAttachment,
  ZCodeProvider,
  ZCodeStreamEvent,
  ZCodeTaskMeta,
} from "@zcode/shared";
import type { ProjectCatalogSnapshot } from "#src/project-catalog/index.js";

export interface BotsServicePorts {
  administratorErrorReply(
    actor: BotActor,
    bot: BotConfig | null | undefined,
    error: unknown,
    reply: BotOutboundMessage,
  ): BotOutboundMessage;
  administratorReply(
    actor: BotActor,
    bot: Pick<BotConfig, "providerUserId">,
    reason: string,
    reply: BotOutboundMessage,
  ): BotOutboundMessage;
  admitAutoReplyTurn(message: BotInboundMessage): Promise<boolean>;
  appendStreamingCardMessageChunk: (content: string) => void;
  appendStreamingCardMessages: (messages: readonly string[]) => void;
  appendStreamingCardTool: (toolId: string) => void;
  applyDraftConfigOptions(context: BotContextState, taskId: string, traceId: string): Promise<void>;
  beginFeishuRegistration(
    params?: BotFeishuRegistrationBeginParams,
  ): Promise<BotFeishuRegistrationBeginResult>;
  beginWeixinRegistration(): Promise<BotWeixinRegistrationBeginResult>;
  bindProject(
    workspace: BotWorkspaceRef,
  ): Promise<
    Pick<
      BotContextState,
      | "projectId"
      | "hostId"
      | "workspacePath"
      | "workspaceIdentity"
      | "workspaceId"
      | "additionalDirectories"
    >
  >;
  blockDisconnectedRemoteWorkspace(params: {
    message: BotInboundMessage;
    context: BotContextState;
    locale: Locale | undefined;
    requestedCommand: BotAuthorizedCommand;
  }): Promise<BotOutboundMessage[] | null>;
  broadcastPendingElicitationProgress(
    context: BotContextState,
    pending: BotPendingElicitation,
  ): Promise<void>;
  broadcastTaskConfigSync(params: {
    context: BotContextState;
    taskId: string;
    task?: ZCodeTaskMeta | null;
    provider?: ZCodeProvider;
    configOptions?: ZCodeConfigOption[];
  }): Promise<void>;
  broadcastTaskListChange(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
    taskId: string,
    event: BotTaskBroadcastPayload["event"],
    extras?: Partial<
      Pick<
        BotTaskBroadcastPayload,
        | "task"
        | "provider"
        | "configOptions"
        | "prompt"
        | "permissionRequest"
        | "elicitationRequest"
        | "requestId"
        | "error"
      >
    >,
  ): Promise<void>;
  broadcastTaskStreamEvent(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
    event: ZCodeStreamEvent,
  ): Promise<void>;
  buildActiveTaskDraftOptions(context: BotContextState): Promise<BotDraftOptions>;
  buildBotElicitationContent(
    pending: BotPendingElicitation,
    answers?: BotPendingElicitation["answers"],
  ): Record<string, unknown>;
  buildHelpText(
    locale: Locale | undefined,
    bot: Pick<BotConfig, "allowedCommands">,
    groupRole?: "owner" | "member",
  ): string;
  buildInitializedDraftOptions(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
    provider?: ZCodeProvider,
  ): Promise<BotDraftOptions>;
  cancelGroupInput(
    message: BotInboundMessage,
    sourceCommandId: string,
  ): Promise<BotOutboundMessage[]>;
  cancelGroupTopicInputs(actor: BotActor): Promise<void>;
  cancelTopicInputs(actor: BotActor): Promise<void>;
  capturePrivateContextToken(message: BotInboundMessage): Promise<void>;
  clearPendingElicitationForRequest(context: BotContextState, requestId: string): Promise<void>;
  clearPendingElicitationSelection(pending: BotPendingElicitation): void;
  clearPendingSelection(actor: BotActor): void;
  clearPrivatePendingSelectionsForBot(botId: string): void;
  createAssistantReplyBlocks(
    parts: readonly ZCodeAssistantMessagePart[],
    toolCalls: ReadonlyMap<string, BotReplyToolCallState>,
    mode: BotReplyGranularity | undefined,
    changeSummary: ZCodeTaskMeta["changeSummary"] | null | undefined,
  ): BotAssistantReplyBlock[];
  createBindCode(params: BotCreateBindCodeParams): Promise<BotBindCodeResult>;
  createCompletedElicitationOutbound(
    actor: BotActor,
    pending: BotPendingElicitation,
    locale: Locale | undefined,
    action: "accept" | "decline" | "cancel",
  ): BotOutboundMessage;
  createCurrentWorkspaceRef(context: BotContextState): BotWorkspaceRef;
  createElicitationReply(
    actor: BotActor,
    pending: BotPendingElicitation,
    locale: Locale | undefined,
    status?: NonNullable<BotOutboundMessage["elicitation"]>["status"],
  ): Promise<BotOutboundMessage[]>;
  createSelectionReply(
    actor: BotActor,
    selection: SelectionPrompt,
    locale?: Locale,
    extras?: Pick<BotOutboundMessage, "elicitation" | "locale">,
  ): Promise<BotOutboundMessage[]>;
  createStatusReply(
    actor: BotActor,
    context: BotContextState,
    locale: Locale | undefined,
  ): Promise<BotOutboundMessage[]>;
  deleteBot(botId: string): Promise<void>;
  enqueueInboundProcessing: <T>(
    actor: BotActor,
    task: () => Promise<T>,
    control?: boolean,
  ) => Promise<T>;
  enqueueStreamEvent: (event: ZCodeStreamEvent | TaskStreamMirrorableEvent) => Promise<void>;
  ensureBotStorageMigrated(): Promise<void>;
  ensureDraftOptions(context: BotContextState): Promise<BotDraftOptions>;
  finalizeTransientInteractionCard(actor: BotActor, fallback: BotOutboundMessage): Promise<boolean>;
  findSelectConfigOption(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
  ): (ZCodeConfigOption & { type: "select" }) | undefined;
  formatAttachmentRejectedReason(error: unknown, locale: Locale | undefined): string;
  formatReplyGranularityLabel(
    id: BotReplyGranularity | undefined,
    locale: Locale | undefined,
    provider?: BotProvider,
  ): string;
  formatStatusModelLabel(
    model: string | undefined,
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
  ): Promise<string>;
  formatUserFacingBotError(error: unknown, locale: Locale | undefined): string;
  getActorContextKey(actor: BotActor): string;
  getBotStates(): Promise<BotContextState[]>;
  getConfig: () => Promise<BotsConfigFile>;
  getConfigCommandMissingMessageId(configId: "mode" | "thoughtLevel"): BotMessageId;
  getContextTaskBlockReason(
    context: BotContextState,
  ): Promise<
    "taskRunning" | "groupTaskQueued" | "groupTaskInteraction" | "groupTaskDisconnected" | null
  >;
  getElicitationAnswerKey(questionIndex: number): string;
  getGroupDeliverySender: (
    bot: BotConfig,
    chatId: string,
    threadId?: string,
  ) => ((result: BotGroupDelivery, retry?: boolean) => Promise<void>) & {
    isInFlight: (id: string) => boolean;
    project: (result: BotGroupDelivery) => BotGroupDelivery;
  };
  getGroupMemberNames(params: { botId: string; chatId: string }): Promise<Record<string, string>>;
  getMode: () => BotReplyGranularity;
  getPendingElicitationSelectionToken(pending: BotPendingElicitation): string;
  getPendingElicitationSkipOptionId(pending: BotPendingElicitation): string;
  getStatus(): Promise<BotServiceStatus>;
  getTopicDetails(params: {
    botId: string;
    chatId: string;
    threadId?: string;
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{
    messageCount: number;
    hasGap: boolean;
    historyEnabled: boolean;
    summaries: Array<{ checkpoint: string; text: string }>;
  }>;
  handleBind(message: BotInboundMessage, code: string): Promise<BotOutboundMessage[]>;
  handleElicitationRequest(
    bot: BotConfig,
    user: BotConfig,
    actor: BotActor,
    context: BotContextState,
    event: Extract<ZCodeStreamEvent, { type: "elicitation_request" }>,
    mentionedUserIds?: string[],
  ): Promise<void>;
  handleGroupActivation(
    message: BotInboundMessage,
    enabled: boolean,
  ): Promise<BotOutboundMessage[]>;
  handleGroupHistory(message: BotInboundMessage, enabled?: boolean): Promise<BotOutboundMessage[]>;
  handleHelp(message: BotInboundMessage): Promise<BotOutboundMessage[]>;
  handleInboundMessage(message: BotInboundMessage): Promise<BotOutboundMessage[]>;
  handleMessage: (
    message: BotInboundMessage,
    topicBatch?: PreparedTopicMessage[],
    isCurrent?: () => boolean,
  ) => Promise<BotOutboundMessage[]>;
  handlePendingElicitationText(
    auth: {
      bot: BotConfig;
      context: BotContextState;
      locale: Locale | undefined;
    },
    actor: BotActor,
    text: string,
  ): Promise<BotOutboundMessage[] | null>;
  handlePendingElicitationValue(
    auth: {
      bot: BotConfig;
      context: BotContextState;
      locale: Locale | undefined;
    },
    actor: BotActor,
    value: string,
  ): Promise<BotOutboundMessage[]>;
  handleProviderCallback(provider: BotProvider, payload: unknown): Promise<BotOutboundMessage[]>;
  handleProviderCallbackResponse(
    provider: BotProvider,
    payload: unknown,
  ): Promise<BotProviderCallbackResult>;
  handleReconnect(
    message: BotInboundMessage,
    options?: {
      onReconnectStart?: (auth: BotAuthorizedContext) => Promise<void>;
    },
  ): Promise<BotOutboundMessage[]>;
  handleSelectionCancel(message: BotInboundMessage): Promise<BotOutboundMessage[]>;
  handleStatus(message: BotInboundMessage): Promise<BotOutboundMessage[]>;
  handleStructuredElicitationResponse(
    message: BotInboundMessage,
    response: BotStructuredElicitationResponse,
  ): Promise<BotOutboundMessage[]>;
  handleTaskList(message: BotInboundMessage): Promise<BotOutboundMessage[]>;
  handleWeixinFirstActivation(
    message: BotInboundMessage,
    command: BotCommand,
  ): Promise<BotOutboundMessage[] | null>;
  hasStreamingCardMessageText: () => boolean;
  isPendingElicitationOwnedByActor(pending: BotPendingElicitation, actor: BotActor): boolean;
  isPrivateAuthorized: () => Promise<boolean>;
  isRemoteWorkspaceConnected(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
  ): Promise<boolean>;
  isSessionExpiredError(error: unknown): boolean;
  listActiveTaskConfigOptions(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
    taskId: string,
  ): Promise<ZCodeConfigOption[]>;
  listAllModelOptionsForActiveTask(
    task: Pick<ZCodeTaskMeta, "model" | "workspacePath" | "workspaceIdentity">,
    activeProvider: ZCodeProvider,
  ): Promise<BotModelOption[]>;
  listBots(): Promise<BotConfig[]>;
  listConfigSelectOptions(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
    context?: { locale?: Locale; provider?: ZCodeProvider },
  ): BotModelOption[];
  listContextTaskSelectionEntries(
    context: BotContextState,
    user: BotConfig,
  ): Promise<BotTaskSelectionEntry[]>;
  listDraftConfigOptions(
    context: BotContextState,
    draftOptions: BotDraftOptions,
    resolvedView?: ModelSelectionView | null,
  ): Promise<ZCodeConfigOption[]>;
  listModelOptionsForProviderFromActiveTask(
    task: Pick<ZCodeTaskMeta, "model" | "workspacePath" | "workspaceIdentity">,
    activeProvider: ZCodeProvider,
    providerId: string,
  ): Promise<BotModelOption[]>;
  listModelProviderOptionsForActiveTask(
    task: Pick<ZCodeTaskMeta, "model" | "workspacePath" | "workspaceIdentity">,
    _activeProvider: ZCodeProvider,
  ): Promise<BotModelProviderOption[]>;
  listProviderConfigOptionsForActiveTask(
    task: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity">,
    activeProvider: ZCodeProvider,
  ): Promise<ZCodeConfigOption[]>;
  listUserConfigOptions(_params: BotUserConfigOptionsParams): Promise<ZCodeConfigOption[]>;
  listWorkspaceRefs(_params?: BotListWorkspaceRefsParams): Promise<BotWorkspaceRef[]>;
  markCurrentSelection(selection: SelectionPrompt, locale: Locale | undefined): SelectionPrompt;
  markInboundDelivery(message: BotInboundMessage): boolean;
  mergeElicitationFormValues(
    question: ZCodeElicitationQuestion,
    selectedValues: readonly string[],
    formValues: readonly string[],
  ): string[];
  msg(
    locale: Locale | undefined,
    id: BotMessageId,
    values?: Record<string, string | number | undefined>,
  ): string;
  normalizeBotElicitationQuestions(
    event: Extract<ZCodeStreamEvent, { type: "elicitation_request" }>,
    locale: Locale | undefined,
  ): ZCodeElicitationQuestion[];
  normalizeBotWorkspaceConfig(
    config: BotsConfigFile,
    bot: BotConfig,
    currentWorkspace?: BotWorkspaceRef,
  ): Promise<{
    config: BotsConfigFile;
    bot: BotConfig;
    user: BotConfig;
    workspaces: BotWorkspaceRef[];
  }>;
  normalizeWorkspaceRef(workspace: BotWorkspaceRef): Promise<BotWorkspaceRef>;
  onDeliveryResult(bot: BotConfig, deliveryError: string | undefined): void;
  parseElicitationFormValues(value: string): string[] | null;
  parseElicitationResponseValue(value: string): {
    token?: string;
    value: string;
  };
  pollFeishuRegistration(
    params: BotFeishuRegistrationPollParams,
  ): Promise<BotFeishuRegistrationPollResult>;
  pollWeixinRegistration(
    params: BotWeixinRegistrationPollParams,
  ): Promise<BotWeixinRegistrationPollResult>;
  prepareBotMessageContent(
    bot: BotConfig,
    message: BotInboundMessage,
    locale: Locale | undefined,
  ): Promise<PreparedBotMessageContent>;
  prepareGroupTopicHistory: (
    bot: BotConfig,
    message: BotInboundMessage,
    context: BotContextState,
  ) => Promise<
    | {
        topicContext?: undefined;
        historyError?: undefined;
        historyDisabled?: undefined;
        generation?: undefined;
        backgroundRevision?: undefined;
      }
    | {
        topicContext:
          | {
              messages: {
                id: string;
                chatId: string;
                threadId: string;
                senderId: string;
                senderType: "user" | "app";
                text: string;
                createdAt: number;
                kind: string;
                senderName?: string | undefined;
                parentId?: string | undefined;
                attachments?: { name: string; kind: string }[] | undefined;
                controlCard?: boolean | undefined;
                deleted?: boolean | undefined;
              }[];
              checkpoint: string;
              hasGap: boolean;
            }
          | undefined;
        historyError: unknown;
        historyDisabled: boolean;
        generation: string;
        backgroundRevision: string | undefined;
      }
  >;
  privateSyncSupported(bot: BotConfig): boolean;
  processProviderCallback(
    provider: BotProvider,
    payload: unknown,
  ): Promise<BotProviderCallbackResult>;
  readBotElicitationRenderContext(
    event: Extract<ZCodeStreamEvent, { type: "elicitation_request" }>,
  ): BotPendingElicitation["renderContext"];
  readConfigSelectCurrentLabel(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
    context?: { locale?: Locale; provider?: ZCodeProvider },
  ): string | undefined;
  readConfigSelectCurrentValue(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
  ): string | undefined;
  readConfigSelectLabelForValue(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
    value: string | undefined,
    context?: { locale?: Locale; provider?: ZCodeProvider },
  ): string | undefined;
  readContext(actor: BotActor, bot: BotConfig): Promise<BotContextState | null>;
  readContextActiveTaskMeta(context: BotContextState): Promise<ZCodeTaskMeta | null>;
  readCurrentActiveTaskMode(
    task: Pick<ZCodeTaskMeta, "mode">,
    options: readonly ZCodeConfigOption[],
  ): string | undefined;
  readCurrentActiveTaskModel(
    task: Pick<ZCodeTaskMeta, "model">,
    options: readonly ZCodeConfigOption[],
  ): string | undefined;
  readCurrentModelProviderId(
    task: Pick<ZCodeTaskMeta, "model" | "workspacePath" | "workspaceIdentity">,
    options: readonly ZCodeConfigOption[],
    activeProvider: ZCodeProvider,
  ): Promise<string | undefined>;
  readElicitationAnswerValues(pending: BotPendingElicitation, questionIndex: number): string[];
  readMessageLocale(): Promise<Locale | undefined>;
  readModelProviderSelectionModels(provider: unknown): BotModelOption[];
  readModelSelectionView(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
    selection?: ModelSelection,
  ): Promise<ModelSelectionView | null>;
  readQueueCardScope: (key: string) => Promise<
    | {
        state: BotsStateFile;
        context: BotState;
        bot: BotConfig;
        input: {
          taskId: string;
          source: BotGroupInputSource;
          admission?: "pending" | "accepted" | "rejected";
          progress?: BotGroupInputProgress;
        };
      }
    | undefined
  >;
  readTelegramOffset(botId: string): Promise<number | undefined>;
  readTerminalTaskMeta(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
    taskId: string,
    eventType: "task_complete" | "task_error",
  ): Promise<ZCodeTaskMeta | null>;
  readTopicResource(
    params: import("#src/bots/topicResource.js").TopicResourceRequest,
  ): Promise<import("@zcode/shared").ZCodePromptAttachment>;
  readWeixinGetUpdatesBuf(botId: string): Promise<string | undefined>;
  receiveTopicMessage(message: BotInboundMessage): Promise<BotOutboundMessage[]>;
  reconcileGroupResult(params: {
    botId: string;
    chatId: string;
    deliveryId: string;
    threadId?: string;
    received: boolean;
  }): Promise<import("@zcode/shared").BotGroupDelivery>;
  reconcilePrivateSynchronization(botId: string): Promise<void>;
  reconnectRemoteWorkspaceForBot(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
  ): Promise<BotRemoteWorkspaceReconnectResult>;
  releaseInboundDelivery(message: BotInboundMessage): void;
  removeBotSecret(botId: string): Promise<BotConfig>;
  replyToChannel(
    params: import("@zcode/shared").ChannelReplyHostRequest,
  ): Promise<import("@zcode/shared").ChannelReplyResult>;
  requireActiveTask(
    message: BotInboundMessage,
    auth: {
      context: BotContextState;
      locale: Locale | undefined;
    },
  ): Promise<
    | {
        ok: true;
        taskId: string;
        task: ZCodeTaskMeta;
        configOptions: ZCodeConfigOption[];
      }
    | { ok: false; reply: BotOutboundMessage[] }
  >;
  resendGroupResult(params: {
    botId: string;
    chatId: string;
    deliveryId: string;
    threadId?: string;
  }): Promise<import("@zcode/shared").BotGroupDelivery>;
  resetBotState(contextKey: string): Promise<void>;
  resolveCustomModelRuntimeModelId(
    _activeProvider: ZCodeProvider,
    customModel: { providerId: string; modelName?: string },
  ): string | undefined;
  resolveDraftOptionsForDisplay(context: BotContextState): Promise<BotDraftOptions>;
  resolveElicitationQuestionValue(
    question: ZCodeElicitationQuestion,
    value: string,
    options?: { includeSubmit?: boolean },
  ): string;
  resolvePendingSelectionCommand(actor: BotActor, value: string): BotCommand | null;
  resolvePendingSelectionOption(
    actor: BotActor,
    action: SelectionPrompt["action"],
    value: string,
  ): SelectionPrompt["options"][number] | null;
  resolvePendingTaskSelectionEntry(actor: BotActor, value: string): BotTaskSelectionEntry | null;
  resolvePendingWorkspaceSelectionEntry(
    actor: BotActor,
    value: string,
  ): BotWorkspaceSelectionEntry | null;
  resolveZCodeTaskServiceForContext(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
  ): Promise<IZCodeTaskService>;
  restoreGroupSynchronization(context: BotContextState): Promise<void>;
  retryPrivateDelivery(params: { botId: string; deliveryId: string }): Promise<void>;
  retryTopicPreparation(params: {
    botId: string;
    chatId: string;
    threadId: string;
    messageId: string;
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void>;
  saveBot(params: BotSaveBotParams): Promise<BotConfig>;
  saveConfig(config: BotsConfigFile): Promise<BotsConfigFile>;
  sealStreamingCardReply: () => Promise<void>;
  sendOutbound(
    bot: BotConfig,
    message: BotOutboundMessage,
    authorize?: () => Promise<boolean>,
  ): Promise<void>;
  sendPromptInBackground(
    bot: BotConfig,
    actor: BotActor,
    context: BotContextState,
    taskId: string,
    traceId: string,
    content: string,
    attachments: ZCodePromptAttachment[],
    botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget,
    modelSelection?: ModelSelection,
  ): void;
  sendTyping(bot: BotConfig, actor: BotActor): Promise<void>;
  serializeStateWrite(operation: () => Promise<void>): Promise<void>;
  setGroupEnabled(params: { botId: string; chatId: string; enabled: boolean }): Promise<void>;
  setRuntimeStatus(status: BotRuntimeInfo): void;
  shouldUseTransientInteractionCard(bot: BotConfig, user: BotConfig): boolean;
  startTyping(bot: BotConfig, actor: BotActor, taskId: string): void;
  stopGroupSynchronization(context: BotContextState): void;
  stopInboundTyping(bot: BotConfig, actor: BotActor): Promise<void>;
  stopTopicRun(
    context: BotContextState,
    executionId: string,
    sourceCommandId?: string,
  ): Promise<void>;
  stopTyping(taskId: string): void;
  submitGroupMessage: (
    bot: BotConfig,
    message: BotInboundMessage,
    context: BotContextState,
    prepared: PreparedBotMessageContent,
    locale: Locale | undefined,
    history: Awaited<
      ReturnType<
        (
          bot: BotConfig,
          message: BotInboundMessage,
          context: BotContextState,
        ) => Promise<
          | {
              topicContext?: undefined;
              historyError?: undefined;
              historyDisabled?: undefined;
              generation?: undefined;
              backgroundRevision?: undefined;
            }
          | {
              topicContext:
                | {
                    messages: {
                      id: string;
                      chatId: string;
                      threadId: string;
                      senderId: string;
                      senderType: "user" | "app";
                      text: string;
                      createdAt: number;
                      kind: string;
                      senderName?: string | undefined;
                      parentId?: string | undefined;
                      attachments?: { name: string; kind: string }[] | undefined;
                      controlCard?: boolean | undefined;
                      deleted?: boolean | undefined;
                    }[];
                    checkpoint: string;
                    hasGap: boolean;
                  }
                | undefined;
              historyError: unknown;
              historyDisabled: boolean;
              generation: string;
              backgroundRevision: string | undefined;
            }
        >
      >
    >,
    topicBatch?: PreparedTopicMessage[],
    isCurrent?: () => boolean,
  ) => Promise<BotOutboundMessage[]>;
  submitPendingElicitation(
    auth: {
      bot: BotConfig;
      context: BotContextState;
      locale: Locale | undefined;
    },
    actor: BotActor,
    pending: BotPendingElicitation,
    action: "accept" | "decline" | "cancel",
    content?: Record<string, unknown>,
  ): Promise<BotOutboundMessage[]>;
  supportsStreamingCardReply: () => boolean;
  syncAppRuntimePreferences(preferences: ZCodeAgentAppRuntimePreferences): Promise<void>;
  syncStreamingCardReply: (trigger: string, force?: boolean) => Promise<void>;
  taskStreamKey(context: BotContextState, actor: BotActor): string;
  testBot(botId: string): Promise<BotTestResult>;
  toggleElicitationCustomAnswerExpanded(pending: BotPendingElicitation): BotPendingElicitation;
  updateGroupInputReaction(
    bot: BotConfig,
    context: BotContextState,
    messageId: string | undefined,
    state: BotGroupInputStatus,
  ): Promise<void>;
  updateLiveStatusProgress(event: ZCodeStreamEvent): void;
  upgradeLegacyContext(context: BotContextState, catalog: ProjectCatalogSnapshot): BotContextState;
  upsertTransientInteractionCard(
    bot: BotConfig,
    actor: BotActor,
    taskId: string,
    message: BotOutboundMessage,
  ): Promise<void>;
  validateTopicResource(
    params: import("#src/bots/topicResource.js").TopicResourceRequest,
  ): Promise<void>;
  watchAutomationRun(params: BotAutomationRunWatchParams): Promise<void>;
  watchTaskStream(
    bot: BotConfig,
    actor: BotActor,
    context: BotContextState,
    user: BotConfig,
    automation?: boolean | string,
  ): Promise<void>;
  weixinContextKey(bot: BotConfig, userId: string): string;
  withAuthorizedContext(
    message: BotInboundMessage,
    requestedCommand: BotAuthorizedCommand,
  ): Promise<
    | {
        ok: true;
        config: BotsConfigFile;
        bot: BotConfig;
        user: BotConfig;
        context: BotContextState;
        locale: Locale | undefined;
      }
    | { ok: false; reply: BotOutboundMessage[] }
  >;
  writeBotConfig(next: BotsConfigFile): Promise<BotsConfigFile>;
  writeContext: (
    context: BotContextState,
    updateAuthorization?: boolean,
    expectedTaskId?: string | null,
  ) => Promise<void>;
  writeDraftContext(
    context: BotContextState,
    draftOptions?: BotDraftOptions,
  ): Promise<BotContextState>;
  writeDraftOptions(
    context: BotContextState,
    draftOptions: BotDraftOptions,
  ): Promise<BotContextState>;
  writeTelegramOffset(botId: string, offset: number): Promise<void>;
  writeWeixinGetUpdatesBuf(botId: string, buf: string): Promise<void>;
}

export type BotsServiceContext = BotsServiceState & BotsServicePorts & BotsServiceCommandPorts;
