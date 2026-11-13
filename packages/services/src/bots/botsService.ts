import { createBotsServiceState } from "./botsServiceState.js";
import { createBotsServicePrivate } from "./botsServicePrivate.js";
import { createBotsServiceReply } from "./botsServiceReply.js";
import { createBotsServiceConfig } from "./botsServiceConfig.js";
import { createBotsServiceSelection } from "./botsServiceSelection.js";
import { createBotsServiceDelivery } from "./botsServiceDelivery.js";
import { createBotsServiceWorkspace } from "./botsServiceWorkspace.js";
import { createBotsServiceCallback } from "./botsServiceCallback.js";
import { createBotsServiceElicitation } from "./botsServiceElicitation.js";
import { createBotsServiceElicitationFlow } from "./botsServiceElicitationFlow.js";
import { createBotsServiceAuth } from "./botsServiceAuth.js";
import { createBotsServiceStatus } from "./botsServiceStatus.js";
import { createBotsServiceMessage } from "./botsServiceMessage.js";
import { createBotsServiceReconnect } from "./botsServiceReconnect.js";
import { createBotsServiceGroup } from "./botsServiceGroup.js";
import { createBotsServiceGroupInput } from "./botsServiceGroupInput.js";
import { createBotsServiceCommandsWorkspace } from "./botsServiceCommandsWorkspace.js";
import { createBotsServiceCommandsModel } from "./botsServiceCommandsModel.js";
import { createBotsServiceCommandsConfig } from "./botsServiceCommandsConfig.js";
import { createBotsServiceCommandsTask } from "./botsServiceCommandsTask.js";
import { createBotsServiceCommandsInteraction } from "./botsServiceCommandsInteraction.js";
import { createBotsServiceApiBots } from "./botsServiceApiBots.js";
import { createBotsServiceApiTopics } from "./botsServiceApiTopics.js";
import { createBotsServiceApiGroups } from "./botsServiceApiGroups.js";
import { createBotsServiceInbound } from "./botsServiceInbound.js";
import { createBotsServiceTaskStream } from "./botsServiceTaskStream.js";
import type { BotsServiceDeps, BotsServiceInstance } from "./botsServiceTypes.js";
import { createBotsServiceContext } from "./botsServiceContext.js";
import type { BotsServiceContext } from "./botsServicePorts.js";
import { createBotsServiceRuntime } from "./botsServiceRuntime.js";
import { botsLogger } from "./botsServiceSupport.js";

