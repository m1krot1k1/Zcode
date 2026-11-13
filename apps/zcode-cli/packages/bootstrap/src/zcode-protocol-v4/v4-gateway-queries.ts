// V4 conversation gateway 的领域模块（从 v4-gateway 拆出）：rowsRange / plans / workflowRunEvents 等。
// 状态与宿主出口一律经 GatewayContext 显式传入，模块自身不持有状态。

import type { TurnId } from "@zcode/contracts";
import {
  WORKFLOW_ARTIFACT_LIMITS,
  WORKFLOW_RUN_EVENTS_PAGE_LIMITS,
  WORKFLOW_WORKSPACE_LIMITS,
  backgroundBashOutputResultSchema,
  v4BackgroundBashOutputParamsSchema,
  v4ConversationFileChangesParamsSchema,
  v4ConversationFileRewindPreviewParamsSchema,
  v4ConversationPlansParamsSchema,
  v4ConversationRowsRangeParamsSchema,
  v4ConversationWorkflowRunArtifactDataParamsSchema,
  v4ConversationWorkflowRunArtifactDataResultSchema,
  v4ConversationWorkflowRunArtifactReadParamsSchema,
  v4ConversationWorkflowRunArtifactReadResultSchema,
  v4ConversationWorkflowRunArtifactsParamsSchema,
  v4ConversationWorkflowRunArtifactsResultSchema,
  v4ConversationWorkflowRunEventsParamsSchema,
  v4ConversationWorkflowRunEventsResultSchema,
  v4ConversationWorkflowRunNodeResultParamsSchema,
  v4ConversationWorkflowRunNodeResultResultSchema,
  v4ConversationWorkflowRunWorkspaceParamsSchema,
  v4ConversationWorkflowRunWorkspaceResultSchema,
  v4ConversationWorkflowRunsParamsSchema,
  v4ConversationWorkflowRunsResultSchema,
  type BackgroundBashOutputResult,
  type ConversationRowTarget,
  type V4ConversationFileChangesResult,
  type V4ConversationFileRewindPreviewResult,
  type V4ConversationPlansResult,
  type V4ConversationRowsRangeResult,
  type V4ConversationWorkflowRunArtifactDataResult,
  type V4ConversationWorkflowRunArtifactReadResult,
  type V4ConversationWorkflowRunArtifactsResult,
  type V4ConversationWorkflowRunEventsResult,
  type V4ConversationWorkflowRunNodeResultResult,
  type V4ConversationWorkflowRunWorkspaceResult,
  type V4ConversationWorkflowRunsResult,
} from "@zcode/shared/zcode-protocol-v4";
import { V4CapabilityUnsupportedError } from "./commands/handlers/interaction-background.js";
import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";
import type { GatewayContext } from "./v4-gateway-context.js";

/**
 * v4/conversation/rowsRange：按 beforeRowId 游标向上取一窗
 * 历史行。只读 query，不建订阅；数据源 = 该会话投影全量行——冷会话（重启后直开
 * 历史）复用与 subscribe 相同的冷恢复 + hydration 管线先把投影建起来。
 */
export async function rowsRange(
  ctx: GatewayContext,
  rawParams: unknown,
): Promise<V4ConversationRowsRangeResult> {
  const params = v4ConversationRowsRangeParamsSchema.parse(rawParams);
  const existingReady = ctx.readyFlights.get(params.sessionId);
  const publisher = ctx.historyOpenings.has(params.sessionId)
    ? await ctx.historyOpenings.get(params.sessionId)!.history
    : ctx.publishers.get(params.sessionId)?.getSnapshot().runtimeInitialization?.status === "failed"
      ? ctx.publishers.get(params.sessionId)!
      : existingReady
        ? await existingReady
        : !ctx.hasLiveConversation(params.sessionId)
          ? await ctx.ensureColdReadyPublisher(params.sessionId)
          : await ctx.hydratePublisher(params.sessionId);
  return publisher.getRowsRange(
    {
      ...(params.beforeRowId !== undefined ? { beforeRowId: params.beforeRowId } : {}),
      limit: params.limit,
    },
    // clientMode 决定行可见性过滤档位：桌面 continuous（默认）/ 断线恢复 replayable。
    params.clientMode === "desktop-continuous" ? "continuous" : "replayable",
  );
}

