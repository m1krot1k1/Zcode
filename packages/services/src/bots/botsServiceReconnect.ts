import type {
  BotAuthorizedContext,
  BotRemoteWorkspaceReconnectResult,
} from "./botsServiceTypes.js";
import type { BotsServiceContext } from "./botsServicePorts.js";
import {
  REMOTE_RECONNECT_DEDUPE_TTL_MS,
  REMOTE_RECONNECT_DELIVERY_DEDUPE_TTL_MS,
  botsLogger,
  createOutbound,
} from "./botsServiceSupport.js";
import { getWorkspaceKey } from "./workspaceHelpers.js";
import type {
  BotActor,
  BotContextState,
  BotInboundMessage,
  BotOutboundMessage,
} from "@zcode/shared";

export function createBotsServiceReconnect(ctx: BotsServiceContext) {
  function buildRemoteReconnectCommandKey(
    actor: BotActor,
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
  ): string {
    return [
      actor.botId,
      actor.provider,
      actor.chatId ?? actor.providerUserId,
      getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
    ].join("::");
  }

  function buildRemoteReconnectDeliveryKey(message: BotInboundMessage): string | null {
    const providerMessageId = message.actor.providerMessageId?.trim();
    if (!providerMessageId) {
      return null;
    }
    return [
      message.actor.botId,
      message.actor.provider,
      message.actor.chatId ?? message.actor.providerUserId,
      providerMessageId,
    ].join("::");
  }

  function pruneRecentRemoteReconnectDeliveryDedupe(now: number): void {
    for (const [key, at] of ctx.recentRemoteReconnectDeliveryAtByKey) {
      if (now - at >= REMOTE_RECONNECT_DELIVERY_DEDUPE_TTL_MS) {
        ctx.recentRemoteReconnectDeliveryAtByKey.delete(key);
      }
    }
  }

  async function performRemoteReconnect(
    message: BotInboundMessage,
    auth: BotAuthorizedContext,
  ): Promise<BotOutboundMessage[]> {
    let result: BotRemoteWorkspaceReconnectResult;
    try {
      result = await ctx.reconnectRemoteWorkspaceForBot(auth.context);
    } catch (error) {
      result = {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (!result.ok) {
      return [
        ctx.administratorReply(
          message.actor,
          auth.bot,
          "remote",
          createOutbound(
            message.actor,
            ctx.msg(auth.locale, "remoteReconnectFailed", {
              workspacePath: auth.context.workspacePath,
              message: result.message ?? "unknown",
            }),
          ),
        ),
      ];
    }
    ctx.adminAttention.clear(message.actor, auth.bot.providerUserId, "remote");
    if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
      const draftOptions = await ctx.buildInitializedDraftOptions(auth.context);
      await ctx.writeContext({ ...auth.context, draftOptions });
    }
    await ctx.reconcilePrivateSynchronization(auth.context.botId);
    // 成功重连后统一回完整状态，避免命令完成文案和 /status 内容分裂。
    return ctx.createStatusReply(message.actor, auth.context, auth.locale);
  }

  async function handleReconnect(
    message: BotInboundMessage,
    options: {
      onReconnectStart?: (auth: BotAuthorizedContext) => Promise<void>;
    } = {},
  ): Promise<BotOutboundMessage[]> {
    const auth = await ctx.withAuthorizedContext(message, "workspace");
    if (!auth.ok) return auth.reply;
    if (!auth.context.workspaceIdentity) {
      return [createOutbound(message.actor, ctx.msg(auth.locale, "remoteReconnectLocal"))];
    }
    if (!ctx.deps.remoteWorkspaceService) {
      return [
        createOutbound(
          message.actor,
          ctx.msg(auth.locale, "remoteReconnectUnavailable", {
            workspacePath: auth.context.workspacePath,
          }),
        ),
      ];
    }

    const now = Date.now();
    pruneRecentRemoteReconnectDeliveryDedupe(now);
    const deliveryKey = buildRemoteReconnectDeliveryKey(message);
    if (deliveryKey && ctx.recentRemoteReconnectDeliveryAtByKey.has(deliveryKey)) {
      return [];
    }
    if (deliveryKey) {
      // Bugfix: 飞书/微信/Telegram 都可能重投同一条 provider message。
      // /reconnect 有副作用，必须在真正执行前就按 provider message id 幂等，
      // 否则重投会再次命中“已连接”分支，用户会看到重复的成功提示。
      ctx.recentRemoteReconnectDeliveryAtByKey.set(deliveryKey, now);
    }

    const reconnectKey = buildRemoteReconnectCommandKey(message.actor, auth.context);
    const pendingReconnect = ctx.pendingRemoteReconnectsByKey.get(reconnectKey);
    if (pendingReconnect) {
      await pendingReconnect.catch(() => []);
      return [];
    }
    const recentReconnectAt = ctx.recentRemoteReconnectAtByKey.get(reconnectKey);
    if (
      recentReconnectAt !== undefined &&
      now - recentReconnectAt < REMOTE_RECONNECT_DEDUPE_TTL_MS
    ) {
      return [];
    }
    if (await ctx.isRemoteWorkspaceConnected(auth.context)) {
      return ctx.createStatusReply(message.actor, auth.context, auth.locale);
    }

    // Bugfix: Feishu/Lark/Webhook 这类 provider 可能把同一条 /reconnect 在短时间内重复投递。
    // /reconnect 本身有副作用，必须按 bot+用户+workspace 做幂等，否则会同时出现“已连接”和“正在重连”等互相打架的状态。
    const reconnectPromise = (async () => {
      if (options.onReconnectStart) {
        try {
          await options.onReconnectStart(auth);
        } catch (error) {
          // Bugfix: “正在重连”只是即时状态提示，发送失败不能中断真正的远端重连。
          botsLogger.warn(
            undefined,
            `send reconnect starting failed provider=${message.actor.provider} bot=${message.botId} user=${message.actor.providerUserId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return performRemoteReconnect(message, auth);
    })();
    ctx.pendingRemoteReconnectsByKey.set(reconnectKey, reconnectPromise);
    try {
      const replies = await reconnectPromise;
      ctx.recentRemoteReconnectAtByKey.set(reconnectKey, Date.now());
      return replies;
    } finally {
      ctx.pendingRemoteReconnectsByKey.delete(reconnectKey);
    }
  }

  return {
    buildRemoteReconnectCommandKey,
    buildRemoteReconnectDeliveryKey,
    pruneRecentRemoteReconnectDeliveryDedupe,
    performRemoteReconnect,
    handleReconnect,
  };
}
