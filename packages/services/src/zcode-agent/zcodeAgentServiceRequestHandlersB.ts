import type {
  ZCodeAgentSessionRuntimePreferencesRequest,
  ZCodeAgentWorkspaceTarget,
} from "./zcodeAgent.js";
import type { ZCodeAgentServiceAccountHelpers } from "./zcodeAgentServiceAccountHelpers.js";
import type { ZCodeAgentServiceSessionHelpers } from "./zcodeAgentServiceSessionHelpers.js";
import type { ZCodeAgentServiceState } from "./zcodeAgentServiceState.js";
import type { ZCodeProtocolClient } from "./zcodeProtocolClient.js";
import {
  ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
  isRemoteWorkspaceIdentity,
  requestVerificationInteractionAvailable,
  requiresRequestVerification,
  resolveWorkspaceKey,
  summarizeOfficialMcpIdentityHeaders,
  type ZCodeProtocolRequest,
  type ZCodeSessionRuntimePreferencesResult,
  zcodeOfficialMcpAuthHeadersRequestParamsSchema,
  zcodePermissionRequestParamsSchema,
  zcodeProviderRuntimeHeadersRequestParamsSchema,
  zcodeSessionRequestRuntimePreferencesParamsSchema,
  zcodeSessionRuntimePreferencesResultSchema,
  zcodeUserInputRequestParamsSchema,
} from "@zcode/shared";
import {
  permissionRequestKey,
  providerRuntimeHeadersRequestKey,
  userInputRequestKey,
} from "./zcodeAgentServiceParams.js";
import { logger } from "./zcodeAgentServiceSupport.js";
import { randomUUID } from "node:crypto";