/** 完整有效 projection 的终态计划目录；冷会话复用订阅 hydration。 */
export async function plans(
  ctx: GatewayContext,
  rawParams: unknown,
): Promise<V4ConversationPlansResult> {
  const params = v4ConversationPlansParamsSchema.parse(rawParams);
  const existingReady = ctx.readyFlights.get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !ctx.hasLiveConversation(params.sessionId)
      ? await ctx.ensureColdReadyPublisher(params.sessionId)
      : await ctx.hydratePublisher(params.sessionId);
  return publisher.getPlans();
}

/**
 * workflow run 事件日志的分页读取（cursor = journal sequence）。
 *
 * 与 rows/range、plans 同族：只读、无状态、超时重发安全。刻意**不是** v4 command——
 * command 的 ACK 结果是那个封闭的「变更结果」判别联合，一页只读事件不属于那个词汇表。
 *
 * 一页的条数与字节两道界在这里定（docs/execution-engine.md「Reading the journal」）：条数取
 * 调用方的 limit，缺省为协议上限；字节恒为协议上限，renderer 不能放宽。`hasMore` 由存储层
 * 判定——页可能因字节提前收尾，「取满 limit」已经不是判据。
 */
export async function workflowRunEvents(
  ctx: GatewayContext,
  rawParams: unknown,
): Promise<V4ConversationWorkflowRunEventsResult> {
  const params = v4ConversationWorkflowRunEventsParamsSchema.parse(rawParams);
  if (!ctx.host.listDynamicWorkflowRunEvents) {
    throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunEvents", params.sessionId);
  }
  await ctx.ensureHostRecordForJournalRead(params.sessionId);
  const page = await ctx.host.listDynamicWorkflowRunEvents(params.sessionId, {
    runId: params.runId,
    ...(params.afterSequence === undefined ? {} : { afterSequence: params.afterSequence }),
    limit: params.limit ?? WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxEvents,
    maxBytes: WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxBytes,
  });
  return v4ConversationWorkflowRunEventsResultSchema.parse(page);
}

/**
 * dwf run 的枚举 query。与
 * workflowRunEvents 同族：只读、无状态、超时重发安全。limit 的缺省与钳制在 CLI 侧
 * （run service），这里只透传；`resumable` 由 CLI 按 resume 门的同一个谓词算好。
 */
export async function workflowRuns(
  ctx: GatewayContext,
  rawParams: unknown,
): Promise<V4ConversationWorkflowRunsResult> {
  const params = v4ConversationWorkflowRunsParamsSchema.parse(rawParams);
  if (!ctx.host.listDynamicWorkflowRuns) {
    throw new V4CapabilityUnsupportedError("listDynamicWorkflowRuns", params.sessionId);
  }
  await ctx.ensureHostRecordForJournalRead(params.sessionId);
  const runs = await ctx.host.listDynamicWorkflowRuns(params.sessionId, {
    ...(params.limit === undefined ? {} : { limit: params.limit }),
  });
  return v4ConversationWorkflowRunsResultSchema.parse({ runs });
}

/**
 * workflow run 的**用户面产物**清单。
 * 与 workflowRunEvents 同族：只读、无状态、超时重发安全。
 *
 * ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出，不是 run 的顶层
 * 返回值（引擎内部对后者的同名叫法）。
 *
 * 未知 runId 回空清单而不是错误：一个已被淘汰 / 从未存在的 run 没有产物，这是一个
 * 事实而不是故障——同一姿态见事件日志对越界 cursor 的处理。
 */
export async function workflowRunArtifacts(
  ctx: GatewayContext,
  rawParams: unknown,
): Promise<V4ConversationWorkflowRunArtifactsResult> {
  const params = v4ConversationWorkflowRunArtifactsParamsSchema.parse(rawParams);
  if (!ctx.host.listDynamicWorkflowRunArtifacts) {
    throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunArtifacts", params.sessionId);
  }
  await ctx.ensureHostRecordForJournalRead(params.sessionId);
  const artifacts = await ctx.host.listDynamicWorkflowRunArtifacts(params.sessionId, {
    runId: params.runId,
  });
  return v4ConversationWorkflowRunArtifactsResultSchema.parse({ artifacts: artifacts ?? [] });
}

