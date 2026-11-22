import type {
  IZCodeAgentService,
  ZCodeAgentAddPluginMarketplaceParams,
  ZCodeAgentAutomationIdParams,
  ZCodeAgentCancelPluginOperationParams,
  ZCodeAgentCompactParams,
  ZCodeAgentConfigurePluginParams,
  ZCodeAgentCreateAutomationParams,
  ZCodeAgentDeleteAutomationRunParams,
  ZCodeAgentDescribePluginParams,
  ZCodeAgentGenerateWorkspaceTextParams,
  ZCodeAgentGoalParams,
  ZCodeAgentInstallPluginParams,
  ZCodeAgentPluginViewParams,
  ZCodeAgentRemovePluginMarketplaceParams,
  ZCodeAgentResetPluginConfigParams,
  ZCodeAgentRestoreBuiltinPluginParams,
  ZCodeAgentSendPromptParams,
  ZCodeAgentSessionTarget,
  ZCodeAgentSetAutomationEnabledParams,
  ZCodeAgentSetPluginEnabledParams,
  ZCodeAgentTestModelConnectivityParams,
  ZCodeAgentUninstallPluginParams,
  ZCodeAgentUpdateAutomationParams,
  ZCodeAgentUpdatePluginMarketplaceParams,
  ZCodeAgentUpdatePluginParams,
  ZCodeAgentValidatePluginParams,
  ZCodeAgentWorkspaceTarget,
} from "./zcodeAgent.js";
import type { ZCodeAgentServiceRuntime } from "./zcodeAgentServiceRuntime.js";
import {
  PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS,
  PLUGIN_OPERATION_CANCEL_REQUEST_TIMEOUT_MS,
  SESSION_COMPACT_REQUEST_TIMEOUT_MS,
  buildWorkspaceRef,
  getSessionSendCompatFields,
  logger,
} from "./zcodeAgentServiceSupport.js";
import {
  resolveWorkspaceKey,
  type ZCodeTaskMode,
  zcodePluginsCancelOperationResultSchema,
  zcodePluginsConfigureResultSchema,
  zcodePluginsDescribeResultSchema,
  zcodePluginsInstallResultSchema,
  zcodePluginsMarketplaceMutationResultSchema,
  zcodePluginsOverviewResultSchema,
  zcodePluginsRestoreBuiltinResultSchema,
  zcodePluginsSetEnabledResultSchema,
  zcodePluginsUninstallResultSchema,
  zcodePluginsValidateResultSchema,
  zcodeProtocolMethods,
  zcodeProviderTestModelConnectivityResultSchema,
  zcodeSessionCloseResultSchema,
  zcodeSessionCompactResultSchema,
  zcodeSessionGoalResultSchema,
  zcodeSessionSendResultSchema,
  zcodeWorkspaceCancelGenerateTextResultSchema,
  zcodeWorkspaceGenerateTextResultSchema,
} from "@zcode/shared";
import { buildSessionCompactParams, buildSessionSendParams } from "./zcodeAgentServiceParams.js";
import { collectBrowserAmbientContext } from "./zcodeAgentBrowserAmbientContext.js";
import { randomUUID } from "node:crypto";

export function createPluginMethods(
  ctx: ZCodeAgentServiceRuntime,
): Pick<
  IZCodeAgentService,
  | "getPluginsOverview"
  | "addPluginMarketplace"
  | "removePluginMarketplace"
  | "updatePluginMarketplace"
  | "installPlugin"
  | "cancelPluginOperation"
  | "uninstallPlugin"
  | "updatePlugin"
  | "restoreBuiltinPlugin"
  | "configurePlugin"
  | "resetPluginConfig"
  | "validatePlugin"
  | "describePlugin"
  | "setPluginEnabled"
  | "listAutomations"
  | "listAllAutomations"
  | "createAutomation"
  | "updateAutomation"
  | "deleteAutomation"
  | "setAutomationEnabled"
  | "restartAutomation"
  | "runAutomationNow"
  | "listAutomationRuns"
  | "deleteAutomationRun"
  | "generateWorkspaceText"
  | "testModelConnectivity"
  | "sendPrompt"
  | "compactSession"
  | "goalSession"
  | "closeSession"
  | "forgetSession"
