import { join } from "node:path";

import type { ConversationShareRecord, Locale } from "@zcode/shared";
import {
  localizeConversationShareUrl,
  resolveRuntimeZCodeEndpointOrigin,
} from "@zcode/shared";

import type { IZCodeAgentService } from "../../zcode-agent/zcodeAgent.js";
import type { IZCodeSessionService } from "#src/zcode-session/zcodeSession.js";
import { getConversationWorkspaceDir } from "#src/paths.js";
import {
  createServiceLogger,
  type ServiceLogger,
} from "#src/logger/serviceLogger.js";
import { ConversationShareServiceError } from "../conversationShare.js";
import type { ConversationShareHttpClient } from "../conversationShareHttpClient.js";
import type { ConversationShareArtifactSource } from "../conversationShareArtifactSource.js";
import type { ShareWorkflowReader } from "../conversationShareWorkflowSnapshot.js";

import { ConversationShareImportIndex } from "./importIndex.js";
import { ConversationSharePreviewSnapshots } from "./preflightSnapshots.js";
import { ConversationShareProgressHub } from "./progress.js";

export const DEFAULT_CONFIRM_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_CONFIRM_POLL_TIMEOUT_MS = 120_000;
// download 兜底不能是裸 fetch（无 AbortSignal/超时）：对象存储连接挂住时导入会停在
// downloading 阶段直到 undici 默认 ~300s 兜底，体验上等于卡死。120s 覆盖慢速下行的大 artifact。
export const DOWNLOAD_TIMEOUT_MS = 120_000;
// 预检 stat 的并发上限：本地几乎无差别，SSH/远程 workspace 下每次 stat 都是一次
// 网络往返，串行会让「下一步」长时间停在 checking。上限保证不把远端 host 打爆。
export const SHARE_PREFLIGHT_STAT_CONCURRENCY = 6;

const CONNECTION_UNAVAILABLE_ERRORS = new Set([
  "fault.conversation.rowsRangeConnectionUntrusted",
  "fault.connection.handshakeRequired",
  "fault.connection.closed",
]);

export function normalizeConversationShareConnectionError(
  error: unknown,
): unknown {
  if (
    error instanceof Error &&
    CONNECTION_UNAVAILABLE_ERRORS.has(error.message)
  ) {
    return new ConversationShareServiceError(
      "connection_unavailable",
      "Conversation share connection is not ready",
    );
  }
  return error;
}

export function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * 有界并发 map，保持输出与输入同序。
 *
 * 预检的每次 stat 在 SSH/远程 workspace 下都是一次网络往返，串行会让「下一步」
 * 长时间停在 checking。并发上限存在的意义是不把远端 host 打爆；结果按下标回填，
 * 因此 issue 的产生顺序仍然是确定的（与串行实现完全一致）。
 */