/**
 * 预置看板的取数面：喂给某个产物的 `report` 条目分页。
 *
 * 条数的**缺省与钳制**、以及字节上界都在这里定（存储层精确兑现、绝不自造页大小也绝不再钳）。`fields` 原样下传：看板只要 spec 点名的字段，由 SQLite 取出；`hasMore` 由存储层判定——页可能因字节提前收尾，所以判据绝不能是
 * 「这页正好满」，也不再是网关多取一条。
 */
export async function workflowRunArtifactData(
  ctx: GatewayContext,
  rawParams: unknown,
): Promise<V4ConversationWorkflowRunArtifactDataResult> {
  const params = v4ConversationWorkflowRunArtifactDataParamsSchema.parse(rawParams);
  if (!ctx.host.listDynamicWorkflowRunArtifactItems) {
    throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunArtifactItems", params.sessionId);
  }
  await ctx.ensureHostRecordForJournalRead(params.sessionId);
  const limit = Math.max(
    1,
    Math.min(
      params.limit ?? WORKFLOW_ARTIFACT_LIMITS.defaultItemsPerPage,
      WORKFLOW_ARTIFACT_LIMITS.maxItemsPerPage,
    ),
  );
  const page = await ctx.host.listDynamicWorkflowRunArtifactItems(params.sessionId, {
    runId: params.runId,
    artifactId: params.artifactId,
    ...(params.afterSequence === undefined ? {} : { afterSequence: params.afterSequence }),
    limit,
    maxBytes: WORKFLOW_ARTIFACT_LIMITS.maxPageBytes,
    ...(params.fields === undefined ? {} : { fields: params.fields }),
  });
  return v4ConversationWorkflowRunArtifactDataResultSchema.parse(page);
}

/**
 * 内容产物的字节，**逐字照 attachmentRead**：一次一块、≤ 512 KiB（schema 已钉住 limit 的
 * 上界），`nextOffset` 为 null 即读到尾。
 *
 * **授权全在宿主侧**（端口实现）：该 run 必须属于 `sessionId` 这个会话 ∧ journal 里有
 * `(artifactId, version)` 的 completed 行，然后才拿**行上的** uri 去 store 读。网关只做
 * 参数校验与分块——它没有 journal，也不该有第二份授权判据（两处各判一次，同一个 id
 * 迟早会在两层上得到不同的解释）。宿主回 `undefined` = 无此版本 / 不是你的 run /
 * 这是块看板（没有字节），三者对调用方是同一个业务事实，这里归一成结构化的 not found。
 *
 * `offset` 越界不是错误：返回空块 + `nextOffset: null`，与读到尾同一形态。
 */
export async function workflowRunArtifactRead(
  ctx: GatewayContext,
  rawParams: unknown,
): Promise<V4ConversationWorkflowRunArtifactReadResult> {
  const params = v4ConversationWorkflowRunArtifactReadParamsSchema.parse(rawParams);
  if (!ctx.host.readDynamicWorkflowRunArtifact) {
    throw new V4CapabilityUnsupportedError("readDynamicWorkflowRunArtifact", params.sessionId);
  }
  await ctx.ensureHostRecordForJournalRead(params.sessionId);
  const artifact = await ctx.readWorkflowArtifactPayload(params);
  const totalBytes = artifact.bytes.byteLength;
  const start = Math.min(params.offset, totalBytes);
  const end = Math.min(start + params.limit, totalBytes);
  const chunk = artifact.bytes.subarray(start, end);
  return v4ConversationWorkflowRunArtifactReadResultSchema.parse({
    dataBase64: Buffer.from(chunk).toString("base64"),
    mediaType: artifact.mediaType,
    totalBytes,
    nextOffset: end < totalBytes ? end : null,
  });
}

