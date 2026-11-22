import type { ZCodeAgentServiceRuntime } from "./zcodeAgentServiceRuntime.js";
import {
  MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE,
  V4_METHODS,
  ZCODE_ATTACHMENT_FAULT_CODES,
  ZCodeAttachmentFaultError,
  backgroundBashOutputResultSchema,
  commandAckSchema,
  commandPayloadSchemas,
  commandsQueryParamsSchema,
  commandsQueryResultSchema,
  sessionsIndexReconcileResultSchema,
  sessionsIndexTopic,
  type CommandAck,
  v4AttachmentAbortResultSchema,
  v4AttachmentBeginResultSchema,
  v4AttachmentChunkResultSchema,
  v4AttachmentCommitResultSchema,
  v4AttachmentPreviewSourceParamsSchema,
  v4AttachmentPreviewSourceResultSchema,
  v4AttachmentReadParamsSchema,
  v4AttachmentReadResultSchema,
  v4BackgroundBashOutputParamsSchema,
  v4ConversationAttachmentReadParamsSchema,
  v4ConversationAttachmentReadResultSchema,
  v4ConversationAttachmentStatParamsSchema,
  v4ConversationAttachmentStatResultSchema,
  v4ConversationFileChangesResultSchema,
  v4ConversationFileRewindPreviewResultSchema,
  v4ConversationPlansResultSchema,
  v4ConversationRowsRangeResultSchema,
  v4ConversationWorkflowRunArtifactDataResultSchema,
  v4ConversationWorkflowRunArtifactReadResultSchema,
  v4ConversationWorkflowRunArtifactsResultSchema,
  v4ConversationWorkflowRunEventsResultSchema,
  v4ConversationWorkflowRunNodeResultResultSchema,
  v4ConversationWorkflowRunWorkspaceResultSchema,
  v4ConversationWorkflowRunsResultSchema,
  v4SessionsIndexSubscribeResultSchema,
  v4WorkspaceConfigSubscribeResultSchema,
  workspaceConfigTopic,
} from "@zcode/shared/zcode-protocol-v4";
import {
  ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
  type IZCodeAgentService,
  type ZCodeAgentAttachmentBeginParams,
  type ZCodeAgentAttachmentChunkParams,
  type ZCodeAgentAttachmentPreviewSourceParams,
  type ZCodeAgentAttachmentReadParams,
  type ZCodeAgentAttachmentTerminalParams,
  type ZCodeAgentBackgroundBashOutputParams,
  type ZCodeAgentCommandsQueryParams,
  type ZCodeAgentConversationAttachmentReadParams,
  type ZCodeAgentConversationAttachmentStatParams,
  type ZCodeAgentConversationCommandParams,
  type ZCodeAgentConversationFileChangesParams,
  type ZCodeAgentConversationFileRewindPreviewParams,
  type ZCodeAgentConversationPlansParams,
  type ZCodeAgentConversationResyncParams,
  type ZCodeAgentConversationRowsRangeParams,
  type ZCodeAgentConversationUnsubscribeParams,
  type ZCodeAgentConversationWorkflowRunArtifactDataParams,
  type ZCodeAgentConversationWorkflowRunArtifactReadParams,
  type ZCodeAgentConversationWorkflowRunArtifactsParams,
  type ZCodeAgentConversationWorkflowRunEventsParams,
  type ZCodeAgentConversationWorkflowRunNodeResultParams,
  type ZCodeAgentConversationWorkflowRunWorkspaceParams,
  type ZCodeAgentConversationWorkflowRunsParams,
  type ZCodeAgentRuntimeLifecycleEvent,
  type ZCodeAgentSessionsIndexSubscribeParams,
  type ZCodeAgentWorkspaceConfigSubscribeParams,
  type ZCodeAgentWorkspaceTarget,
} from "./zcodeAgent.js";
import {
  assertV4AttachmentNdjsonEnvelope,
  isProtocolMethodNotFoundError,
  logger,
  supportsLegacyRemoteTaskAllowlist,
} from "./zcodeAgentServiceSupport.js";
import {
  offPeakControlParamsSchema,
  offPeakControlResultSchema,
  resolveWorkspaceKey,
  type LocalTtftFacts,
  type OffPeakControlParams,
} from "@zcode/shared";
import { collectBrowserAmbientContext } from "./zcodeAgentBrowserAmbientContext.js";
import { ensureIndependentPlanSupport } from "./independentPlanSupport.js";
import { readTrustedZCodeAgentV4Connection } from "./zcodeAgentConnectionScope.js";
import { requiresProviderRegistryRefresh } from "./zcodeAgentServiceParams.js";