export function createRequestHandlersB(
  ctx: ZCodeAgentServiceState & ZCodeAgentServiceSessionHelpers & ZCodeAgentServiceAccountHelpers,
) {
  const {
    accountRequestAuthService,
    emitSessionEvent,
    expireSessionRuntimePreferencesRequest,
    officialMcpIssuanceAudit,
    options,
    pendingPermissions,
    pendingProviderRuntimeHeaders,
    pendingSessionRuntimePreferences,
    pendingUserInputs,
    providerRuntimeHeadersWorkspaceEmitters,
    resolveSessionRuntimePreferences,
    respondAccountRequestAuthWithoutInteraction,
    sessionRuntimePreferencesAuthority,
    sessionRuntimePreferencesRequestEmitter,
  } = ctx;

  function handleSessionRequestRuntimePreferencesRequest(
    client: ZCodeProtocolClient,
    workspace: ZCodeAgentWorkspaceTarget,
    request: ZCodeProtocolRequest,
  ): void {
    const reportResponseFailure = (error: unknown): void => {
      logger.debug(undefined, "运行时偏好响应发送失败", {
        error: error instanceof Error ? error.message : String(error),
        workspaceKey: resolveWorkspaceKey(workspace),
      });
    };
    const parsed = zcodeSessionRequestRuntimePreferencesParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      void client
        .respondError(request.id, {
          code: -32602,
          message: "Invalid session runtime preferences request params",
          data: parsed.error.flatten(),
        })
        .catch(reportResponseFailure);
      return;
    }
    if (sessionRuntimePreferencesAuthority === "local") {
      void (async () => {
        let preferences: ZCodeSessionRuntimePreferencesResult;
        try {
          preferences = zcodeSessionRuntimePreferencesResultSchema.parse(
            // 同一 RPC 承载 runtime 创建与首次执行两个时机；必须继续传递
            // 已校验的 scope，避免首次执行为了 Shell 再次等待远端 client config。
            (await resolveSessionRuntimePreferences?.(parsed.data.scope)) ?? {
              askUserQuestionAutoResolutionEnabled: true,
              nativeSearchEnhancementsEnabled: true,
              memoryEnabled: false,
            },
          );
          if (
            parsed.data.scope === "runtime-materialization" &&
            options?.resolveSessionDirectories
          ) {
            preferences.additionalDirectories = await options.resolveSessionDirectories({
              ...workspace,
              sessionId: parsed.data.sessionId,
            });
          }
          preferences.subagentRuntimeConfigEnabled =
            Boolean(options?.readSubagentRuntimeConfig) &&
            !(
              workspace.workspaceIdentity && isRemoteWorkspaceIdentity(workspace.workspaceIdentity)
            );
        } catch (error) {
          await client.respondError(request.id, {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        // 响应发送失败表示 transport 已关闭，不能再把它当成设置读取失败
        // 并尝试发送第二个 error response。
        await client.respond(request.id, preferences);
      })().catch(reportResponseFailure);
      return;
    }

    const requestId = randomUUID();
    const dynamicRequest: ZCodeAgentSessionRuntimePreferencesRequest = {
      ...parsed.data,
      requestId,
    };
    pendingSessionRuntimePreferences.set(requestId, {
      client,
      protocolRequestId: request.id,
      request: dynamicRequest,
      workspace,
      timeout: setTimeout(
        () => expireSessionRuntimePreferencesRequest(requestId),
        ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
      ),
      workspaceKey: resolveWorkspaceKey(workspace),
    });
    logger.info(undefined, "运行时偏好请求已转发给 Host", {
      event: "zcode_agent.runtime_preferences.host_request_dispatched",
      module: "services.zcode_agent",
      requestId,
      scope: dynamicRequest.scope,
      sessionId: dynamicRequest.sessionId,
      workspaceKey: resolveWorkspaceKey(workspace),
    });
    sessionRuntimePreferencesRequestEmitter.fire(dynamicRequest);
    return;
  }

  function handleInteractionRequestPermissionRequest(
    client: ZCodeProtocolClient,
    workspace: ZCodeAgentWorkspaceTarget,
    request: ZCodeProtocolRequest,
  ): void {
    const parsed = zcodePermissionRequestParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      void client.respondError(request.id, {
        code: -32602,
        message: "Invalid permission request params",
        data: parsed.error.flatten(),
      });
      return;
    }
    const key = permissionRequestKey({
      ...workspace,
      sessionId: parsed.data.sessionId,
      requestId: parsed.data.requestId,
    });
    const wasPending = pendingPermissions.has(key);
    pendingPermissions.set(key, {
      client,
      protocolRequestId: request.id,
    });
    if (!wasPending) {
      emitSessionEvent(workspace, parsed.data.sessionId, {
        type: "permission.request",
        request: parsed.data,
      });
    }
    return;
  }

  function handleInteractionRequestUserInputRequest(
    client: ZCodeProtocolClient,
    workspace: ZCodeAgentWorkspaceTarget,
    request: ZCodeProtocolRequest,
  ): void {
    const parsed = zcodeUserInputRequestParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      void client.respondError(request.id, {
        code: -32602,
        message: "Invalid user input request params",
        data: parsed.error.flatten(),
      });
      return;
    }
    const key = userInputRequestKey({
      ...workspace,
      sessionId: parsed.data.sessionId,
      requestId: parsed.data.requestId,
    });
    const wasPending = pendingUserInputs.has(key);
    pendingUserInputs.set(key, { client, protocolRequestId: request.id });
    if (!wasPending) {
      // agent 为恢复丢失的 protocol id 会重发同一业务 requestId。
      // host 需要刷新可响应的 protocolRequestId，但不能重复广播给 UI，
      // 否则多问题 AskUserQuestion 会在用户翻到后续问题时被重置回第一页。
      emitSessionEvent(workspace, parsed.data.sessionId, {
        type: "userInput.request",
        request: parsed.data,
      });
    }
    return;
  }

  function handleInteractionRequestProviderRuntimeHeadersRequest(
    client: ZCodeProtocolClient,
    workspace: ZCodeAgentWorkspaceTarget,
    request: ZCodeProtocolRequest,
  ): void {
    const parsed = zcodeProviderRuntimeHeadersRequestParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      void client.respondError(request.id, {
        code: -32602,
        message: "Invalid provider runtime headers request params",
        data: parsed.error.flatten(),
      });
      return;
    }
    const pendingKey = providerRuntimeHeadersRequestKey({
      ...workspace,
      sessionId: parsed.data.sessionId,
      requestId: parsed.data.requestId,
    });
    const pending = {
      client,
      protocolRequestId: request.id,
      request: parsed.data,
    };
    pendingProviderRuntimeHeaders.set(pendingKey, pending);
    logger.info(request.trace?.traceId, "收到 ZCode provider runtime headers 请求", {
      modelId: parsed.data.modelSelection.modelId,
      providerId: parsed.data.providerId,
      requestId: parsed.data.requestId,
      sessionId: parsed.data.sessionId,
      turnId: parsed.data.turnId ?? null,
      workspaceKey: resolveWorkspaceKey(workspace),
      workspacePath: workspace.workspacePath,
    });
    const accountAccess = parsed.data.accountAccess;
    if (accountRequestAuthService && accountAccess && !requiresRequestVerification(accountAccess)) {
      // Account API Key / Team Runtime Key 不需要 Renderer 交互。Host 按 Model
      // 固定的 Account Access 自动应答，避免后台任务和无 pane 会话依赖 UI 订阅者。
      void respondAccountRequestAuthWithoutInteraction({
        key: pendingKey,
        pending,
      });
      return;
    }
    if (!requestVerificationInteractionAvailable) {
      pendingProviderRuntimeHeaders.delete(pendingKey);
      void pending.client.respond(pending.protocolRequestId, {
        headersApplied: false,
        errorMessage: "Provider request auth is unavailable",
      });
      return;
    }
    emitSessionEvent(workspace, parsed.data.sessionId, {
      type: "providerRuntimeHeaders.request",
      request: parsed.data,
    });
    // workspace 级镜像投递：桌面窗口常驻应答方（每个打开的 workspace tab 一个）
    // 不感知 sessionId，必须在这里按 workspaceKey 收到同一请求。
    providerRuntimeHeadersWorkspaceEmitters.get(resolveWorkspaceKey(workspace))?.fire(parsed.data);
    return;
  }

  // 官方 Server MCP 身份头：纯 RPC 中继，host 自动解析并响应。
  // 不 emitSessionEvent、不进 pending map——该请求没有 UI 语义，renderer 不参与。
  function handleInteractionRequestOfficialMcpAuthHeadersRequest(
    client: ZCodeProtocolClient,
    workspace: ZCodeAgentWorkspaceTarget,
    request: ZCodeProtocolRequest,
  ): void {
    const parsed = zcodeOfficialMcpAuthHeadersRequestParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      void client.respondError(request.id, {
        code: -32602,
        message: "Invalid interaction/requestOfficialMcpAuthHeaders params",
        data: parsed.error.flatten(),
      });
      return;
    }
    // host 侧二次校验必须发生在**读取凭据之前**：未命中即返回，resolveHeaders 不被调用，
    // 因此不会有任何凭据被读入内存。
    void (async () => {
      const trustedOrigins = options?.officialMcpTrustedOrigins;
      const trust = trustedOrigins
        ? await trustedOrigins
            .isTrusted({
              mcpKey: parsed.data.mcpKey,
              origin: parsed.data.targetOrigin,
              pluginId: parsed.data.pluginId,
            })
            // 判定自身异常也按不可信处理，绝不因为校验失败就放行。
            .catch(() => ({ detail: "validator_error", trusted: false }))
        : { detail: "validator_missing", trusted: false };
      if (!trust.trusted) {
        // 只记录非敏感的请求上下文；凭据未被读取，自然也无从泄露。
        logger.warn(request.trace?.traceId, "官方 MCP 身份头请求未通过 host 侧可信校验", {
          detail: trust.detail ?? "unknown",
          mcpKey: parsed.data.mcpKey,
          pluginId: parsed.data.pluginId,
          requestId: parsed.data.requestId,
          targetOrigin: parsed.data.targetOrigin,
          workspaceKey: parsed.data.workspace.workspaceKey,
        });
        void client.respond(request.id, {
          ok: false,
          reason: "official_mcp_origin_untrusted",
        });
        return;
      }
      const resolver = options?.officialMcpAuthHeadersResolver;
      if (!resolver) {
        void client.respond(request.id, {
          ok: false,
          reason: "official_auth_unavailable",
        });
        return;
      }
      try {
        const resolveStartedAt = Date.now();
        const result = await resolver.resolveHeaders({
          mcpKey: parsed.data.mcpKey,
          pluginId: parsed.data.pluginId,
          targetOrigin: parsed.data.targetOrigin,
          workspace: parsed.data.workspace,
        });
        // host 侧不能只在失败时留日志，成功路径完全静默会无法回答"到底发了哪几个头"。
        // 只记 header 名与套餐维度：凭证值绝不入日志（日志留存周期不受控）。
        if (result.ok) {
          const firstIssuance = officialMcpIssuanceAudit.markFirst(
            parsed.data.pluginId,
            parsed.data.mcpKey,
            parsed.data.workspace.workspaceKey,
          );
          const logIssuance = firstIssuance ? logger.info : logger.debug;
          logIssuance(request.trace?.traceId, "官方 MCP 身份头已解析", {
            firstIssuance,
            ...summarizeOfficialMcpIdentityHeaders(result.headers),
            mcpKey: parsed.data.mcpKey,
            pluginId: parsed.data.pluginId,
            requestId: parsed.data.requestId,
            resolveDurationMs: Date.now() - resolveStartedAt,
            targetOrigin: parsed.data.targetOrigin,
          });
        } else {
          logger.info(request.trace?.traceId, "官方 MCP 身份头不可用", {
            mcpKey: parsed.data.mcpKey,
            pluginId: parsed.data.pluginId,
            reason: result.reason,
            requestId: parsed.data.requestId,
            resolveDurationMs: Date.now() - resolveStartedAt,
            targetOrigin: parsed.data.targetOrigin,
          });
        }
        void client.respond(request.id, result);
      } catch (error: unknown) {
        // 解析异常按不可用返回而非 respondError：adapter 只按可枚举 reason 分流，
        // 且此处绝不能让 MCP 退化成匿名请求。凭证原文不进日志。
        logger.warn(request.trace?.traceId, "官方 MCP 身份头解析失败", {
          error: error instanceof Error ? error.message : String(error),
          mcpKey: parsed.data.mcpKey,
          pluginId: parsed.data.pluginId,
          requestId: parsed.data.requestId,
          targetOrigin: parsed.data.targetOrigin,
        });
        void client.respond(request.id, {
          ok: false,
          reason: "official_auth_unavailable",
        });
      }
    })();
    return;
  }

  return {
    handleSessionRequestRuntimePreferencesRequest,
    handleInteractionRequestPermissionRequest,
    handleInteractionRequestUserInputRequest,
    handleInteractionRequestProviderRuntimeHeadersRequest,
    handleInteractionRequestOfficialMcpAuthHeadersRequest,
  };
}

export type ZCodeAgentServiceRequestHandlersB = ReturnType<typeof createRequestHandlersB>;