export async function mapWithConcurrency<Input, Output>(
  items: readonly Input[],
  limit: number,
  run: (item: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  if (items.length === 0) return [];
  const results = Array.from<Output>({ length: items.length });
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = nextIndex++;
        if (index >= items.length) return;
        results[index] = await run(items[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** stat 的结果或失败原因；并发阶段只收集，分类仍在同序的第二轮里做。 */
export type SettledResult<Value> =
  | { ok: true; value: Value }
  | { ok: false; error: unknown };

export async function settle<Value>(
  run: () => Promise<Value>,
): Promise<SettledResult<Value>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

export function throwServiceError(
  kind: ConstructorParameters<typeof ConversationShareServiceError>[0],
  message: string,
): never {
  throw new ConversationShareServiceError(kind, message);
}

/**
 * 导入会话的标题前缀。services 层没有 intl，这里只维护一份最小映射；
 * 前缀在导入时定型并持久化为 session.title（titleSource: "custom"），之后切界面语言不再改写。
 */
const IMPORTED_SHARE_TITLE_PREFIX: Readonly<Record<Locale, string>> = {
  "zh-CN": "来自分享：",
  "en-US": "From Share: ",
  "ru-RU": "Из общего доступа: ",
};

export function formatImportedShareSessionTitle(
  shareTitle: string,
  locale: Locale | undefined,
): string {
  return `${IMPORTED_SHARE_TITLE_PREFIX[locale ?? "zh-CN"]}${shareTitle.trim()}`;
}

export function localizePublishedShare(
  share: ConversationShareRecord,
  locale: Locale | undefined,
): ConversationShareRecord {
  if (!locale) return share;
  const shareUrl = localizeConversationShareUrl(share.share_url, locale);
  return shareUrl === share.share_url
    ? share
    : { ...share, share_url: shareUrl };
}

export interface ConversationShareServiceOptions {
  zcodeAgentService: ConversationShareAgentService;
  client: ConversationShareHttpClient;
  artifactSource: ConversationShareArtifactSource;
  confirmPollIntervalMs?: number;
  confirmPollTimeoutMs?: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  zcodeSessionService?: ConversationShareSessionService;
  download?: (
    url: string,
    init?: { signal?: AbortSignal },
  ) => Promise<Response>;
  /** 单个 artifact 下载的超时（含读 body）；缺省 120s。 */
  downloadTimeoutMs?: number;
  conversationWorkspaceRoot?: string;
  /** 只由 Desktop Host 注入的 canonical share 页面根地址。 */
  shareWebUrl?: string;
  logger?: ServiceLogger;
}

export type ConversationShareAgentService = ShareWorkflowReader &
  Pick<
    IZCodeAgentService,
    | "conversationRowsRangeV4"
    | "conversationFileChangesV4"
    | "conversationAttachmentReadV4"
    | "conversationAttachmentStatV4"
  >;

export type ConversationShareSessionService = Pick<
  IZCodeSessionService,
  "createSession" | "listSessions"
>;

/** Symbol method 不可由 string-command ProxyChannel 调用，仅供 Desktop Host attachment 装配。 */
export const conversationShareConnectionScopeFactory = Symbol(
  "conversationShareConnectionScopeFactory",
);

/**
 * 领域模块共享的运行时依赖。
 *
 * 唯一 owner 仍是 `ConversationShareService` 实例；这里只把不可变配置与三个有状态
 * 组件（预检快照、进度、导入索引）显式传给领域函数，避免各模块自建平行状态。
 */
export interface ConversationShareServiceRuntime {
  readonly zcodeAgentService: ConversationShareAgentService;
  readonly client: ConversationShareHttpClient;
  readonly artifactSource: ConversationShareArtifactSource;
  readonly zcodeSessionService: ConversationShareSessionService | undefined;
  readonly confirmPollIntervalMs: number;
  readonly confirmPollTimeoutMs: number;
  readonly now: () => number;
  readonly sleep: (delayMs: number) => Promise<void>;
  readonly download: (
    url: string,
    init?: { signal?: AbortSignal },
  ) => Promise<Response>;
  readonly downloadTimeoutMs: number;
  readonly conversationWorkspaceRoot: string;
  readonly shareWebUrl: string;
  readonly logger: ServiceLogger;
  readonly previewSnapshots: ConversationSharePreviewSnapshots;
  readonly progress: ConversationShareProgressHub;
  readonly imports: ConversationShareImportIndex;
}

export function createConversationShareRuntime(
  options: ConversationShareServiceOptions,
): ConversationShareServiceRuntime {
  const conversationWorkspaceRoot =
    options.conversationWorkspaceRoot ?? getConversationWorkspaceDir();
  // 兜底写死生产站 https://zcode.z.ai/cn/share，于是测试环境（API base 走
  // 配置的 ZCode origin）导入后回链仍指向生产站，点分割线打开的是另一个环境的分享。
  // 改用与 API base 同一个环境解析器（buildRuntimeZCodeApiUrl 也走它），保证同环境。
  // 优先级不变：显式 option > ZCODE_CONVERSATION_SHARE_WEB_URL > 按环境推导。
  const shareWebUrl = (
    options.shareWebUrl ??
    process.env.ZCODE_CONVERSATION_SHARE_WEB_URL ??
    `${resolveRuntimeZCodeEndpointOrigin(process.env)}/cn/share`
  ).replace(/\/+$/u, "");
  return {
    zcodeAgentService: options.zcodeAgentService,
    client: options.client,
    artifactSource: options.artifactSource,
    zcodeSessionService: options.zcodeSessionService,
    confirmPollIntervalMs:
      options.confirmPollIntervalMs ?? DEFAULT_CONFIRM_POLL_INTERVAL_MS,
    confirmPollTimeoutMs:
      options.confirmPollTimeoutMs ?? DEFAULT_CONFIRM_POLL_TIMEOUT_MS,
    now: options.now ?? Date.now,
    sleep: options.sleep ?? wait,
    download:
      options.download ?? ((url, init) => fetch(url, { signal: init?.signal })),
    downloadTimeoutMs: options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS,
    conversationWorkspaceRoot,
    shareWebUrl,
    logger: options.logger ?? createServiceLogger("conversation-share"),
    previewSnapshots: new ConversationSharePreviewSnapshots(),
    progress: new ConversationShareProgressHub(),
    imports: new ConversationShareImportIndex(
      join(conversationWorkspaceRoot, ".zcode-share-imports.json"),
    ),
  };
}
