import type {
  BindCodeRecord,
  BotTaskSelectionEntry,
  BotWorkspaceSelectionEntry,
  BotsServiceDeps,
  BotsServiceInstance,
  PreparedTopicMessage,
} from "./botsServiceTypes.js";
import type { IBotsService } from "./bots.js";
import type {
  BotProviderAdapter,
  BotTransientInteractionCardHandle,
  BotTypingTarget,
} from "./providers/types.js";
import { BotsRepo } from "./repo.js";
import type { IDisposable } from "@zcode/rpc";
import type {
  BotActor,
  BotConfig,
  BotGroupDelivery,
  BotGroupInputStatus,
  BotInboundMessage,
  BotOutboundMessage,
  BotRuntimeInfo,
  BotsConfigFile,
  Locale,
  SelectionPrompt,
  TaskStreamMirrorableEvent,
  ZCodeStreamEvent,
} from "@zcode/shared";
import { createGroupAdminAttention } from "#src/bots/groupAdminAttention.js";
import { createGroupDeliveryThrottle } from "#src/bots/groupDeliveryThrottle.js";
import { createGroupResultDelivery } from "#src/bots/groupResultDelivery.js";
import { createBotTaskStreamHub } from "#src/bots/taskStreamHub.js";
import { createTopicContinuation } from "#src/bots/topicContinuation.js";
import { createTopicPreparationState } from "#src/bots/topicPreparationState.js";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

export interface BotsServiceContextState {
  deps: BotsServiceDeps;
  runStartupBackgroundTasks: boolean;
  repo: BotsRepo;
  bindCodes: Map<string, BindCodeRecord>;
  automationDeliveryWarningAtByKey: Map<string, number>;
  streamSubscriptions: Map<
    string,
    IDisposable & { automation(runId?: string): void; imInput(): void }
  >;
  taskStreamHub: ReturnType<
    typeof createBotTaskStreamHub<ZCodeStreamEvent | TaskStreamMirrorableEvent>
  >;
  failedPrivateDeliveries: Map<
    string,
    {
      id: string;
      message: BotOutboundMessage;
      bindingId: string | undefined;
      taskId: string;
      sending: boolean;
    }
  >;
  privateReconciliations: Map<string, Promise<void>>;
  privateImTraces: Set<string>;
  watchStarts: Map<string, Promise<void>>;
  privateWatches: Map<string, { signature: string; key: string }>;
  forwardedTaskEvents: WeakSet<object>;
  privateRecoveryTimer: ReturnType<typeof setInterval> | undefined;
  privateRecoveryPending: boolean;
  streamingCardRequestControllers: Set<AbortController>;
  transientInteractionCards: Map<
    string,
    { bot: BotConfig; taskId: string; handle: BotTransientInteractionCardHandle }
  >;
  typingIntervals: Map<string, NodeJS.Timeout>;
  typingTargets: Map<string, { bot: BotConfig; target: BotTypingTarget }>;
  runningTasks: Set<string>;
  topicContinuations: Map<
    string,
    {
      receive(id: string, prepare: () => Promise<PreparedTopicMessage>): boolean;
      cancel(): void;
      settled(): Promise<void>;
    }
  >;
  topicHistoryReady: Map<string, string>;
  botHistoryEpoch: Map<string, number>;
  groupHistoryEpoch: Map<string, number>;
  topicStops: Map<string, Promise<void>>;
  topicPreparation: {
    add(key: string, message: BotInboundMessage): void;
    setWaitingStop(key: string, waiting: boolean): void;
    update(
      key: string,
      ids: string[],
      status: "preparing" | "waitingStop" | "failed",
      error?: string,
    ): void;
    snapshot(key: string): {
      error?: string | undefined;
      messageId: string;
      senderName: string;
      text: string;
      contentParts:
        | (
            | { type: "text"; text: string }
            | {
                type: "channelMention";
                refId: string;
                name: string;
                channel: "feishu" | "lark";
                targetId: string;
                idType: "open_id";
                entityType: "user" | "bot" | "unknown";
              }
          )[]
        | undefined;
      status: "preparing" | "waitingStop" | "failed";
    }[];
    retry(key: string, id: string): BotInboundMessage | undefined;
    remove(key: string, ids: string[]): void;
    clear(key?: string): void;
  };
  publishTopicPreparation: () => Promise<void> | undefined;
  topicGenerations: Map<string, number>;
  topicReplies: Map<string, Map<string, (replies: BotOutboundMessage[]) => void>>;
  liveStatusProgressByTaskId: Map<string, { kind: "message" | "thought" | "tool"; text: string }>;
  runtimeByBotId: Map<string, BotRuntimeInfo>;
  pendingSelectionsByContext: Map<string, SelectionPrompt>;
  memoryDiagnostics: IDisposable;
  pendingTaskSelectionsByContext: Map<string, Map<string, BotTaskSelectionEntry>>;
  pendingWorkspaceSelectionsByContext: Map<string, Map<string, BotWorkspaceSelectionEntry>>;
  pendingRemoteReconnectsByKey: Map<string, Promise<BotOutboundMessage[]>>;
  recentRemoteReconnectAtByKey: Map<string, number>;
  recentRemoteReconnectDeliveryAtByKey: Map<string, number>;
  recentInboundDeliveryAtByKey: Map<string, number>;
  inboundProcessingQueuesByContext: Map<string, Promise<void>>;
  botStorageMigrationPromise: Promise<void> | null;
  cachedLocale: Locale | undefined;
  service: IBotsService & {
    disposeAll(): void;
    disposeAllAndWait(): Promise<void>;
  };
  shutdownPromise: Promise<void> | null;
  stateWriteTail: Promise<void>;
  adminAttention: {
    mention(actor: BotActor, owner: string | undefined, reason: string): string[] | undefined;
    clear(actor?: BotActor, owner?: string, reason?: string): void;
  };
  waitForGroupDeliverySlot: (chatKey: string) => Promise<void>;
  groupDeliverySenders: Map<
    string,
    ((result: BotGroupDelivery, retry?: boolean) => Promise<void>) & {
      isInFlight: (id: string) => boolean;
      project: (result: BotGroupDelivery) => BotGroupDelivery;
    }
  >;
}