export function createV4Methods(
  ctx: ZCodeAgentServiceRuntime,
): Pick<
  IZCodeAgentService,
  | "sendConversationCommandV4"
  | "queryConversationCommandsV4"
  | "attachmentBeginV4"
  | "attachmentChunkV4"
  | "attachmentCommitV4"
  | "attachmentAbortV4"
  | "attachmentReadV4"
  | "conversationAttachmentReadV4"
  | "conversationAttachmentStatV4"
  | "attachmentPreviewSourceV4"
  | "conversationRowsRangeV4"
  | "conversationPlansV4"
  | "conversationWorkflowRunEventsV4"
  | "conversationWorkflowRunsV4"
  | "conversationWorkflowRunArtifactsV4"
  | "conversationWorkflowRunArtifactDataV4"
  | "conversationWorkflowRunArtifactReadV4"
  | "conversationWorkflowRunWorkspaceV4"
  | "conversationWorkflowRunNodeResultV4"
  | "backgroundBashOutputV4"
  | "conversationFileChangesV4"
  | "conversationFileRewindPreviewV4"
  | "onDynamicConversationFrame"
  | "onDynamicLocalTtftFacts"
  | "onDynamicConversationTelemetryFact"
  | "onDynamicOffPeakLifecycle"
  | "controlOffPeakExecutionV4"
  | "onDynamicPluginUiToolResult"
  | "onDynamicCuaPermissionObservation"
  | "reconcileSessionsIndexV4"
  | "subscribeSessionsIndexV4"
  | "unsubscribeSessionsIndexV4"
  | "resyncSessionsIndexV4"
  | "onDynamicSessionsIndexFrame"
  | "subscribeWorkspaceConfigV4"
  | "unsubscribeWorkspaceConfigV4"
  | "resyncWorkspaceConfigV4"
  | "onDynamicWorkspaceConfigFrame"
  | "onDynamicProcessResourceSample"
  | "onDynamicToolExecResource"
  | "onDynamicMcpResourceSamples"
  | "onDynamicMcpTelemetry"
  | "onAgentRuntimeRestarted"
  | "onAgentRuntimeLifecycle"
  | "disposeWorkspace"
  | "disposeAll"
