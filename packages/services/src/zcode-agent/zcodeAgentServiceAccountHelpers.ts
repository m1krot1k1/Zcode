import type { AccountRequestAuthMaterial } from "#src/model-provider/accountRequestAuthService.js";
import type { ZCodeAgentAppRuntimePreferences, ZCodeAgentWorkspaceTarget } from "./zcodeAgent.js";
import type { ZCodeAgentServiceState } from "./zcodeAgentServiceState.js";
import type { ZCodeProtocolClient } from "./zcodeProtocolClient.js";
import {
  ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
  resolveWorkspaceKey,
  type ZCodeProviderRuntimeHeadersRequestParams,
  zcodeProtocolMethods,
  zcodeProviderRefreshRegistryResultSchema,
  zcodeProviderUpdateAccountConfigResultSchema,
  zcodeProviderUpdateRuntimeCatalogParamsSchema,
  zcodeProviderUpdateRuntimeCatalogResultSchema,
  zcodeWorkspaceUpdateInteractionPreferencesResultSchema,
  zcodeWorkspaceUpdateModelIoPreferencesResultSchema,
} from "@zcode/shared";
import {
  buildWorkspaceRef,
  isProtocolMethodNotFoundError,
  logger,
  type PendingProviderRuntimeHeadersRequest,
  type PendingSessionRuntimePreferencesRequest,
} from "./zcodeAgentServiceSupport.js";