/**
 * 工作区 transcript 的清单：一个 run 的
 * `files.*` / `git.*` / `world.run` 行，不带正文。
 *
 * 宿主回 `undefined`（未知 run / 不是你的 run）得到空清单而不是错误：与产物清单同一姿态，
 * 也是授权链「不告诉越权者猜对了哪一半」的要求。清单超过 maxNodes 截尾并置 `truncated`——
 * 一个循环里跑了三千次 `world.run` 的 run 不该把侧板撑爆。
 */
export async function workflowRunWorkspace(
  ctx: GatewayContext,
  rawParams: unknown,
): Promise<V4ConversationWorkflowRunWorkspaceResult> {
  const params = v4ConversationWorkflowRunWorkspaceParamsSchema.parse(rawParams);
  if (!ctx.host.listDynamicWorkflowRunWorkspaceNodes) {
    throw new V4CapabilityUnsupportedError(
      "listDynamicWorkflowRunWorkspaceNodes",
      params.sessionId,
    );
  }
  await ctx.ensureHostRecordForJournalRead(params.sessionId);
  const nodes =
    (await ctx.host.listDynamicWorkflowRunWorkspaceNodes(params.sessionId, {
      runId: params.runId,
    })) ?? [];
  const truncated = nodes.length > WORKFLOW_WORKSPACE_LIMITS.maxNodes;
  return v4ConversationWorkflowRunWorkspaceResultSchema.parse({
    nodes: truncated ? nodes.slice(0, WORKFLOW_WORKSPACE_LIMITS.maxNodes) : nodes,
    ...(truncated ? { truncated: true } : {}),
  });
}

/**
 * 一个工作区节点的正文，按 `maxBytes` 保形有界化（缺省与上限都是 resultMaxBytes，钳在这里）。
 * 授权全在宿主侧；宿主回 `undefined` = 无此节点 / 不是你的 run / 不是 world 行，归一成
 * 结构化的 not found。
 */
export async function workflowRunNodeResult(
  ctx: GatewayContext,
  rawParams: unknown,
): Promise<V4ConversationWorkflowRunNodeResultResult> {
  const params = v4ConversationWorkflowRunNodeResultParamsSchema.parse(rawParams);
  if (!ctx.host.readDynamicWorkflowRunNodeResult) {
    throw new V4CapabilityUnsupportedError("readDynamicWorkflowRunNodeResult", params.sessionId);
  }
  await ctx.ensureHostRecordForJournalRead(params.sessionId);
  const maxBytes = Math.max(
    1,
    Math.min(
      params.maxBytes ?? WORKFLOW_WORKSPACE_LIMITS.resultMaxBytes,
      WORKFLOW_WORKSPACE_LIMITS.resultMaxBytes,
    ),
  );
  const result = await ctx.host.readDynamicWorkflowRunNodeResult(params.sessionId, {
    runId: params.runId,
    siteId: params.siteId,
    ordinal: params.ordinal,
    maxBytes,
  });
  if (result === undefined) {
    throw new Error(
      `fault.workflowRunNodeResult.notFound: ${params.runId}/${params.siteId}@${params.ordinal}`,
    );
  }
  return v4ConversationWorkflowRunNodeResultResultSchema.parse(result);
}

/**
 * 一个产物版本的**整份**字节，带缓存。
 *
 * 端口的 `readArtifact` 返回的是整份字节，而
 * `workflowRunArtifactRead` 是**分块**查询——不缓存的话，一个 20 MiB 的 PDF 按 512 KiB
 * 分 40 块取，就会把整份文件从 store 读 40 遍（800 MiB 的 I/O），而且每一块都要重走一遍
 * journal 授权链。`attachmentRead` 早就有这张表，这里复用它（见 {@link BinaryReadCacheEntry}
 * 关于两个家族共用一张表的论证）。
 *
 * 缓存的是 **promise 而不是结果**，且在发起前就写进表里：并发抓取的多个分块因此共享
 * 同一次读，而不是各自发起一次再各自写一遍缓存。
 *
 * 授权不因缓存被绕过：键里带着 `sessionId`，而 `sessionId` 正是端口那条授权链
 * （run 的 parentSessionId 必须等于它）的比对对象——换一个会话就是另一个键，必然重新
 * 走一次端口。会话销毁时按 `sessionId` 整片清掉，与附件同一条规则。
 *
 * 宿主回 `undefined`（不是你的 run / 无此版本 / 是块看板）在这里**抛错**而不是被缓存：
 * 走既有的 catch 分支把条目删掉，于是一个"发布刚落库、读稍微早了一步"的竞态不会被
 * 负缓存钉死 30 秒。
 */