export interface BotsServiceRuntimeState {
  providers: Record<
    "feishu" | "lark" | "telegram" | "webhook" | "weixin" | "discord" | "wecom",
    BotProviderAdapter | null
  >;
  statusSink: {
    getRuntimeStatus(botId: string): BotRuntimeInfo | undefined;
    setRuntimeStatus: (status: BotRuntimeInfo) => void;
  };
  telegramRuntime: {
    dispose: () => Promise<void>;
    refresh: (config?: BotsConfigFile) => Promise<void>;
    scheduleRefresh: (config?: BotsConfigFile) => void;
    stopPolling: (botId: string) => Promise<void>;
    syncCommands: (bot: BotConfig) => Promise<void>;
  };
  weixinRuntime: {
    dispose: () => Promise<void>;
    refresh: (config?: BotsConfigFile) => Promise<void>;
    scheduleRefresh: (config?: BotsConfigFile) => void;
    stopPolling: (botId: string) => Promise<void>;
  };
  feishuRuntime: {
    dispose: () => Promise<void>;
    refresh: (config?: BotsConfigFile) => Promise<void>;
    scheduleRefresh: (config?: BotsConfigFile) => void;
    stopWebSocket: (botId: string) => Promise<void>;
  };
  queueCards: {
    update: (key: string, status: BotGroupInputStatus) => Promise<void>;
    attach: (key: string, cardMessageId: string) => Promise<void>;
  };
}

export type BotsServiceState = BotsServiceContextState & BotsServiceRuntimeState;