export function createAccountHelpers(ctx: ZCodeAgentServiceState) {
  const {
    accountConfigReceivedRevisionByClient,
    accountConfigSyncByClient,
    accountProviderConfigSource,
    accountRequestAuthService,
    activeClientsByWorkspaceKey,
    interactionPreferenceSyncByWorkspaceKey,
    pendingProviderRuntimeHeaders,
    pendingSessionRuntimePreferences,
    runtimeCatalogReceivedRevisionByClient,
    runtimeProviderCatalogSource,
  } = ctx;
  async function resolveAccountRequestAuth(
    request: ZCodeProviderRuntimeHeadersRequestParams,
  ): Promise<AccountRequestAuthMaterial | undefined> {
    if (!request.accountAccess || !accountRequestAuthService) {
      return undefined;
    }
    return accountRequestAuthService.resolveCurrent({
      providerId: request.providerId,
      modelId: request.modelSelection.modelId,
      accountAccess: request.accountAccess,
      expectedAccountScope: request.expectedAccountScope,
      rejectedProjectTokenFingerprint: request.rejectedProjectTokenFingerprint,
      reason: request.reason,
    });
  }

  async function respondAccountRequestAuthWithoutInteraction(params: {
    key: string;
    pending: PendingProviderRuntimeHeadersRequest;
  }): Promise<void> {
    params.pending.responding = true;
    try {
      const requestAuth = await resolveAccountRequestAuth(params.pending.request);
      // 账号解析是异步 IO；取消/进程退出后不能把迟到材料发给已撤销的请求。
      if (pendingProviderRuntimeHeaders.get(params.key) !== params.pending) return;
      if (!requestAuth) {
        throw new Error("Account request auth resolver returned no material");
      }
      await params.pending.client.respond(params.pending.protocolRequestId, {
        headersApplied: true,
        requestAuth,
      });
      logger.info(undefined, "ZCode provider runtime headers 已应用", {
        modelId: params.pending.request.modelSelection.modelId,
        providerId: params.pending.request.providerId,
        requestId: params.pending.request.requestId,
        sessionId: params.pending.request.sessionId,
        workspaceKey: resolveWorkspaceKey(params.pending.request.workspace),
      });
    } catch (error) {
      if (pendingProviderRuntimeHeaders.get(params.key) !== params.pending) return;
      logger.warn(undefined, "ZCode provider runtime headers 应用失败", {
        modelId: params.pending.request.modelSelection.modelId,
        providerId: params.pending.request.providerId,
        requestId: params.pending.request.requestId,
        sessionId: params.pending.request.sessionId,
        error: error instanceof Error ? error.message : String(error),
        workspaceKey: resolveWorkspaceKey(params.pending.request.workspace),
      });
      await params.pending.client.respond(params.pending.protocolRequestId, {
        headersApplied: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (pendingProviderRuntimeHeaders.get(params.key) === params.pending) {
        pendingProviderRuntimeHeaders.delete(params.key);
      }
    }
  }

  function takePendingSessionRuntimePreferences(
    requestId: string,
  ): PendingSessionRuntimePreferencesRequest | undefined {
    const pending = pendingSessionRuntimePreferences.get(requestId);
    if (!pending) {
      return undefined;
    }
    pendingSessionRuntimePreferences.delete(requestId);
    clearTimeout(pending.timeout);
    return pending;
  }

  function expireSessionRuntimePreferencesRequest(requestId: string): void {
    const pending = takePendingSessionRuntimePreferences(requestId);
    if (!pending) {
      return;
    }
    // 远端 Host transport 仍存活但设置 responder 不返回时，旧 pending
    // 没有终止条件，会阻塞 Session 生命周期。超时只结束本次请求，不重试或降级。
    logger.warn(undefined, "运行时偏好请求等待 Host 响应超时", {
      event: "zcode_agent.runtime_preferences.host_response_timeout",
      module: "services.zcode_agent",
      requestId,
      scope: pending.request.scope,
      sessionId: pending.request.sessionId,
      timeoutMs: ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
      workspaceKey: pending.workspaceKey,
    });
    void pending.client
      .respondError(pending.protocolRequestId, {
        code: -32022,
        message: "Session runtime preferences request timed out",
        data: {
          timeoutMs: ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
        },
      })
      .catch((error: unknown) => {
        logger.debug(undefined, "运行时偏好超时响应发送失败", {
          error: error instanceof Error ? error.message : String(error),
          requestId,
          scope: pending.request.scope,
          sessionId: pending.request.sessionId,
        });
      });
  }

  async function syncAccountProviderConfigToClient(params: {
    client: ZCodeProtocolClient;
    reason: string;
    refreshRegistry?: boolean;
  }): Promise<void> {
    if (!accountProviderConfigSource) return;
    const previous = accountConfigSyncByClient.get(params.client) ?? Promise.resolve();
    const current = previous
      .catch(() => {
        // 前一次失败不能阻断后续较新的 Account Config；当前调用会重新尝试。
      })
      .then(async () => {
        // 排队前异步读取可能晚返回，把旧结果排在新结果之后。读取与交付
        // 共用现有 Client 串行队列；不新增发送屏障，也不按内容 revision 猜测时间先后。
        const snapshot = await accountProviderConfigSource.read();
        if (accountConfigReceivedRevisionByClient.get(params.client) !== snapshot.revision) {
          const result = await params.client.request(
            zcodeProtocolMethods.providerUpdateAccountConfig,
            {
              revision: snapshot.revision,
              basedOnZCodeBuiltinRevision: snapshot.basedOnZCodeBuiltinRevision,
              // Account 是运行时事实信封，不是磁盘 Provider 规则集合；保持原有协议字典。
              providers: Object.fromEntries(
                [...snapshot.providers.entries()].map(([providerId, config]) => [
                  providerId,
                  config.toJSON(),
                ]),
              ),
              states: snapshot.states ?? {},
            },
            zcodeProviderUpdateAccountConfigResultSchema,
          );
          if (result.receivedRevision !== snapshot.revision) {
            throw new Error("Account Config 接收回执版本与交付版本不一致");
          }
          accountConfigReceivedRevisionByClient.set(params.client, result.receivedRevision);
          logger.info(undefined, "account provider config 已交付到 ZCode agent", {
            providerCount: result.providerCount,
            reason: params.reason,
            receivedRevision: result.receivedRevision,
            status: result.status,
          });
        }
        if (params.refreshRegistry) {
          await params.client.request(
            zcodeProtocolMethods.providerRefreshRegistry,
            { reason: params.reason },
            zcodeProviderRefreshRegistryResultSchema,
          );
        }
      });
    accountConfigSyncByClient.set(params.client, current);
    try {
      await current;
    } finally {
      if (accountConfigSyncByClient.get(params.client) === current) {
        accountConfigSyncByClient.delete(params.client);
      }
    }
  }

  async function ensureAccountProviderConfigSynced(params: {
    client: ZCodeProtocolClient;
    reason: string;
    workspace: ZCodeAgentWorkspaceTarget;
    refreshRegistry?: boolean;
  }): Promise<void> {
    await syncAccountProviderConfigToClient({
      client: params.client,
      reason: params.reason,
      refreshRegistry: params.refreshRegistry,
    });
    await syncRuntimeProviderCatalogToClient({
      client: params.client,
      reason: params.reason,
    });
  }

  async function syncRuntimeProviderCatalogToClient(params: {
    client: ZCodeProtocolClient;
    reason: string;
  }): Promise<void> {
    if (!runtimeProviderCatalogSource) return;
    const previous = accountConfigSyncByClient.get(params.client) ?? Promise.resolve();
    const current = previous
      .catch(() => {
        // Последующий полный snapshot восстанавливает после любой неудачной доставки.
      })
      .then(async () => {
        // Читаем snapshot уже внутри очереди: быстрая последовательность toggle/refresh не может
        // поставить старый каталог после более нового.
        const snapshot = await runtimeProviderCatalogSource.read();
        if (runtimeCatalogReceivedRevisionByClient.get(params.client) === snapshot.revision) return;
        const paramsEnvelope = zcodeProviderUpdateRuntimeCatalogParamsSchema.parse({
          revision: snapshot.revision,
          ...(snapshot.cliExecutablePath ? { cliExecutablePath: snapshot.cliExecutablePath } : {}),
          providers: snapshot.providers.map((provider) => ({
            providerId: provider.providerId,
            providerName: provider.providerName,
            ...(provider.templateId ? { templateId: provider.templateId } : {}),
            config: provider.config.toJSON(),
            models: provider.models.map(({ modelId, config }) => ({
              modelId,
              config: config.toJSON(),
            })),
          })),
        });
        const result = await params.client.request(
          zcodeProtocolMethods.providerUpdateRuntimeCatalog,
          paramsEnvelope,
          zcodeProviderUpdateRuntimeCatalogResultSchema,
        );
        if (result.receivedRevision !== snapshot.revision) {
          throw new Error("Runtime Provider Catalog ACK revision не совпадает с доставленным");
        }
        runtimeCatalogReceivedRevisionByClient.set(params.client, result.receivedRevision);
        logger.info(undefined, "OpenCode runtime provider catalog применён в ZCode agent", {
          providerCount: result.providerCount,
          reason: params.reason,
          receivedRevision: result.receivedRevision,
          status: result.status,
        });
      });
    accountConfigSyncByClient.set(params.client, current);
    try {
      await current;
    } finally {
      if (accountConfigSyncByClient.get(params.client) === current) {
        accountConfigSyncByClient.delete(params.client);
      }
    }
  }

  async function handleRuntimeProviderCatalogChanged(reason: string): Promise<void> {
    await Promise.all(
      Array.from(activeClientsByWorkspaceKey.values()).map(async (active) => {
        await syncRuntimeProviderCatalogToClient({
          client: active.client,
          reason,
        });
      }),
    );
  }

  async function handleAccountProviderConfigChanged(reason: string): Promise<void> {
    await Promise.all(
      Array.from(activeClientsByWorkspaceKey.values()).map(async (active) => {
        await syncAccountProviderConfigToClient({
          client: active.client,
          reason,
        });
      }),
    );
  }

  function enqueueInteractionPreferenceSync(params: {
    client: ZCodeProtocolClient;
    preferences: ZCodeAgentAppRuntimePreferences;
    workspace: ZCodeAgentWorkspaceTarget;
  }): Promise<void> {
    const workspaceKey = resolveWorkspaceKey(params.workspace);
    const previous = interactionPreferenceSyncByWorkspaceKey.get(workspaceKey) ?? Promise.resolve();
    const current = previous
      .catch(() => {
        // 前一次失败不能打乱之后开关提交的顺序；当前快照仍需继续尝试。
      })
      .then(async () => {
        await params.client.request(
          zcodeProtocolMethods.workspaceUpdateInteractionPreferences,
          {
            workspace: buildWorkspaceRef(params.workspace),
            preferences: {
              askUserQuestionAutoResolutionEnabled:
                params.preferences.askUserQuestionAutoResolutionEnabled,
            },
          },
          zcodeWorkspaceUpdateInteractionPreferencesResultSchema,
        );
        try {
          await params.client.request(
            zcodeProtocolMethods.workspaceUpdateModelIoPreferences,
            {
              workspace: buildWorkspaceRef(params.workspace),
              preferences: {
                fullRetentionEnabled: params.preferences.modelIoFullRetentionEnabled === true,
              },
            },
            zcodeWorkspaceUpdateModelIoPreferencesResultSchema,
          );
        } catch (error) {
          // 新 Host 兼容尚未升级的 CLI：只有 method-not-found 可降级，其他同步失败仍需上抛。
          if (!isProtocolMethodNotFoundError(error)) throw error;
        }
      });
    interactionPreferenceSyncByWorkspaceKey.set(workspaceKey, current);
    void current.then(
      () => {
        if (interactionPreferenceSyncByWorkspaceKey.get(workspaceKey) === current) {
          interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
        }
      },
      () => {
        if (interactionPreferenceSyncByWorkspaceKey.get(workspaceKey) === current) {
          interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
        }
      },
    );
    return current;
  }

  return {
    resolveAccountRequestAuth,
    respondAccountRequestAuthWithoutInteraction,
    takePendingSessionRuntimePreferences,
    expireSessionRuntimePreferencesRequest,
    syncAccountProviderConfigToClient,
    ensureAccountProviderConfigSynced,
    syncRuntimeProviderCatalogToClient,
    handleRuntimeProviderCatalogChanged,
    handleAccountProviderConfigChanged,
    enqueueInteractionPreferenceSync,
  };
}

export type ZCodeAgentServiceAccountHelpers = ReturnType<typeof createAccountHelpers>;