export function readWorkflowArtifactPayload(
  ctx: GatewayContext,
  params: {
    sessionId: string;
    runId: string;
    artifactId: string;
    version: number;
  },
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const now = ctx.now();
  ctx.pruneBinaryReadCache(now);
  // 首段标签 `dwfart`：与附件预览共用同一张表，靠首段隔离（见 BinaryReadCacheEntry）。
  const key = `dwfart\u0000${params.sessionId}\u0000${params.runId}\u0000${params.artifactId}\u0000${params.version}`;
  const cached = ctx.binaryReadCache.get(key);
  if (cached) {
    cached.accessedAt = now;
    return cached.payload;
  }

  const payload = ctx.host.readDynamicWorkflowRunArtifact!(params.sessionId, {
    runId: params.runId,
    artifactId: params.artifactId,
    version: params.version,
  })
    .then((artifact) => {
      if (artifact === undefined) {
        throw new Error(
          `fault.workflowRunArtifactRead.notFound: ${params.runId}/${params.artifactId}@${params.version}`,
        );
      }
      const current = ctx.binaryReadCache.get(key);
      if (current) {
        current.bytes = artifact.bytes.byteLength;
        ctx.binaryReadCacheBytes += artifact.bytes.byteLength;
        ctx.pruneBinaryReadCache(ctx.now());
      }
      // contentType 归一成表里的 mediaType 词汇；值仍是 journal 记录上的那一份
      // （UI 分派渲染器的精确匹配契约），不是 store 按文件名再推的那个。
      return { bytes: artifact.bytes, mediaType: artifact.contentType };
    })
    .catch((error: unknown) => {
      ctx.deleteBinaryReadCacheEntry(key);
      throw error;
    });
  ctx.binaryReadCache.set(key, {
    sessionId: params.sessionId,
    accessedAt: now,
    bytes: null,
    payload,
  });
  return payload;
}

/**
 * dwf 两个 journal 读面的宿主 record 前置。
 *
 * 这两个 query 都经 app 能力读 journal，而宿主按 sessionId 找 record——历史
 * 会话的 record 只由**订阅**路径激活。renderer 里发现查询的 effect 声明在 lease/订阅
 * effect 之前，而 CLI 严格串行派发请求（`zcode-protocol/transport.ts`，只有 session/stop
 * 越队），于是「重启后打开历史会话」时它必然先于订阅被处理、必然拿到 sessionNotFound：
 * 工具卡的 join 回退整块消失，卡片退回编译态，被打断的 run 连入口都没有。
 *
 * 只拉 record，**不**建 READY publisher：journal 与 conversation log 无关，读一页 run
 * 不需要投影（同一判断见这两个 query 刻意不带 atSeq/atLogEpoch）。习语与 attachmentBegin
 * 逐字相同；`ensureResumed` 自带按会话单飞，与并发订阅共享同一次 activation。
 *
 * 活性判定必须与 subscribe 同一条
 * `hasLiveConversation`，不能只看 `sessionExists`。dwf actor transcript 是 detached live
 * 会话——真 runtime 活在 run service 里、宿主刻意没有 record；嵌套 SessionPane 的发现
 * 查询带着 actor id 打到这里，旧判定就对一条**正在运行**的会话物化出第二个（幽灵）
 * runtime：它向同一份事件日志追加 SessionResumed、丢弃 pending steer、重放 resume hooks，
 * 双写把序列账搞乱，transcript 从此定格（症状是直播冻结在「已工作 xx 秒」）。
 */