export function createBotsService(deps: BotsServiceDeps): BotsServiceInstance {
  // Bot 服务状态只有 ctx 一个 owner：域模块只通过 ctx 读写，避免多条写入路径。
  const ctx = createBotsServiceContext(deps) as BotsServiceContext;
  Object.assign(ctx, createBotsServiceState(ctx));
  Object.assign(ctx, createBotsServicePrivate(ctx));
  Object.assign(ctx, createBotsServiceReply(ctx));
  Object.assign(ctx, createBotsServiceConfig(ctx));
  Object.assign(ctx, createBotsServiceSelection(ctx));
  Object.assign(ctx, createBotsServiceDelivery(ctx));
  Object.assign(ctx, createBotsServiceWorkspace(ctx));
  Object.assign(ctx, createBotsServiceCallback(ctx));
  Object.assign(ctx, createBotsServiceElicitation(ctx));
  Object.assign(ctx, createBotsServiceElicitationFlow(ctx));
  Object.assign(ctx, createBotsServiceAuth(ctx));
  Object.assign(ctx, createBotsServiceStatus(ctx));
  Object.assign(ctx, createBotsServiceMessage(ctx));
  Object.assign(ctx, createBotsServiceReconnect(ctx));
  Object.assign(ctx, createBotsServiceGroup(ctx));
  Object.assign(ctx, createBotsServiceGroupInput(ctx));
  Object.assign(ctx, createBotsServiceCommandsWorkspace(ctx));
  Object.assign(ctx, createBotsServiceCommandsModel(ctx));
  Object.assign(ctx, createBotsServiceCommandsConfig(ctx));
  Object.assign(ctx, createBotsServiceCommandsTask(ctx));
  Object.assign(ctx, createBotsServiceCommandsInteraction(ctx));
  Object.assign(ctx, createBotsServiceTaskStream(ctx));
  Object.assign(ctx, createBotsServiceRuntime(ctx));
  Object.assign(ctx, createBotsServiceApiBots(ctx));
  Object.assign(ctx, createBotsServiceApiTopics(ctx));
  Object.assign(ctx, createBotsServiceApiGroups(ctx));
  Object.assign(ctx, createBotsServiceInbound(ctx));

  ctx.service = {
    syncAppRuntimePreferences: ctx.syncAppRuntimePreferences,
    getStatus: ctx.getStatus,
    getConfig: ctx.getConfig,
    listWorkspaceRefs: ctx.listWorkspaceRefs,
    getUserConfigOptions: ctx.listUserConfigOptions,
    beginFeishuRegistration: ctx.beginFeishuRegistration,
    pollFeishuRegistration: ctx.pollFeishuRegistration,
    beginWeixinRegistration: ctx.beginWeixinRegistration,
    pollWeixinRegistration: ctx.pollWeixinRegistration,
    saveConfig: ctx.saveConfig,
    listBots: ctx.listBots,
    saveBot: ctx.saveBot,
    removeBotSecret: ctx.removeBotSecret,
    deleteBot: ctx.deleteBot,
    testBot: ctx.testBot,
    createBindCode: ctx.createBindCode,
    getGroupMemberNames: ctx.getGroupMemberNames,
    validateTopicResource: ctx.validateTopicResource,
    readTopicResource: ctx.readTopicResource,
    getTopicDetails: ctx.getTopicDetails,
    retryTopicPreparation: ctx.retryTopicPreparation,
    replyToChannel: ctx.replyToChannel,
    getBotStates: ctx.getBotStates,
    reconcileGroupResult: ctx.reconcileGroupResult,
    resendGroupResult: ctx.resendGroupResult,
    setGroupEnabled: ctx.setGroupEnabled,
    retryPrivateDelivery: ctx.retryPrivateDelivery,
    resetBotState: ctx.resetBotState,
    watchAutomationRun: ctx.watchAutomationRun,
    handleInboundMessage: ctx.handleInboundMessage,
    handleProviderCallback: ctx.handleProviderCallback,
    handleProviderCallbackResponse: ctx.handleProviderCallbackResponse,
    disposeAll() {
      void ctx.service.disposeAllAndWait().catch((error: unknown) => {
        botsLogger.warn(
          undefined,
          `dispose Bot runtimes failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    },
    disposeAllAndWait() {
      if (ctx.shutdownPromise) {
        return ctx.shutdownPromise;
      }
      ctx.memoryDiagnostics.dispose();
      // 材料下载可能晚于 Host 关闭返回；先同步失效，再回收上传侧的取消代次。
      ctx.topicPreparation.clear();
      const pendingTopicKeys = [...ctx.topicContinuations.keys()];
      for (const key of pendingTopicKeys) {
        ctx.topicGenerations.set(key, (ctx.topicGenerations.get(key) ?? 0) + 1);
        ctx.topicContinuations.get(key)?.cancel();
        for (const resolve of ctx.topicReplies.get(key)?.values() ?? []) resolve([]);
        ctx.topicReplies.get(key)?.clear();
      }
      const cancelUploads = (async () => {
        const states = (await ctx.repo.readState()).bots;
        await Promise.all(
          pendingTopicKeys.map(async (key) => {
            const context = states[key];
            if (!context?.activeTaskId) return;
            const taskService = await ctx.resolveZCodeTaskServiceForContext(context);
            await taskService.invalidateBotTopicInputs?.({
              taskId: context.activeTaskId,
              workspacePath: context.workspacePath,
              workspaceIdentity: context.workspaceIdentity,
            });
          }),
        );
      })();
      for (const controller of ctx.streamingCardRequestControllers) {
        controller.abort(new Error("Bot service disposed."));
      }
      ctx.streamingCardRequestControllers.clear();
      for (const subscription of ctx.streamSubscriptions.values()) {
        subscription.dispose();
      }
      ctx.streamSubscriptions.clear();
      ctx.taskStreamHub.dispose();
      if (ctx.privateRecoveryTimer) clearInterval(ctx.privateRecoveryTimer);
      ctx.privateImTraces.clear();
      ctx.privateWatches.clear();
      ctx.failedPrivateDeliveries.clear();
      ctx.transientInteractionCards.clear();
      ctx.adminAttention.clear();
      for (const intervalId of ctx.typingIntervals.values()) {
        clearInterval(intervalId);
      }
      ctx.typingIntervals.clear();
      for (const [taskId] of ctx.typingTargets) {
        ctx.stopTyping(taskId);
      }
      ctx.runningTasks.clear();
      ctx.liveStatusProgressByTaskId.clear();
      ctx.pendingRemoteReconnectsByKey.clear();
      ctx.recentRemoteReconnectAtByKey.clear();
      ctx.recentRemoteReconnectDeliveryAtByKey.clear();
      ctx.recentInboundDeliveryAtByKey.clear();
      ctx.automationDeliveryWarningAtByKey.clear();
      ctx.inboundProcessingQueuesByContext.clear();
      // Bugfix：host 的异步资源回收会优先调用 disposeAllAndWait。保留统一 Promise，确保并发关闭
      // 只执行一次，并在返回前等三类 Provider runtime 的请求、WebSocket 和跨进程锁全部收口。
      ctx.shutdownPromise = Promise.allSettled([
        cancelUploads,
        ctx.telegramRuntime.dispose(),
        ctx.weixinRuntime.dispose(),
        ctx.feishuRuntime.dispose(),
      ]).then(() => undefined);
      return ctx.shutdownPromise;
    },
  };

  if (ctx.runStartupBackgroundTasks) {
    // 远端连接没有 Bot 专属事件源；只检查已存在的连接，不建立额外连接或重放历史。
    ctx.privateRecoveryTimer = setInterval(() => {
      if (ctx.shutdownPromise || ctx.privateRecoveryPending) return;
      ctx.privateRecoveryPending = true;
      void ctx.repo
        .readState()
        .then(async (state) => {
          for (const context of Object.values(state.bots))
            if (!context.group) await ctx.reconcilePrivateSynchronization(context.botId);
        })
        .catch(() => botsLogger.warn(undefined, "Private Bot recovery state unavailable"))
        .finally(() => {
          ctx.privateRecoveryPending = false;
        });
    }, 10_000);
    ctx.privateRecoveryTimer.unref();
    void ctx.telegramRuntime.refresh();
    void ctx.weixinRuntime.refresh();
    void ctx.feishuRuntime.refresh();
    void ctx
      .ensureBotStorageMigrated()
      .then(async () => {
        for (const context of Object.values((await ctx.repo.readState()).bots)) {
          await ctx.restoreGroupSynchronization(context);
          if (!context.group) await ctx.reconcilePrivateSynchronization(context.botId);
        }
      })
      .catch((error: unknown) => {
        // 首次读取失败必须可见，不能产生未处理 rejection；交互入口仍直接收到该错误。
        botsLogger.error(
          undefined,
          `Bot storage initialization failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  return ctx.service;
}
