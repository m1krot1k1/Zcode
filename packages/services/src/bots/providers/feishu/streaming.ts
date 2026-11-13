import type { BotConfig, BotOutboundMessage } from "@zcode/shared";
import { readFeishuAppSecret } from "./auth.js";
import { buildFeishuInteractiveCardPayload } from "./cards.js";
import { getFeishuDomainProvider, isRecord, type FeishuProviderDeps } from "./common.js";
import { buildFeishuElicitationCardPayload } from "./elicitation.js";

export interface FeishuWebSocketClient {
  close(): void;
  /** SDK 自动重连耗尽后的终态；旧测试替身可不提供。 */
  terminated?: Promise<void>;
}

const FEISHU_APP_ID_PATTERN = /^cli_[0-9a-fA-F]{16}$/;
const FEISHU_WEBSOCKET_START_TIMEOUT_MS = 20_000;
const FEISHU_WEBSOCKET_READY_POLL_MS = 100;
const WEBSOCKET_OPEN_READY_STATE = 1;

export function createFeishuWebSocketEventHandlers(params: {
  bot: BotConfig;
  onPayload: (payload: unknown) => Promise<BotOutboundMessage | undefined>;
}) {
  const { bot, onPayload } = params;
  return {
    "im.message.receive_v1": async (payload: unknown) => {
      await onPayload({
        ...(isRecord(payload) ? payload : { payload }),
        botId: bot.id,
        zcodeProvider: bot.provider,
      });
    },
    "im.chat.member.bot.deleted_v1": async (payload: unknown) => {
      await onPayload({
        ...(isRecord(payload) ? payload : {}),
        botId: bot.id,
        zcodeProvider: bot.provider,
        zcodeBotRemoved: true,
      });
    },
    // Bugfix: 我们用 Typing reaction 模拟输入中状态，飞书会把自己创建的 reaction 再推回长连接。
    // 业务不需要处理这个事件，但不注册 handler 时 SDK 会持续打印 warn 干扰排查。
    "im.message.reaction.created_v1": async () => undefined,
    "card.action.trigger": async (payload: unknown) => {
      const responseState = { deferred: false };
      const callbackPayload = {
        ...(isRecord(payload) ? payload : { payload }),
        zcodeFeishuCardResponseState: responseState,
        botId: bot.id,
        zcodeProvider: bot.provider,
        zcodeFeishuSynchronousCardAction: true,
      };
      // 修复原因：飞书点击后的同步响应才是客户端可靠采用的卡片状态。传输层不能再从
      // zcodeCardText 拼简化卡，也不能返回 undefined 后依赖旁路 PATCH；它必须消费业务层
      // 已推进完成的完整 outbound，并用同一份 elicitation 状态生成下一题卡片。
      // 飞书要求三秒内响应。超时只切换卡片投递方式，业务请求仍执行一次。
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const pending = onPayload(callbackPayload);
      const message = await Promise.race([
        pending,
        new Promise<null>((resolve) => {
          deadline = setTimeout(() => {
            responseState.deferred = true;
            resolve(null);
          }, 2000);
        }),
      ]).finally(() => {
        if (deadline) clearTimeout(deadline);
      });
      if (responseState.deferred) return {};
      if (!message) {
        return undefined;
      }
      if (message.callbackToastOnly) return { toast: { type: "error", content: message.text } };
      return {
        card: {
          type: "raw",
          data: message.elicitation
            ? buildFeishuElicitationCardPayload(message)
            : buildFeishuInteractiveCardPayload(message),
        },
      };
    },
  };
}