> {
  const {
    automationService,
    ensureAccountProviderConfigSynced,
    forgetSession,
    getClient,
    getPluginManagementClient,
    getSessionTraceId,
    options,
  } = ctx;
  return {
    async getPluginsOverview(params: ZCodeAgentPluginViewParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsOverview,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.configScope ? { configScope: params.configScope } : {}),
        },
        zcodePluginsOverviewResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async addPluginMarketplace(params: ZCodeAgentAddPluginMarketplaceParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsMarketplaceAdd,
        {
          workspace: buildWorkspaceRef(params),
          source: params.source,
          ...(params.dryRun !== undefined ? { dryRun: params.dryRun } : {}),
          ...(params.operationId ? { operationId: params.operationId } : {}),
        },
        zcodePluginsMarketplaceMutationResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async removePluginMarketplace(params: ZCodeAgentRemovePluginMarketplaceParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsMarketplaceRemove,
        {
          workspace: buildWorkspaceRef(params),
          marketplace: params.marketplace,
        },
        zcodePluginsMarketplaceMutationResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async updatePluginMarketplace(params: ZCodeAgentUpdatePluginMarketplaceParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsMarketplaceUpdate,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.marketplace ? { marketplace: params.marketplace } : {}),
          ...(params.operationId ? { operationId: params.operationId } : {}),
        },
        zcodePluginsMarketplaceMutationResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async installPlugin(params: ZCodeAgentInstallPluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsInstall,
        {
          workspace: buildWorkspaceRef(params),
          pluginName: params.pluginName,
          marketplace: params.marketplace,
          ...(params.scope ? { scope: params.scope } : {}),
          ...(params.dryRun !== undefined ? { dryRun: params.dryRun } : {}),
          ...(params.operationId ? { operationId: params.operationId } : {}),
        },
        zcodePluginsInstallResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async cancelPluginOperation(params: ZCodeAgentCancelPluginOperationParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsCancelOperation,
        { operationId: params.operationId },
        zcodePluginsCancelOperationResultSchema,
        { timeoutMs: PLUGIN_OPERATION_CANCEL_REQUEST_TIMEOUT_MS },
      );
    },

    async uninstallPlugin(params: ZCodeAgentUninstallPluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsUninstall,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.pluginId ? { pluginId: params.pluginId } : {}),
          ...(params.pluginName ? { pluginName: params.pluginName } : {}),
          ...(params.marketplace ? { marketplace: params.marketplace } : {}),
          ...(params.removeCache !== undefined ? { removeCache: params.removeCache } : {}),
        },
        zcodePluginsUninstallResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async updatePlugin(params: ZCodeAgentUpdatePluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsUpdate,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.pluginId ? { pluginId: params.pluginId } : {}),
          ...(params.marketplace ? { marketplace: params.marketplace } : {}),
        },
        zcodePluginsInstallResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async restoreBuiltinPlugin(params: ZCodeAgentRestoreBuiltinPluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsRestoreBuiltin,
        {
          workspace: buildWorkspaceRef(params),
          pluginId: params.pluginId,
        },
        zcodePluginsRestoreBuiltinResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async configurePlugin(params: ZCodeAgentConfigurePluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsConfigure,
        {
          workspace: buildWorkspaceRef(params),
          pluginId: params.pluginId,
          options: params.options,
          ...(params.clearOptionKeys?.length ? { clearOptionKeys: params.clearOptionKeys } : {}),
          ...(params.scope ? { scope: params.scope } : {}),
          ...(params.dryRun !== undefined ? { dryRun: params.dryRun } : {}),
        },
        zcodePluginsConfigureResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async resetPluginConfig(params: ZCodeAgentResetPluginConfigParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsResetConfig,
        {
          workspace: buildWorkspaceRef(params),
          pluginId: params.pluginId,
          ...(params.scope ? { scope: params.scope } : {}),
        },
        zcodePluginsConfigureResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async validatePlugin(params: ZCodeAgentValidatePluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsValidate,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.pluginName ? { pluginName: params.pluginName } : {}),
          ...(params.marketplace ? { marketplace: params.marketplace } : {}),
          ...(params.source ? { source: params.source } : {}),
        },
        zcodePluginsValidateResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async describePlugin(params: ZCodeAgentDescribePluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsDescribe,
        {
          workspace: buildWorkspaceRef(params),
          marketplace: params.marketplace,
          pluginName: params.pluginName,
        },
        zcodePluginsDescribeResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async setPluginEnabled(params: ZCodeAgentSetPluginEnabledParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsSetEnabled,
        {
          workspace: buildWorkspaceRef(params),
          pluginId: params.pluginId,
          enabled: params.enabled,
          ...(params.operationId ? { operationId: params.operationId } : {}),
          ...(params.scope ? { scope: params.scope } : {}),
        },
        zcodePluginsSetEnabledResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async listAutomations(params: ZCodeAgentWorkspaceTarget) {
      return automationService.list(params);
    },

    async listAllAutomations() {
      return automationService.list();
    },

    async createAutomation(params: ZCodeAgentCreateAutomationParams) {
      return automationService.create({
        projectId: params.projectId,
        title: params.title,
        cronExpr: params.cronExpr,
        relativeDelayMinutes: params.relativeDelayMinutes,
        prompt: params.prompt,
        modelSelection: params.modelSelection,
        mode: params.mode as ZCodeTaskMode | undefined,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        recurring: params.recurring ?? true,
        maxRuns: params.maxRuns,
        endAt: params.endAt,
        scheduleRule: params.scheduleRule,
      });
    },

    async updateAutomation(params: ZCodeAgentUpdateAutomationParams) {
      return automationService.update(
        params.automationId,
        {
          title: params.title,
          cronExpr: params.cronExpr,
          prompt: params.prompt,
          modelSelection: params.modelSelection,
          mode: params.mode === null ? null : (params.mode as ZCodeTaskMode | undefined),
          recurring: params.recurring,
          maxRuns: params.maxRuns,
          endAt: params.endAt,
          scheduleRule: params.scheduleRule,
          scheduleEditedByUser: params.scheduleEditedByUser,
        },
        // 归属校验：写操作必须限定在调用方当前 workspace，禁止跨 workspace 越权。
        {
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        },
      );
    },

    async deleteAutomation(params: ZCodeAgentAutomationIdParams) {
      await automationService.delete(params.automationId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    async setAutomationEnabled(params: ZCodeAgentSetAutomationEnabledParams) {
      return automationService.setEnabled(params.automationId, params.enabled, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    async restartAutomation(params: ZCodeAgentAutomationIdParams) {
      return automationService.restart(params.automationId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    async runAutomationNow(params: ZCodeAgentAutomationIdParams) {
      const dispatch = options?.onAutomationManualRunRequested;
      if (!dispatch) {
        // runNow 会先写 manual run 并占用 single-flight claim；dispatcher
        // 缺失是同步可判定的配置错误，必须在认领前失败，不能依赖 stale 崩溃回收。
        throw new Error("Automation immediate dispatcher is unavailable.");
      }
      const claimed = await automationService.runNow(params.automationId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
      if (!claimed) {
        // single-flight 已拒绝重复运行时，旧的空成功返回会被 UI 误判为
        // 新 run 已入队，导致每次重复点击都展示一次“已触发”。
        return { status: "duplicate" as const };
      }
      await dispatch(claimed);
      return { status: "queued" as const };
    },

    async listAutomationRuns(params: ZCodeAgentAutomationIdParams) {
      return automationService.listRuns(params.automationId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    async deleteAutomationRun(params: ZCodeAgentDeleteAutomationRunParams) {
      return automationService.deleteRun(params.runId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    async generateWorkspaceText(params: ZCodeAgentGenerateWorkspaceTextParams) {
      const client = await getClient(params);
      // Worker 自己读取 ZCode Built-in / Personal Config；Host 只在执行前确保账号状态形成的
      // Account Config Overlay 已同步，避免新进程先按旧套餐状态创建 Model。
      await ensureAccountProviderConfigSynced({
        client,
        reason: "workspace_generate_text",
        workspace: params,
        refreshRegistry: true,
      });
      const operationId = params.signal ? randomUUID() : undefined;
      const cancel = () => {
        if (!operationId) return;
        void client
          .request(
            zcodeProtocolMethods.workspaceCancelGenerateText,
            { operationId },
            zcodeWorkspaceCancelGenerateTextResultSchema,
            { timeoutMs: 5_000 },
          )
          .catch((error: unknown) => {
            // 取消是 best-effort 控制面操作，失败不能覆盖调用方原本的 AbortError；
            // 保留 debug 轨迹用于区分“本地停止等待”和“CLI 已收到取消”。
            logger.debug(undefined, "workspace 模型请求取消通知失败", {
              operationId,
              workspaceKey: resolveWorkspaceKey(params),
              error: error instanceof Error ? error.message : String(error),
            });
          });
      };
      params.signal?.addEventListener("abort", cancel, { once: true });
      try {
        return await client.request(
          zcodeProtocolMethods.workspaceGenerateText,
          {
            workspace: buildWorkspaceRef(params),
            selection: params.selection,
            ...(params.prompt ? { prompt: params.prompt } : {}),
            ...(params.messages ? { messages: params.messages } : {}),
            ...(params.tools ? { tools: params.tools } : {}),
            querySource: params.querySource,
            ...(params.maxOutputTokens ? { maxOutputTokens: params.maxOutputTokens } : {}),
            ...(operationId ? { operationId } : {}),
          },
          zcodeWorkspaceGenerateTextResultSchema,
          // 不传 timeoutMs 时协议 client 默认 3 分钟超时会对 thinking 模型的长请求
          // 先于调用方自身 deadline 触发，并被 onRequestTimeout 误判 stale 杀进程。
          // 调用方显式传入 requestTimeoutMs（自身 deadline + 取消缓冲）时以其为准。
          {
            signal: params.signal,
            ...(params.requestTimeoutMs ? { timeoutMs: params.requestTimeoutMs } : {}),
          },
        );
      } finally {
        params.signal?.removeEventListener("abort", cancel);
      }
    },

    async testModelConnectivity(params: ZCodeAgentTestModelConnectivityParams) {
      const client = await getClient(params);
      await ensureAccountProviderConfigSynced({
        client,
        reason: "provider_test_model_connectivity",
        workspace: params,
        refreshRegistry: true,
      });
      return client.request(
        zcodeProtocolMethods.providerTestModelConnectivity,
        {
          workspace: buildWorkspaceRef(params),
          selection: params.selection,
        },
        zcodeProviderTestModelConnectivityResultSchema,
        { signal: params.signal },
      );
    },

    async sendPrompt(params: ZCodeAgentSendPromptParams) {
      const startedAt = Date.now();
      const client = await getClient(params);
      await ensureAccountProviderConfigSynced({
        client,
        reason: "session_send",
        workspace: params,
        refreshRegistry: true,
      });
      const sessionTraceId = params.sessionTraceId?.trim() || getSessionTraceId(params);
      const logTraceId = sessionTraceId ?? params.inputId;
      const browserAmbientContext =
        params.browserAmbientContext ??
        (await collectBrowserAmbientContext(options?.browserControlExecutor, {
          sessionId: params.sessionId,
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
          ...(params.clientMode ? { clientMode: params.clientMode } : {}),
        }));
      const protocolParams: ZCodeAgentSendPromptParams = {
        ...params,
        ...(browserAmbientContext ? { browserAmbientContext } : {}),
      };
      logger.info(logTraceId, "ZCode Agent session/send 开始", {
        attachmentCount: params.attachments?.length ?? 0,
        hasBrowserAmbientContext: browserAmbientContext !== undefined,
        inputId: params.inputId,
        queryId: params.queryId ?? null,
        sessionId: params.sessionId,
        sessionTraceId: sessionTraceId ?? null,
        textLength: params.content.length,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        const result = await client.request(
          zcodeProtocolMethods.sessionSend,
          buildSessionSendParams(protocolParams),
          zcodeSessionSendResultSchema,
        );
        logger.info(logTraceId, "ZCode Agent session/send ACK", {
          durationMs: Date.now() - startedAt,
          inputId: params.inputId,
          queryId: params.queryId ?? null,
          sessionId: params.sessionId,
          sessionTraceId: sessionTraceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return result;
      } catch (error) {
        const compatFields = getSessionSendCompatFields(error);
        if (compatFields.length > 0) {
          logger.warn(logTraceId, "ZCode Agent session/send 命中新旧协议兼容重试", {
            compatFields,
            durationMs: Date.now() - startedAt,
            sessionId: params.sessionId,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          const result = await client.request(
            zcodeProtocolMethods.sessionSend,
            buildSessionSendParams(protocolParams, new Set(compatFields)),
            zcodeSessionSendResultSchema,
          );
          return result;
        }
        logger.warn(logTraceId, "ZCode Agent session/send 失败", {
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          inputId: params.inputId,
          queryId: params.queryId ?? null,
          sessionId: params.sessionId,
          sessionTraceId: sessionTraceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    async compactSession(params: ZCodeAgentCompactParams) {
      const startedAt = Date.now();
      const client = await getClient(params);
      const sessionTraceId = getSessionTraceId(params);
      logger.info(sessionTraceId ?? params.inputId, "ZCode Protocol session/compact 开始", {
        inputId: params.inputId,
        sessionId: params.sessionId,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        const result = await client.request(
          zcodeProtocolMethods.sessionCompact,
          buildSessionCompactParams(params),
          zcodeSessionCompactResultSchema,
          {
            // compact 的模型维护态可能进入分钟级窗口；这里放宽的是 ACK 边界，
            // 终态仍由 session timeline / snapshot 推送，不能把它当作同步 compact 结果。
            timeoutMs: SESSION_COMPACT_REQUEST_TIMEOUT_MS,
          },
        );
        logger.info(sessionTraceId ?? params.inputId, "ZCode Protocol session/compact ACK", {
          durationMs: Date.now() - startedAt,
          inputId: params.inputId,
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return result;
      } catch (error) {
        logger.warn(sessionTraceId ?? params.inputId, "ZCode Protocol session/compact 失败", {
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          inputId: params.inputId,
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    async goalSession(params: ZCodeAgentGoalParams) {
      const startedAt = Date.now();
      const client = await getClient(params);
      logger.info(params.inputId, "开始请求 ZCode Protocol session/goal", {
        action: params.action,
        hasObjective: Boolean(params.objective?.trim()),
        sessionId: params.sessionId,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        const result = await client.request(
          zcodeProtocolMethods.sessionGoal,
          {
            sessionId: params.sessionId,
            inputId: params.inputId,
            action: params.action,
            objective: params.objective,
            expectedRevision: params.expectedRevision,
          },
          zcodeSessionGoalResultSchema,
        );
        logger.info(params.inputId, "ZCode Protocol session/goal 完成", {
          action: params.action,
          durationMs: Date.now() - startedAt,
          messageCount: result.snapshot.messages.length,
          responseLength: result.response?.length ?? 0,
          sessionId: params.sessionId,
          startedTurn: result.startedTurn,
          status: result.snapshot.session.status,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return result;
      } catch (error) {
        logger.warn(params.inputId, "ZCode Protocol session/goal 失败", {
          action: params.action,
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    async closeSession(
      params: ZCodeAgentSessionTarget & {
        expectedPersistence?: "deferred" | "immediate";
      },
    ): Promise<boolean> {
      const client = await getClient(params);
      const result = await client.request(
        zcodeProtocolMethods.sessionClose,
        {
          sessionId: params.sessionId,
          ...(params.expectedPersistence
            ? { expectedPersistence: params.expectedPersistence }
            : {}),
        },
        zcodeSessionCloseResultSchema,
      );
      // 兼容尚未返回 closed 字段、但已成功执行普通 close 的 Agent。
      const closed = result.closed ?? true;
      // 会话关闭是不可恢复的生命周期终点：Host 的 seq/trace/订阅镜像必须同步释放。
      // 仍在展示的订阅者由 emitter 的 last-listener 回调负责最终回收，不在这里强拆。
      if (closed) forgetSession(params);
      return closed;
    },

    forgetSession(params) {
      forgetSession(params);
    },
  };
}