export async function ensureHostRecordForJournalRead(
  ctx: GatewayContext,
  sessionId: string,
): Promise<void> {
  const ready = ctx.readyFlights.get(sessionId);
  if (ready) await ready;
  if (ctx.publishers.get(sessionId)?.getSnapshot().runtimeInitialization?.status === "failed")
    throw new Error("fault.subscribe.resumeFailed");
  if (ctx.hasLiveConversation(sessionId)) return;
  await ctx.coldResume.ensureResumed(sessionId);
}

export async function fileChanges(
  ctx: GatewayContext,
  rawParams: unknown,
): Promise<V4ConversationFileChangesResult> {
  const params = v4ConversationFileChangesParamsSchema.parse(rawParams);
  if (!ctx.host.getConversationFileChanges) {
    throw new Error("fault.fileChanges.unsupported");
  }
  const existingReady = ctx.readyFlights.get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !ctx.hasLiveConversation(params.sessionId)
      ? await ctx.ensureColdReadyPublisher(params.sessionId)
      : await ctx.hydratePublisher(params.sessionId);
  const resolution = ctx.resolveQueryRowTarget(publisher, params, "fileChanges");
  const messageIds = resolution.messageIds ?? [];
  const targetTurnId = toRuntimeTurnId(resolution.row.turnId);
  return ctx.host.getConversationFileChanges(
    params.sessionId,
    params.target.rowId,
    messageIds,
    targetTurnId,
  );
}

export async function backgroundBashOutput(
  ctx: GatewayContext,
  rawParams: unknown,
): Promise<BackgroundBashOutputResult> {
  const { sessionId, workId } = v4BackgroundBashOutputParamsSchema.parse(rawParams);
  // 观察查询不能 hydrate/恢复冷会话；任务由现有 runtime 授权。
  if (!ctx.host.readBackgroundBashOutput) return { kind: "unsupported", workId };
  return backgroundBashOutputResultSchema.parse(
    await ctx.host.readBackgroundBashOutput(sessionId, workId),
  );
}

export async function fileRewindPreview(
  ctx: GatewayContext,
  rawParams: unknown,
): Promise<V4ConversationFileRewindPreviewResult> {
  const params = v4ConversationFileRewindPreviewParamsSchema.parse(rawParams);
  if (!ctx.host.previewConversationFileRewind) {
    throw new Error("fault.fileRewindPreview.unsupported");
  }
  const existingReady = ctx.readyFlights.get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !ctx.host.sessionExists(params.sessionId)
      ? await ctx.ensureColdReadyPublisher(params.sessionId)
      : await ctx.hydratePublisher(params.sessionId);
  const resolution = ctx.resolveQueryRowTarget(publisher, params, "fileRewindPreview");
  const messageIds = resolution.messageIds ?? [];
  const targetTurnId = toRuntimeTurnId(resolution.row.turnId);
  return ctx.host.previewConversationFileRewind(
    params.sessionId,
    params.target.rowId,
    messageIds,
    targetTurnId,
  );
}

export function resolveQueryRowTarget(
  ctx: GatewayContext,
  publisher: ConversationTopicPublisher,
  params: {
    target: ConversationRowTarget;
    baseRevision: number;
    baseLogEpoch: string;
  },
  action: "fileChanges" | "fileRewindPreview",
): Extract<ReturnType<ConversationTopicPublisher["resolveRowActionTarget"]>, { ok: true }> {
  const snapshot = publisher.getSnapshot();
  if (params.baseLogEpoch !== snapshot.logEpoch) throw new Error("proto.staleLogEpoch");
  if (params.baseRevision !== snapshot.revision) throw new Error("proto.staleRevision");
  const resolution = publisher.resolveRowActionTarget(params.target, action);
  if (!resolution.ok) throw new Error(resolution.reasonCode);
  return resolution;
}

function toRuntimeTurnId(turnId: string | null): TurnId | null {
  // conversation projection 为了 row 索引用 string 保存 product turnId；
  // 离开 gateway 调 runtime 文件摘要/回退能力时，需要恢复 contracts 的品牌类型。
  return turnId as TurnId | null;
}