export function createBotsServiceContext(deps: BotsServiceDeps): BotsServiceContextState {
  const runStartupBackgroundTasks = deps.runStartupBackgroundTasks !== false;

  const repo = deps.repo ?? new BotsRepo();

  const bindCodes = new Map<string, BindCodeRecord>();

  const automationDeliveryWarningAtByKey = new Map<string, number>();

  const streamSubscriptions = new Map<
    string,
    IDisposable & { automation(runId?: string): void; imInput(): void }
  >();

  const taskStreamHub = createBotTaskStreamHub<ZCodeStreamEvent | TaskStreamMirrorableEvent>();

  const failedPrivateDeliveries = new Map<
    string,
    {
      id: string;
      message: BotOutboundMessage;
      bindingId: string | undefined;
      taskId: string;
      sending: boolean;
    }
  >();

  const privateReconciliations = new Map<string, Promise<void>>();

  const privateImTraces = new Set<string>();

  const watchStarts = new Map<string, Promise<void>>();

  const privateWatches = new Map<string, { signature: string; key: string }>();

  const forwardedTaskEvents = new WeakSet<object>();

  let privateRecoveryTimer: ReturnType<typeof setInterval> | undefined = undefined;

  let privateRecoveryPending = false;

  const streamingCardRequestControllers = new Set<AbortController>();

  const transientInteractionCards = new Map<
    string,
    {
      bot: BotConfig;
      taskId: string;
      handle: BotTransientInteractionCardHandle;
    }
  >();

  const typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  const typingTargets = new Map<string, { bot: BotConfig; target: BotTypingTarget }>();

  const runningTasks = new Set<string>();

  const topicContinuations = new Map<
    string,
    ReturnType<typeof createTopicContinuation<PreparedTopicMessage>>
  >();

  const topicHistoryReady = new Map<string, string>();

  const botHistoryEpoch = new Map<string, number>();

  const groupHistoryEpoch = new Map<string, number>();

  const topicStops = new Map<string, Promise<void>>();

  const topicPreparation = createTopicPreparationState();

  const publishTopicPreparation = () =>
    deps.broadcastService?.send({ channel: "bots:group-state", payload: {} });

  const topicGenerations = new Map<string, number>();

  const topicReplies = new Map<string, Map<string, (replies: BotOutboundMessage[]) => void>>();

  const liveStatusProgressByTaskId = new Map<
    string,
    { kind: "message" | "thought" | "tool"; text: string }
  >();

  const runtimeByBotId = new Map<string, BotRuntimeInfo>();

  const pendingSelectionsByContext = new Map<string, SelectionPrompt>();

  // 只读取任务订阅和运行状态的数量，不暴露消息内容。
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("bots", () => ({
    streamSubs: streamSubscriptions.size,
    runningTasks: runningTasks.size,
    typingIntervals: typingIntervals.size,
    liveStatusProgress: liveStatusProgressByTaskId.size,
  }));

  const pendingTaskSelectionsByContext = new Map<string, Map<string, BotTaskSelectionEntry>>();

  const pendingWorkspaceSelectionsByContext = new Map<
    string,
    Map<string, BotWorkspaceSelectionEntry>
  >();

  const pendingRemoteReconnectsByKey = new Map<string, Promise<BotOutboundMessage[]>>();

  const recentRemoteReconnectAtByKey = new Map<string, number>();

  const recentRemoteReconnectDeliveryAtByKey = new Map<string, number>();

  const recentInboundDeliveryAtByKey = new Map<string, number>();

  const inboundProcessingQueuesByContext = new Map<string, Promise<void>>();

  let botStorageMigrationPromise: Promise<void> | null = null;

  let cachedLocale: Locale | undefined = undefined;

  let service: BotsServiceInstance = undefined as unknown as BotsServiceInstance;

  let shutdownPromise: Promise<void> | null = null;

  let stateWriteTail: Promise<void> = Promise.resolve();

  const adminAttention = createGroupAdminAttention();

  const waitForGroupDeliverySlot = createGroupDeliveryThrottle();

  const groupDeliverySenders = new Map<string, ReturnType<typeof createGroupResultDelivery>>();

  return {
    deps,
    runStartupBackgroundTasks,
    repo,
    bindCodes,
    automationDeliveryWarningAtByKey,
    streamSubscriptions,
    taskStreamHub,
    failedPrivateDeliveries,
    privateReconciliations,
    privateImTraces,
    watchStarts,
    privateWatches,
    forwardedTaskEvents,
    privateRecoveryTimer: privateRecoveryTimer as ReturnType<typeof setInterval> | undefined,
    privateRecoveryPending,
    streamingCardRequestControllers,
    transientInteractionCards,
    typingIntervals,
    typingTargets,
    runningTasks,
    topicContinuations,
    topicHistoryReady,
    botHistoryEpoch,
    groupHistoryEpoch,
    topicStops,
    topicPreparation,
    publishTopicPreparation,
    topicGenerations,
    topicReplies,
    liveStatusProgressByTaskId,
    runtimeByBotId,
    pendingSelectionsByContext,
    memoryDiagnostics,
    pendingTaskSelectionsByContext,
    pendingWorkspaceSelectionsByContext,
    pendingRemoteReconnectsByKey,
    recentRemoteReconnectAtByKey,
    recentRemoteReconnectDeliveryAtByKey,
    recentInboundDeliveryAtByKey,
    inboundProcessingQueuesByContext,
    botStorageMigrationPromise: botStorageMigrationPromise as Promise<void> | null,
    cachedLocale: cachedLocale as Locale | undefined,
    service: service as IBotsService & {
      disposeAll(): void;
      disposeAllAndWait(): Promise<void>;
    },
    shutdownPromise: shutdownPromise as Promise<void> | null,
    stateWriteTail: stateWriteTail as Promise<void>,
    adminAttention,
    waitForGroupDeliverySlot,
    groupDeliverySenders,
  };
}
