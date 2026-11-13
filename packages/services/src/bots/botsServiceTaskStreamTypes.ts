import type { StreamingCardTimelineBlock } from "./botsServiceTypes.js";
import type { IZCodeTaskService } from "../session/zcodeTaskService.js";
import type { BotStreamingReplyCardBlock, BotStreamingReplyCardHandle } from "./providers/types.js";
import type { BotReplyToolCallState } from "./replyFormatter.js";
import type {
  BotActor,
  BotConfig,
  BotContextState,
  BotOutboundMessage,
  BotReplyGranularity,
  Locale,
  TaskStreamMirrorableEvent,
  ZCodeAssistantMessagePart,
  ZCodeStreamEvent,
} from "@zcode/shared";

export interface BotTaskStreamRun {
  bot: BotConfig;
  actor: BotActor;
  context: BotContextState;
  user: BotConfig;
  automation: boolean | string;
  streamSubscriptionKey: string;
  persistentPrivate: boolean;
  bindingId: string | undefined;
  automationPending: boolean;
  automationRun: boolean;
  automationRuns: Set<string>;
  imInteractionRun: boolean;
  privateDeliveryFailed: boolean;
  privateCardDeliveryUnknown: boolean;
  zcodeTaskService: IZCodeTaskService;
  automationGroupKey: string | null;
  automationAuthorizationId: string | undefined;
  disposed: boolean;
  resultRunId: string;
  resultSourceCommandId: string | undefined;
  resultInputOrigin: "desktop" | "mobile";
  resultPart: number;
  resultMentionedUserIds: string[] | undefined;
  terminalRuns: Set<string>;
  assistantParts: ZCodeAssistantMessagePart[];
  assistantReplyBuffer: string;
  sentAnyAssistantReply: boolean;
  assistantPartToolIds: Set<string>;
  toolCalls: Map<string, BotReplyToolCallState>;
  sentToolCallReplyIds: Set<string>;
  streamingCardHandle: BotStreamingReplyCardHandle | null;
  streamingCardSegmentIndex: number;
  streamingCardBlocks: StreamingCardTimelineBlock[];
  streamingCardStatus: "running" | "sealed" | "completed" | "error";
  streamingCardLastUpdateAt: number;
  streamingCardConsecutiveFailures: number;
  streamingCardNextAttemptAt: number;
  streamingCardCircuitOpen: boolean;
  streamingCardQueue: Promise<void>;
  streamEventQueue: Promise<void>;
  isPrivateAuthorized: () => Promise<boolean>;
  sendTaskOutbound: (targetBot: BotConfig, message: BotOutboundMessage) => Promise<void>;
  getMode: () => BotReplyGranularity;
  supportsStreamingCardReply: () => boolean;
  buildStreamingToolSummaryTitle: (locale: Locale | undefined) => string;
  appendStreamingCardMessageChunk: (content: string) => void;
  appendStreamingCardMessages: (messages: readonly string[]) => void;
  hasStreamingCardMessageText: () => boolean;
  appendStreamingCardTool: (toolId: string) => void;
  buildStreamingCardBlocks: (locale: Locale | undefined) => BotStreamingReplyCardBlock[];
  syncStreamingCardReply: (trigger: string, force?: boolean) => Promise<void>;
  sealStreamingCardReply: () => Promise<void>;
  flushAssistantReplyBuffer: (force?: boolean) => Promise<void>;
  handleStreamEventImpl: (
    event: ZCodeStreamEvent | TaskStreamMirrorableEvent,
    shouldBroadcast?: boolean,
  ) => Promise<void>;
  handleStreamEvent: (
    event: ZCodeStreamEvent | TaskStreamMirrorableEvent,
    shouldBroadcast?: boolean,
  ) => Promise<void>;
  enqueueStreamEvent: (event: ZCodeStreamEvent | TaskStreamMirrorableEvent) => Promise<void>;
}