export async function startFeishuBotWebSocket(params: {
  bot: BotConfig;
  deps: FeishuProviderDeps;
  onPayload: (payload: unknown) => Promise<BotOutboundMessage | undefined>;
  signal?: AbortSignal;
  onConnectionStateChange?: (state: "reconnecting" | "connected") => void;
}): Promise<FeishuWebSocketClient> {
  const { bot, deps, onPayload, signal, onConnectionStateChange } = params;
  const appId = bot.feishuAppId;
  if (!appId || !FEISHU_APP_ID_PATTERN.test(appId)) {
    throw new Error("Invalid Feishu App ID.");
  }
  const appSecret = await readFeishuAppSecret(bot, deps);
  if (!appSecret) {
    throw new Error("Feishu App ID and App Secret are required.");
  }
  if (signal?.aborted) {
    throw new Error("Feishu WebSocket startup aborted.");
  }
  // SDK 全量源码会常驻 Host；只有实际启动长连接才加载，卡片和 HTTP 路径不承担这份开销。
  const Lark = await import("@larksuiteoapi/node-sdk");
  // 加载期间 channel 可能已停用，迟到的模块不能重新创建连接。
  if (signal?.aborted) {
    throw new Error("Feishu WebSocket startup aborted.");
  }
  const eventDispatcher = new Lark.EventDispatcher({});
  eventDispatcher.register(createFeishuWebSocketEventHandlers({ bot, onPayload }));
  return new Promise<FeishuWebSocketClient>((resolve, reject) => {
    let startupSettled = false;
    let lifecycleSettled = false;
    let clientClosed = false;
    let connectionUnavailable = false;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    let connectionPoll: ReturnType<typeof setInterval> | undefined;
    let resolveTerminated: (() => void) | undefined;
    let rejectTerminated: ((error: unknown) => void) | undefined;
    const terminated = new Promise<void>((resolveLifecycle, rejectLifecycle) => {
      resolveTerminated = resolveLifecycle;
      rejectTerminated = rejectLifecycle;
    });
    const finishLifecycle = (error?: unknown) => {
      if (lifecycleSettled) return;
      lifecycleSettled = true;
      if (connectionPoll) clearInterval(connectionPoll);
      if (error) {
        rejectTerminated?.(error);
      } else {
        resolveTerminated?.();
      }
    };
    const fail = (error: unknown) => {
      if (startupSettled) return;
      startupSettled = true;
      if (startupTimer) clearTimeout(startupTimer);
      signal?.removeEventListener("abort", handleAbort);
      closeClient();
      reject(error);
    };
    function handleAbort() {
      fail(new Error("Feishu WebSocket startup aborted."));
    }
    function closeClient() {
      if (clientClosed) return;
      clientClosed = true;
      finishLifecycle();
      wsClient.close();
    }
    const wsClient = new Lark.WSClient({
      appId,
      appSecret,
      domain: getFeishuDomainProvider(bot) === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.info,
    });
    // 修复原因：当前飞书 SDK 不支持 onReady 回调，start() 也会在连接完成前返回。
    // 必须观察 SDK 持有的真实 WebSocket，避免连接已经 OPEN 后仍触发 20 秒超时并被主动关闭。
    connectionPoll = setInterval(() => {
      const sdkClient = wsClient as unknown as {
        isConnecting?: boolean;
        wsConfig?: {
          getWSInstance?(): { readyState?: number } | null;
        };
      };
      const connected =
        sdkClient.wsConfig?.getWSInstance?.()?.readyState === WEBSOCKET_OPEN_READY_STATE;
      if (!connected) {
        if (!startupSettled || clientClosed) return;
        if (!connectionUnavailable) {
          connectionUnavailable = true;
          onConnectionStateChange?.("reconnecting");
        }
        if (sdkClient.isConnecting === false) {
          const error = new Error("Feishu WebSocket reconnect exhausted.");
          finishLifecycle(error);
          closeClient();
        }
        return;
      }
      if (startupSettled) {
        if (connectionUnavailable) {
          connectionUnavailable = false;
          onConnectionStateChange?.("connected");
        }
        return;
      }
      startupSettled = true;
      if (startupTimer) clearTimeout(startupTimer);
      signal?.removeEventListener("abort", handleAbort);
      resolve({ close: closeClient, terminated });
    }, FEISHU_WEBSOCKET_READY_POLL_MS);
    startupTimer = setTimeout(() => {
      fail(
        new Error(
          `Feishu WebSocket startup timed out after ${FEISHU_WEBSOCKET_START_TIMEOUT_MS}ms.`,
        ),
      );
    }, FEISHU_WEBSOCKET_START_TIMEOUT_MS);
    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted) {
      handleAbort();
      return;
    }
    // 飞书不需要公网回调地址；这里由本机主动建立长连接接收事件，适配家用网络/NAT 环境。
    void wsClient.start({ eventDispatcher }).catch((error: unknown) => {
      if (!startupSettled) {
        fail(error);
        return;
      }
      finishLifecycle(error);
      closeClient();
    });
  });
}