> & { disposeAllAndWait(): Promise<void> } {
  const {
    activeClientsByWorkspaceKey,
    automationRepo,
    automationTaskIndexRepo,
    buildConversationCommandEnvelope,
    cancelWaitingWorkspaceStartup,
    clearV4SubscriptionRoutes,
    cuaOperationTurnTracker,
    cuaPermissionObservationEmitter,
    disposeLocalState,
    disposeOpenCodeRuns,
    ensureAccountProviderConfigSynced,
    forgetSession,
    getClient,
    getConversationFrameEmitter,
    getConversationTelemetryFactEmitter,
    getOffPeakLifecycleEmitter,
    getReadOnlyClient,
    getSessionsIndexFrameEmitter,
    getWorkspaceConfigFrameEmitter,
    interactionPreferenceSyncByWorkspaceKey,
    invalidateWorkspaceClient,
    localTtftFactsEmitter,
    mcpResourceSamplesEmitter,
    mcpStatusProcessManager,
    mcpTelemetryEmitter,
    mutable,
    options,
    pluginProcessManager,
    pluginUiToolResultEmitter,
    processManager,
    processResourceSampleEmitter,
    rememberV4SubscriptionRoute,
    resolveV4Connection,
    resyncV4Route,
    toolExecResourceEmitter,
    unsubscribeV4Route,
    v4ConnectionIdFor,
  } = ctx;
  return {
    async sendConversationCommandV4(params: ZCodeAgentConversationCommandParams) {
      const openCodeAcpDraft =
        params.envelope.type === "createSession" &&
        commandPayloadSchemas.createSession.parse(params.envelope.payload).openCodeAcpDraft ===
          true;
      const openCodeAcpSend =
        params.envelope.type === "sendText" &&
        commandPayloadSchemas.sendText.parse(params.envelope.payload).executionRoute.kind ===
          "opencode-acp";
      // Причина: ACP-команда не исполняется моделью ZCode, но общий клиент требовал ZCode-провайдера
      // ещё до CLI admission. Валидация маршрута сохраняет этот обход только для пустого ACP draft
      // и явного OpenCode ACP sendText; обычные команды проходят прежний gate.
      const isOpenCodeControlCommand = openCodeAcpDraft || openCodeAcpSend;
      const client = isOpenCodeControlCommand
        ? await getReadOnlyClient(params)
        : await getClient(params);
      const planPayload = params.envelope.payload as {
        planEnabled?: boolean;
        config?: { planEnabled?: boolean };
        firstInput?: { planEnabled?: boolean };
      };
      if (
        planPayload.planEnabled ||
        planPayload.config?.planEnabled ||
        planPayload.firstInput?.planEnabled
      ) {
        await ensureIndependentPlanSupport(client);
      }
      // RPC facade 会清掉调用方可伪造的顶层 clientMode，再用 trusted carrier 注入 host
      // 真值；host 内部 adapter 直调仍兼容显式 clientMode。
      const commandClientMode =
        readTrustedZCodeAgentV4Connection(params)?.clientMode ??
        params.clientMode ??
        "desktop-continuous";
      let envelope = await buildConversationCommandEnvelope(params);
      if (requiresProviderRegistryRefresh(envelope.type) && !isOpenCodeControlCommand) {
        await ensureAccountProviderConfigSynced({
          client,
          reason: "v4_command",
          workspace: params,
          refreshRegistry: true,
        });
      }
      // TTFT 首版只允许可信桌面本地 continuous，手机/远端透传不能开启本地观测。
      if (
        commandClientMode !== "desktop-continuous" ||
        params.workspaceIdentity?.trim() ||
        params.remoteSessionId
      ) {
        const { ttft: _ttft, ...withoutTtft } = envelope;
        envelope = withoutTtft;
      }
      if (envelope.type === "sendText" && envelope.sessionId) {
        const sessionId = envelope.sessionId;
        const payload = {
          ...commandPayloadSchemas.sendText.parse(envelope.payload),
          inputOrigin:
            commandClientMode === "web-remote-replayable"
              ? ("mobile" as const)
              : ("desktop" as const),
        };
        envelope = { ...envelope, payload };
        const browserAmbientContext = await collectBrowserAmbientContext(
          options?.browserControlExecutor,
          {
            sessionId,
            workspacePath: params.workspacePath,
            ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
            clientMode: commandClientMode,
          },
        );
        if (browserAmbientContext) {
          envelope = {
            ...envelope,
            payload: { ...payload, browserAmbientContext },
          };
        }
      }
      const ack: CommandAck = await client.request(V4_METHODS.command, envelope, commandAckSchema);
      // 会话删除同样是生命周期终点；accepted/duplicate/noop 都表示目标会话已不可用。
      // 不在这里清 Host 镜像，UI 删除后 seq/trace/emitter 会一直留到进程退出。
      if (
        envelope.type === "deleteSession" &&
        envelope.sessionId &&
        (ack.status === "accepted" || ack.status === "duplicate" || ack.status === "noop")
      ) {
        forgetSession({ ...params, sessionId: envelope.sessionId });
      }
      // Prompt command 在 committed TurnStarted 或 committed WorkspaceHookReviewRequested
      // 任一 authority 到达后即返回；人工审核不能占用 Host RPC，因此继续使用统一默认
      // timeout/watchdog。放宽到审核领域 deadline 只会掩盖串行协议队列死锁。
      // duplicate 只证明 commandId 曾处理过，不证明其目标仍是当前 session 配置。
      // 旧 B 命令在用户已切 C 后重放时，不能借 duplicate 把派生缓存再改回 B。
      return ack;
    },

    async queryConversationCommandsV4(params: ZCodeAgentCommandsQueryParams) {
      if (!readTrustedZCodeAgentV4Connection(params)) {
        throw new Error("fault.command.queryConnectionUntrusted");
      }
      const query = commandsQueryParamsSchema.parse({
        commands: params.commands,
        ...(params.clock ? { clock: true } : {}),
      });
      const client = await getReadOnlyClient(params);
      return client.request(V4_METHODS.commandsQuery, query, commandsQueryResultSchema);
    },

    async attachmentBeginV4(params: ZCodeAgentAttachmentBeginParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.connectionUntrusted");
      const client = await getClient(params);
      const wireParams = {
        connectionId: trusted.connectionId,
        uploadId: params.uploadId,
        sessionId: params.sessionId,
        fileName: params.fileName,
        mime: params.mime,
        totalBytes: params.totalBytes,
        totalChunks: params.totalChunks,
        checksum: params.checksum,
      };
      assertV4AttachmentNdjsonEnvelope(V4_METHODS.attachmentBegin, wireParams);
      return client.request(V4_METHODS.attachmentBegin, wireParams, v4AttachmentBeginResultSchema);
    },

    async attachmentChunkV4(params: ZCodeAgentAttachmentChunkParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.connectionUntrusted");
      const client = await getClient(params);
      const wireParams = {
        connectionId: trusted.connectionId,
        uploadId: params.uploadId,
        sessionId: params.sessionId,
        chunkIndex: params.chunkIndex,
        dataBase64: params.dataBase64,
      };
      assertV4AttachmentNdjsonEnvelope(V4_METHODS.attachmentChunk, wireParams);
      return client.request(V4_METHODS.attachmentChunk, wireParams, v4AttachmentChunkResultSchema);
    },

    async attachmentCommitV4(params: ZCodeAgentAttachmentTerminalParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.connectionUntrusted");
      const client = await getClient(params);
      const wireParams = {
        connectionId: trusted.connectionId,
        uploadId: params.uploadId,
        sessionId: params.sessionId,
      };
      assertV4AttachmentNdjsonEnvelope(V4_METHODS.attachmentCommit, wireParams);
      return client.request(
        V4_METHODS.attachmentCommit,
        wireParams,
        v4AttachmentCommitResultSchema,
      );
    },

    async attachmentAbortV4(params: ZCodeAgentAttachmentTerminalParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.connectionUntrusted");
      const client = await getClient(params);
      const wireParams = {
        connectionId: trusted.connectionId,
        uploadId: params.uploadId,
        sessionId: params.sessionId,
      };
      assertV4AttachmentNdjsonEnvelope(V4_METHODS.attachmentAbort, wireParams);
      await client.request(V4_METHODS.attachmentAbort, wireParams, v4AttachmentAbortResultSchema);
    },

    async attachmentReadV4(params: ZCodeAgentAttachmentReadParams) {
      if (!readTrustedZCodeAgentV4Connection(params)) {
        throw new Error("fault.attachment.readConnectionUntrusted");
      }
      const wireParams = v4AttachmentReadParamsSchema.parse({
        sessionId: params.sessionId,
        ref: params.ref,
        ...(params.target ? { target: params.target } : {}),
        ...(params.attachmentIndex !== undefined
          ? { attachmentIndex: params.attachmentIndex }
          : {}),
        offset: params.offset,
        limit: params.limit,
      });
      const client = await getReadOnlyClient(params);
      return client.request(V4_METHODS.attachmentRead, wireParams, v4AttachmentReadResultSchema);
    },

    async conversationAttachmentReadV4(params: ZCodeAgentConversationAttachmentReadParams) {
      if (!readTrustedZCodeAgentV4Connection(params)) {
        throw new ZCodeAttachmentFaultError(
          ZCODE_ATTACHMENT_FAULT_CODES.shareReadConnectionUntrusted,
        );
      }
      const wireParams = v4ConversationAttachmentReadParamsSchema.parse({
        sessionId: params.sessionId,
        ref: params.ref,
        target: params.target,
        attachmentIndex: params.attachmentIndex,
        offset: params.offset,
        limit: params.limit,
      });
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationAttachmentRead,
        wireParams,
        v4ConversationAttachmentReadResultSchema,
      );
    },

    async conversationAttachmentStatV4(params: ZCodeAgentConversationAttachmentStatParams) {
      if (!readTrustedZCodeAgentV4Connection(params)) {
        throw new ZCodeAttachmentFaultError(
          ZCODE_ATTACHMENT_FAULT_CODES.shareStatConnectionUntrusted,
        );
      }
      const wireParams = v4ConversationAttachmentStatParamsSchema.parse({
        sessionId: params.sessionId,
        ref: params.ref,
        target: params.target,
        attachmentIndex: params.attachmentIndex,
      });
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationAttachmentStat,
        wireParams,
        v4ConversationAttachmentStatResultSchema,
      );
    },

    async attachmentPreviewSourceV4(params: ZCodeAgentAttachmentPreviewSourceParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.previewSourceConnectionUntrusted");
      if (trusted.clientMode !== "desktop-continuous" || params.remoteSessionId) {
        return { kind: "chunked" } as const;
      }
      const wireParams = v4AttachmentPreviewSourceParamsSchema.parse({
        sessionId: params.sessionId,
        ref: params.ref,
        ...(params.target ? { target: params.target } : {}),
        ...(params.attachmentIndex !== undefined
          ? { attachmentIndex: params.attachmentIndex }
          : {}),
        clientMode: trusted.clientMode,
      });
      const client = await getReadOnlyClient(params);
      const source = await client.request(
        V4_METHODS.attachmentPreviewSource,
        wireParams,
        v4AttachmentPreviewSourceResultSchema,
      );
      if (source.kind !== "local_path") return source;
      if (!options?.authorizeLocalMediaPreviewPath) {
        throw new Error("fault.attachment.previewPathAuthorizationUnavailable");
      }
      return {
        ...source,
        path: await options.authorizeLocalMediaPreviewPath(source.path),
      };
    },

    // 行分页：只读 query 透传（超时重发安全，无订阅状态）。
    async conversationRowsRangeV4(params: ZCodeAgentConversationRowsRangeParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.conversation.rowsRangeConnectionUntrusted");
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationRowsRange,
        {
          sessionId: params.sessionId,
          clientMode: trusted.clientMode,
          ...(params.beforeRowId !== undefined ? { beforeRowId: params.beforeRowId } : {}),
          limit: params.limit,
        },
        v4ConversationRowsRangeResultSchema,
      );
    },

    // 只读计划目录沿现有 workspace attachment 透传，不建立新 runtime。
    async conversationPlansV4(params: ZCodeAgentConversationPlansParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationPlans,
        { sessionId: params.sessionId },
        v4ConversationPlansResultSchema,
      );
    },

    // workflow run 事件日志：同样是只读 query，沿现有 workspace attachment 透传。
    // 分页发生在存储层（JournalStorePort.listEvents 带 afterSequence/limit），这里不切片；
    // 在 RPC 层切等于每翻一页把整条 journal 读进内存。
    async conversationWorkflowRunEventsV4(params: ZCodeAgentConversationWorkflowRunEventsParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunEvents,
        {
          sessionId: params.sessionId,
          runId: params.runId,
          ...(params.afterSequence !== undefined ? { afterSequence: params.afterSequence } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        },
        v4ConversationWorkflowRunEventsResultSchema,
      );
    },

    // workflow run 枚举：journal-backed 的重启后发现面（workflowRuns 投影跨进程不存活）。
    async conversationWorkflowRunsV4(params: ZCodeAgentConversationWorkflowRunsParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRuns,
        {
          sessionId: params.sessionId,
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        },
        v4ConversationWorkflowRunsResultSchema,
      );
    },

    // dwf 用户面产物的三条读面。
    // ⚠ 术语：artifact = 脚本发布给用户看的产出，不是 run 的顶层返回值。
    // 三条与 plans / workflowRunEvents 同族：只读、无状态、超时重发安全，走只读客户端。
    async conversationWorkflowRunArtifactsV4(
      params: ZCodeAgentConversationWorkflowRunArtifactsParams,
    ) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunArtifacts,
        { sessionId: params.sessionId, runId: params.runId },
        v4ConversationWorkflowRunArtifactsResultSchema,
      );
    },

    // 看板取数：limit 的缺省与钳制在 CLI 网关侧，这里只透传——两处各钳一次，
    // 同一个 limit 迟早会在两层上得到不同的页大小。
    async conversationWorkflowRunArtifactDataV4(
      params: ZCodeAgentConversationWorkflowRunArtifactDataParams,
    ) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunArtifactData,
        {
          sessionId: params.sessionId,
          runId: params.runId,
          artifactId: params.artifactId,
          ...(params.afterSequence !== undefined ? { afterSequence: params.afterSequence } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        },
        v4ConversationWorkflowRunArtifactDataResultSchema,
      );
    },

    // 字节：一次一块（≤ 512 KiB），拼接归 renderer 的 hook。授权全在 CLI 侧——
    // 这里传下去的 id 只用于在 journal 里查行，绝不成为路径。
    async conversationWorkflowRunArtifactReadV4(
      params: ZCodeAgentConversationWorkflowRunArtifactReadParams,
    ) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunArtifactRead,
        {
          sessionId: params.sessionId,
          runId: params.runId,
          artifactId: params.artifactId,
          version: params.version,
          offset: params.offset,
          limit: params.limit,
        },
        v4ConversationWorkflowRunArtifactReadResultSchema,
      );
    },

    // dwf 工作区 transcript 的两条读面。同族：
    // 只读、无状态、超时重发安全，走只读客户端。maxBytes 的缺省与钳制在 CLI 网关侧。
    async conversationWorkflowRunWorkspaceV4(
      params: ZCodeAgentConversationWorkflowRunWorkspaceParams,
    ) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunWorkspace,
        { sessionId: params.sessionId, runId: params.runId },
        v4ConversationWorkflowRunWorkspaceResultSchema,
      );
    },

    async conversationWorkflowRunNodeResultV4(
      params: ZCodeAgentConversationWorkflowRunNodeResultParams,
    ) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunNodeResult,
        {
          sessionId: params.sessionId,
          runId: params.runId,
          siteId: params.siteId,
          ordinal: params.ordinal,
          ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
        },
        v4ConversationWorkflowRunNodeResultResultSchema,
      );
    },

    async backgroundBashOutputV4(params: ZCodeAgentBackgroundBashOutputParams) {
      if (!readTrustedZCodeAgentV4Connection(params))
        throw new Error("fault.bashOutput.connectionUntrusted");
      const wireParams = v4BackgroundBashOutputParamsSchema.parse({
        sessionId: params.sessionId,
        workId: params.workId,
      });
      try {
        const client = await getReadOnlyClient(params, "existing-only");
        return await client.request(
          V4_METHODS.backgroundBashOutput,
          wireParams,
          backgroundBashOutputResultSchema,
        );
      } catch (error) {
        if (isProtocolMethodNotFoundError(error))
          return { kind: "unsupported", workId: params.workId };
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE
        ) {
          return { kind: "unavailable", workId: params.workId };
        }
        throw error;
      }
    },

    async conversationFileChangesV4(params: ZCodeAgentConversationFileChangesParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationFileChanges,
        {
          sessionId: params.sessionId,
          target: params.target,
          baseRevision: params.baseRevision,
          baseLogEpoch: params.baseLogEpoch,
        },
        v4ConversationFileChangesResultSchema,
      );
    },

    async conversationFileRewindPreviewV4(params: ZCodeAgentConversationFileRewindPreviewParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationFileRewindPreview,
        {
          sessionId: params.sessionId,
          target: params.target,
          baseRevision: params.baseRevision,
          baseLogEpoch: params.baseLogEpoch,
        },
        v4ConversationFileRewindPreviewResultSchema,
      );
    },

    onDynamicConversationFrame(params: ZCodeAgentWorkspaceTarget) {
      return getConversationFrameEmitter(params).event;
    },

    onDynamicLocalTtftFacts(params: ZCodeAgentWorkspaceTarget) {
      return (listener: (facts: LocalTtftFacts) => void) =>
        localTtftFactsEmitter.event((event) => {
          if (event.workspaceKey === resolveWorkspaceKey(params)) listener(event.facts);
        });
    },
    onDynamicConversationTelemetryFact(params: ZCodeAgentWorkspaceTarget) {
      return getConversationTelemetryFactEmitter(params).event;
    },
    onDynamicOffPeakLifecycle(params: ZCodeAgentWorkspaceTarget) {
      return getOffPeakLifecycleEmitter(params).event;
    },
    async controlOffPeakExecutionV4(
      params: ZCodeAgentWorkspaceTarget & { control: OffPeakControlParams },
    ) {
      const control = offPeakControlParamsSchema.parse(params.control);
      const client = await getReadOnlyClient(params, "existing-only");
      return client.request(V4_METHODS.offPeakControl, control, offPeakControlResultSchema);
    },

    onDynamicPluginUiToolResult() {
      return pluginUiToolResultEmitter.event;
    },
    onDynamicCuaPermissionObservation() {
      return cuaPermissionObservationEmitter.event;
    },

    // ── sessions-index 通道（列表活性）：复用 conversationSubscribe RPC，
    // 按 topic 前缀由 CLI server 分派 ──

    async reconcileSessionsIndexV4(params) {
      const client = await getReadOnlyClient(params, "existing-only");
      return client.request(
        V4_METHODS.sessionsIndexReconcile,
        {
          workspaceId: resolveWorkspaceKey(params),
          sessionIds: params.sessionIds,
        },
        sessionsIndexReconcileResultSchema,
      );
    },

    async subscribeSessionsIndexV4(params: ZCodeAgentSessionsIndexSubscribeParams) {
      // 侧栏会同时登记所有 restored workspace。被动订阅若使用启动型 client，
      // workspace 数量会直接放大成 CLI 数量；existing-only 缺 runtime 时只进入 dormant。
      const client = await getReadOnlyClient(params, params.runtimePolicy);
      const connection = resolveV4Connection(params, v4ConnectionIdFor(params.subscriberScope));
      const topic = sessionsIndexTopic(resolveWorkspaceKey(params));
      // 3.3.6 的 CLI session 未写 remote workspace_id，但同版本 host task index
      // 已按完整 identity 隔离。升级时必须用当前 workspaceKey 下的 taskId 作归属证明；
      // 禁止只把 workspacePath 传给 CLI，否则同路径不同 SSH/WSL authority 会互相认领历史。
      let legacyTaskIds: string[] = [];
      if (supportsLegacyRemoteTaskAllowlist(params.workspaceIdentity)) {
        try {
          legacyTaskIds = (
            await automationTaskIndexRepo.listTaskMetas({
              workspacePath: params.workspacePath,
              workspaceIdentity: params.workspaceIdentity,
              provider: "glm",
            })
          )
            .slice(0, MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE)
            .map((task) => task.taskId);
        } catch (error) {
          // 归属证明只用于升级迁移；task index 不可用时仍要让已有完整
          // identity 的 3.4 会话走严格查询，不能让兼容读取故障变成整个列表不可用。
          logger.warn(undefined, "读取远端历史任务归属证明失败，继续按严格 identity 订阅", {
            error: error instanceof Error ? error.message : String(error),
            event: "sessions_index.legacy_remote_allowlist_read_failed",
            workspaceIdentity: params.workspaceIdentity,
            workspacePath: params.workspacePath,
          });
        }
      }
      const result = await client.request(
        V4_METHODS.conversationSubscribe,
        {
          topic,
          connectionId: connection.connectionId,
          clientMode: connection.clientMode,
          ...(legacyTaskIds.length > 0 ? { legacyTaskIds } : {}),
          ...(params.base ? { base: params.base } : {}),
          ...(params.visibility ? { visibility: params.visibility } : {}),
        },
        v4SessionsIndexSubscribeResultSchema,
      );
      rememberV4SubscriptionRoute(
        params,
        topic,
        result.ack.subscriptionId,
        connection.connectionId,
      );
      return result;
    },

    async unsubscribeSessionsIndexV4(params: ZCodeAgentConversationUnsubscribeParams) {
      await unsubscribeV4Route(params, "sessions-index/");
    },

    async resyncSessionsIndexV4(params: ZCodeAgentConversationResyncParams) {
      return resyncV4Route(params, "sessions-index/");
    },

    onDynamicSessionsIndexFrame(params: ZCodeAgentWorkspaceTarget) {
      return getSessionsIndexFrameEmitter(params).event;
    },

    // ── workspace-config 通道（配置目录活性）：复用 conversationSubscribe RPC，
    // 按 topic 前缀由 CLI server 分派 ──

    async subscribeWorkspaceConfigV4(params: ZCodeAgentWorkspaceConfigSubscribeParams) {
      const client = await getReadOnlyClient(params, params.runtimePolicy);
      const connection = resolveV4Connection(params, v4ConnectionIdFor(params.subscriberScope));
      const topic = workspaceConfigTopic(resolveWorkspaceKey(params));
      const result = await client.request(
        V4_METHODS.conversationSubscribe,
        {
          topic,
          connectionId: connection.connectionId,
          clientMode: connection.clientMode,
          ...(params.base ? { base: params.base } : {}),
          ...(params.visibility ? { visibility: params.visibility } : {}),
        },
        v4WorkspaceConfigSubscribeResultSchema,
      );
      rememberV4SubscriptionRoute(
        params,
        topic,
        result.ack.subscriptionId,
        connection.connectionId,
      );
      return result;
    },

    async unsubscribeWorkspaceConfigV4(params: ZCodeAgentConversationUnsubscribeParams) {
      await unsubscribeV4Route(params, "workspace-config/");
    },

    async resyncWorkspaceConfigV4(params: ZCodeAgentConversationResyncParams) {
      return resyncV4Route(params, "workspace-config/");
    },

    onDynamicWorkspaceConfigFrame(params: ZCodeAgentWorkspaceTarget) {
      return getWorkspaceConfigFrameEmitter(params).event;
    },

    onDynamicProcessResourceSample() {
      return processResourceSampleEmitter.event;
    },

    onDynamicToolExecResource() {
      return toolExecResourceEmitter.event;
    },
    onDynamicMcpResourceSamples() {
      return mcpResourceSamplesEmitter.event;
    },

    onDynamicMcpTelemetry() {
      return mcpTelemetryEmitter.event;
    },

    // （CLI 重连重订）：进程换代直通 process manager；v4 订阅方（task-index
    // syncer 等）据此重发 subscribe——订阅活在 CLI 进程内存，换代即静默失活。
    onAgentRuntimeRestarted(listener) {
      return processManager.onRuntimeRestarted(listener);
    },

    onAgentRuntimeLifecycle(listener: (event: ZCodeAgentRuntimeLifecycleEvent) => void) {
      return processManager.onRuntimeLifecycle(listener);
    },

    async disposeWorkspace(params): Promise<void> {
      const workspaceKey = resolveWorkspaceKey(params);
      // 释放不仅要终止当前进程，还要让已排队的 provider-ready continuation 失效；
      // 否则它会在 dispose 完成后把同一个 workspace 的 Agent 再次启动。
      cancelWaitingWorkspaceStartup(workspaceKey);
      clearV4SubscriptionRoutes(workspaceKey);
      cuaOperationTurnTracker?.clearWorkspaceKey(workspaceKey);
      const active = activeClientsByWorkspaceKey.get(workspaceKey);
      // Bug 原因：若先等待已有 ACP 启动收口，旧 client 仍可准入新 run，而 teardown 只清理旧快照。
      // 先撤销活动 client 资格，后续请求即被 fence 拒绝，再等待当前 run 全部完成清理。
      if (active) {
        invalidateWorkspaceClient(workspaceKey, active.client);
      } else {
        interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
      }
      await disposeOpenCodeRuns(workspaceKey);
      // 该入口被 restartWorkspaceProcess 用作 runtime invalidation，并非
      // workspace/service 真 teardown。销毁 workspace emitter 会让既有 UI/task-index
      // listener 永久绑在死对象上；emitters 只由 disposeLocalState/disposeAll 释放。
      await processManager.disposeWorkspace(params);
    },

    disposeAll(): void {
      mutable.serviceDisposing = true;
      void disposeOpenCodeRuns().catch((error) =>
        logger.warn(undefined, "OpenCode ACP Host cleanup failed", {
          error: String(error),
        }),
      );
      processManager.disposeAll();
      pluginProcessManager.disposeAll();
      mcpStatusProcessManager.disposeAll();
      // automation 专用的 AutomationRepo / TaskIndexRepo 各持 tasks-index.sqlite
      // 连接句柄，dispose 后必须收口，否则 Windows 上句柄悬着（临时目录清理撞 EBUSY）
      automationRepo.close();
      automationTaskIndexRepo.close();
      disposeLocalState();
    },

    async disposeAllAndWait(): Promise<void> {
      mutable.serviceDisposing = true;
      await disposeOpenCodeRuns();
      await Promise.all([
        processManager.disposeAllAndWait(),
        pluginProcessManager.disposeAllAndWait(),
        mcpStatusProcessManager.disposeAllAndWait(),
      ]);
      automationRepo.close();
      automationTaskIndexRepo.close();
      disposeLocalState();
    },
  };
}
